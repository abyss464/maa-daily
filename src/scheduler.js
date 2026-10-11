// Runs the due accounts while the desktop is idle. Idleness comes from a private hypridle
// instance on the owner's Hyprland session (ext-idle-notify: no input for the configured
// minutes, and no idle inhibitor such as a playing video). Input during an idle run ends it
// when the settings say so; the accounts it did not finish stay due for the next idle spell.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { config } from './config.js';
import { store, runs } from './store.js';
import { orchestrator } from './orchestrator.js';

const MARK = '@@maa-daily';
const CONF = path.join(config.dataDir, 'hypridle.conf');

export const idle = { idle: false, since: null, available: false, error: null };
let child = null;
let childMinutes = null;

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
      if (a.status === 'ok' && (!st.lastOk || at > st.lastOk)) st.lastOk = at;
      if (['ok', 'failed'].includes(a.status) && (!st.lastAttempt || at > st.lastAttempt)) {
        st.lastAttempt = at;
        st.lastStatus = a.status;
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

function onIdle() {
  idle.idle = true;
  idle.since = new Date().toISOString();
  tick();
}

function onActive() {
  idle.idle = false;
  idle.since = new Date().toISOString();
  const b = orchestrator.busy();
  if (b?.kind === 'run' && b.trigger === 'idle' && !b.stopping && store.settings().stopWhenActive) {
    orchestrator.stop('yield');
  }
}

// The session environment of the owner's desktop, as systemd holds it now (Hyprland may have
// restarted since this service started).
function sessionEnv() {
  const env = { ...process.env };
  try {
    for (const line of execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).split('\n')) {
      const m = /^(WAYLAND_DISPLAY|XDG_RUNTIME_DIR|HYPRLAND_INSTANCE_SIGNATURE)=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}

function startWatcher() {
  const minutes = store.settings().idleMinutes;
  fs.writeFileSync(CONF, `general {\n    ignore_dbus_inhibit = false\n}\n\nlistener {\n    timeout = ${minutes * 60}\n` +
    `    on-timeout = echo ${MARK}-idle\n    on-resume = echo ${MARK}-active\n}\n`);
  childMinutes = minutes;
  idle.idle = false;
  const p = spawn('hypridle', ['-c', CONF], { env: sessionEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  child = p;
  let buf = '';
  p.stdout.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === `${MARK}-idle`) onIdle();
      else if (line === `${MARK}-active`) onActive();
    }
  });
  p.stderr.on('data', () => {});
  p.on('spawn', () => {
    idle.available = true;
    idle.error = null;
  });
  p.on('error', (e) => {
    idle.available = false;
    idle.error = `无法检测空闲：${e.message}`;
  });
  p.on('exit', (code) => {
    if (child !== p) return;
    child = null;
    idle.available = false;
    idle.idle = false;
    idle.error ||= `空闲检测退出（${code}），稍后重试`;
    setTimeout(startWatcher, 30_000);
  });
}

function tick() {
  const s = store.settings();
  // A change of the idle minutes takes a new watcher.
  if (child && childMinutes !== s.idleMinutes) {
    const old = child;
    child = null;
    old.kill();
    startWatcher();
    return;
  }
  if (!s.enabled || !idle.idle || orchestrator.busy()) return;
  const ids = dueIds();
  if (!ids.length) return;
  try {
    orchestrator.startRun('idle', ids);
  } catch {}
}

export function startScheduler() {
  startWatcher();
  setInterval(tick, 30_000);
  process.on('exit', () => child?.kill());
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
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
