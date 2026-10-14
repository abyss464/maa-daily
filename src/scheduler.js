// Runs the due accounts while the computer is idle, judged by load rather than input: every
// 10 s it samples the CPU share, the busiest GPU and the free memory, all without the run's own
// share (the Windows guest's cgroup, and the processes marked as the run's own on this machine:
// Endfield and MaaEnd), so a run never counts against itself. Idle means all of them stayed within the limits for the
// configured minutes; an idle run is stopped when the load stays above them for two minutes,
// and the accounts it did not finish stay due.

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { store, runs } from './store.js';
import { orchestrator } from './orchestrator.js';
import { vm } from './vm.js';
import { OWN_MARK } from './games/endfield.js';

const SAMPLE_MS = 10_000;
const BUSY_MS = 2 * 60_000;

export const idle = { idle: false, since: null, available: false, error: null, cpu: null, gpu: null, memFreeGb: null, reasons: [] };
const samples = []; // { t, cpu, gpu, memFree (bytes the guest has or could get), memAvail }

// The most recent daily reset of the CN servers: 04:00 UTC+8.
export function lastReset(now = Date.now()) {
  const d = new Date(now);
  const r = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20);
  return r <= now ? r : r - 86400_000;
}

// Per account: last success, last attempt and whether it is due now, from the run records.
export function accountStatus(now = Date.now()) {
  const s = store.settings();
  const seen = {};
  for (const r of runs.list()) {
    for (const [id, a] of Object.entries(r.accounts || {})) {
      const at = Date.parse(r.endedAt || r.startedAt);
      const st = (seen[id] ||= { lastOk: null, lastAttempt: null, lastStatus: null });
      // A partial result (started, some tasks done) counts as done for scheduling: retrying it
      // would only repeat the tasks that already succeeded.
      const okish = a.status === 'ok' || a.status === 'partial';
      if (okish && (!st.lastOk || at > st.lastOk)) st.lastOk = at;
      if ((okish || a.status === 'failed') && (!st.lastAttempt || at > st.lastAttempt)) {
        st.lastAttempt = at;
        st.lastStatus = okish ? 'ok' : 'failed';
      }
    }
  }
  const out = {};
  for (const a of store.accounts()) {
    const st = seen[a.id] || { lastOk: null, lastAttempt: null, lastStatus: null };
    const stale = !st.lastOk || st.lastOk < lastReset(now) || now - st.lastOk >= s.intervalHours * 3600_000;
    const backoff = st.lastStatus === 'failed' && now - st.lastAttempt < s.retryMinutes * 60_000;
    out[a.id] = {
      lastOk: st.lastOk && new Date(st.lastOk).toISOString(),
      lastAttempt: st.lastAttempt && new Date(st.lastAttempt).toISOString(),
      lastStatus: st.lastStatus,
      due: a.enabled && stale && !backoff,
      retryAt: backoff ? new Date(st.lastAttempt + s.retryMinutes * 60_000).toISOString() : null,
      nextDue: stale ? null : new Date(Math.min(lastReset(now) + 86400_000, st.lastOk + s.intervalHours * 3600_000)).toISOString(),
    };
  }
  return out;
}

const dueIds = () => Object.entries(accountStatus()).filter(([, v]) => v.due).map(([id]) => id);

// ---- load sampling ----

let prevStat = null;
let prevGuest = null;
let guestCgroup = null; // cgroup directory of the guest's container, or null when it is off
let guestRamGb = 16; // the guest's memory size, from the pool

function cpuTotals() {
  const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const total = f.reduce((a, b) => a + b, 0);
  return { total, idle: f[3] + (f[4] || 0) };
}

function readGpu() {
  let best = null;
  for (const card of fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n))) {
    try {
      const v = Number(fs.readFileSync(`/sys/class/drm/${card}/device/gpu_busy_percent`, 'utf8'));
      if (Number.isFinite(v)) best = Math.max(best ?? 0, v);
    } catch {}
  }
  return best;
}

function memInfo() {
  const t = fs.readFileSync('/proc/meminfo', 'utf8');
  return Number(/MemAvailable:\s+(\d+)/.exec(t)[1]) * 1024;
}

function readCgroup(file) {
  try {
    return fs.readFileSync(`${guestCgroup}/${file}`, 'utf8');
  } catch {
    return null;
  }
}

// Finds the guest container's cgroup (it changes when the guest is booted again).
async function locateGuest() {
  try {
    const inst = await vm.status(store.settings().instance);
    if (inst?.ram_gb) guestRamGb = inst.ram_gb;
    if (!inst || inst.status === 'stopped') return (guestCgroup = null);
    const id = await new Promise((resolve) => execFile('docker', ['inspect', '-f', '{{.Id}}', `windows-pool-${inst.id}`],
      { timeout: 10_000 }, (err, out) => resolve(err ? null : out.trim())));
    const dir = id && `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
    guestCgroup = dir && fs.existsSync(dir) ? dir : null;
  } catch {
    guestCgroup = null;
  }
  return guestCgroup;
}

// The run's own processes on this machine (Endfield in its screen, MaaEnd and its agents) carry
// OWN_MARK in their environment; their CPU ticks, GPU engine time and memory are left out of the
// load like the guest's. GPU time comes from the DRM fdinfo of each client, counted once.
const ownSeen = new Map(); // pid -> { start, own }
let prevOwn = null; // { ticks, gpuNs, t }

function ownLoad() {
  let ticks = 0;
  let rss = 0;
  let gpuNs = 0;
  const clients = new Set();
  const alive = new Set();
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      continue;
    }
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    alive.add(pid);
    let seen = ownSeen.get(pid);
    if (!seen || seen.start !== f[19]) {
      let own = false;
      try {
        own = `\0${fs.readFileSync(`/proc/${pid}/environ`, 'latin1')}`.includes(`\0${OWN_MARK}\0`);
      } catch {}
      seen = { start: f[19], own };
      ownSeen.set(pid, seen);
    }
    if (!seen.own) continue;
    ticks += Number(f[11]) + Number(f[12]);
    rss += Number(f[21]) * 4096;
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fdinfo`);
    } catch {}
    for (const fd of fds) {
      let info;
      try {
        info = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
      } catch {
        continue;
      }
      const client = /drm-client-id:\s+(\d+)/.exec(info)?.[1];
      if (!client || clients.has(client)) continue;
      clients.add(client);
      for (const m of info.matchAll(/drm-engine-(?:gfx|compute):\s+(\d+) ns/g)) gpuNs += Number(m[1]);
    }
  }
  for (const pid of ownSeen.keys()) if (!alive.has(pid)) ownSeen.delete(pid);
  return { ticks, rss, gpuNs, t: process.hrtime.bigint() };
}

async function sample() {
  if (guestCgroup && !fs.existsSync(guestCgroup)) guestCgroup = null;
  if (!guestCgroup) await locateGuest();
  const stat = cpuTotals();
  const guestUsec = guestCgroup ? Number(/usage_usec (\d+)/.exec(readCgroup('cpu.stat') || '')?.[1] || 0) : 0;
  const guestMem = guestCgroup ? Number(readCgroup('memory.current') || 0) : 0;
  const memAvail = memInfo();
  const own = ownLoad();
  let gpu = readGpu();
  if (gpu !== null && prevOwn && own.gpuNs >= prevOwn.gpuNs) {
    const share = (own.gpuNs - prevOwn.gpuNs) / Number(own.t - prevOwn.t) * 100;
    gpu = Math.max(0, gpu - share);
  }
  if (prevStat && stat.total > prevStat.total) {
    const ticks = stat.total - prevStat.total;
    const busyTicks = ticks - (stat.idle - prevStat.idle);
    const hz = 100; // USER_HZ
    const guestTicks = prevGuest !== null && guestUsec >= prevGuest ? ((guestUsec - prevGuest) / 1e6) * hz : 0;
    const ownTicks = prevOwn && own.ticks >= prevOwn.ticks ? own.ticks - prevOwn.ticks : 0;
    const cpu = Math.max(0, Math.min(100, ((busyTicks - guestTicks - ownTicks) / ticks) * 100));
    samples.push({ t: Date.now(), cpu, gpu, memFree: memAvail + guestMem + own.rss, memAvail });
  }
  prevStat = stat;
  prevGuest = guestCgroup ? guestUsec : null;
  prevOwn = own;
  const keep = Date.now() - Math.max(store.settings().idleMinutes * 60_000, BUSY_MS) - SAMPLE_MS;
  while (samples.length && samples[0].t < keep) samples.shift();
  idle.available = true;
  judge();
}

const avg = (list, k) => {
  const v = list.map((x) => x[k]).filter((x) => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// Whether the samples of the last `ms` are within the limits, with the reasons they are not.
function within(ms) {
  const s = store.settings();
  const win = samples.filter((x) => x.t >= Date.now() - ms);
  const reasons = [];
  if (!win.length || win[0].t > Date.now() - ms + 2 * SAMPLE_MS) reasons.push('采样时间不足');
  const cpu = avg(win, 'cpu');
  const gpu = avg(win, 'gpu');
  const memFree = win.length ? Math.min(...win.map((x) => x.memFree)) : null;
  const need = (guestRamGb + s.memMarginGb) * 2 ** 30;
  if (cpu !== null && cpu > s.cpuMax) reasons.push(`CPU ${cpu.toFixed(0)}% > ${s.cpuMax}%`);
  if (gpu !== null && gpu > s.gpuMax) reasons.push(`GPU ${gpu.toFixed(0)}% > ${s.gpuMax}%`);
  if (memFree !== null && memFree < need) reasons.push(`可用内存 ${(memFree / 2 ** 30).toFixed(0)} GB 不足`);
  return { ok: !reasons.length, reasons, cpu, gpu, memFree };
}

function judge() {
  const s = store.settings();
  const last = samples.at(-1);
  if (last) {
    idle.cpu = Math.round(last.cpu);
    idle.gpu = last.gpu === null ? null : Math.round(last.gpu);
    idle.memFreeGb = Math.round(last.memFree / 2 ** 30);
  }
  const w = within(s.idleMinutes * 60_000);
  if (w.ok !== idle.idle) {
    idle.idle = w.ok;
    idle.since = new Date().toISOString();
  }
  idle.reasons = w.reasons;
  if (idle.idle) return tick();

  // An idle run yields once the load has stayed above the limits for two minutes (or memory
  // is about to run out); a short spike does not stop it.
  const b = orchestrator.busy();
  if (b?.kind !== 'run' || b.trigger !== 'idle' || b.stopping || !s.stopWhenBusy) return;
  const recent = samples.filter((x) => x.t >= Date.now() - BUSY_MS);
  const lowMem = last && last.memAvail < 2 * 2 ** 30;
  const busyAll = recent.length >= BUSY_MS / SAMPLE_MS - 1 && recent.every((x) =>
    x.cpu > s.cpuMax || (x.gpu !== null && x.gpu > s.gpuMax));
  if (lowMem || busyAll) orchestrator.stop('yield');
}

function tick() {
  const s = store.settings();
  if (!s.enabled || !idle.idle || orchestrator.busy()) return;
  const ids = dueIds();
  if (!ids.length) return;
  try {
    orchestrator.startRun('idle', ids);
  } catch {}
}

export function startScheduler() {
  const loop = () => sample().catch((e) => {
    idle.available = false;
    idle.error = `无法读取负载：${e.message}`;
  }).finally(() => setTimeout(loop, SAMPLE_MS));
  loop();
}

// When the next idle run could start: now if accounts are due, else the earliest time one
// becomes due again.
export function nextDue() {
  const all = accountStatus();
  const st = store.accounts().filter((a) => a.enabled).map((a) => all[a.id]);
  if (st.some((v) => v.due)) return 'now';
  const times = st.map((v) => v.retryAt || v.nextDue).filter(Boolean).sort();
  return times[0] || null;
}
