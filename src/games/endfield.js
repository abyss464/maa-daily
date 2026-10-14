// Arknights: Endfield, played on this machine: the PC client from its Lutris prefix runs under Wine
// in a screen of the hypr-screens pool (invisible, on the real GPU), and MaaEnd's CLI drives it
// through the Linux-Wlroots controller, one account after another. MaaEnd is our own branch of it
// (~/Code/vendor/MaaEnd, branch maa-daily), built into its install/ folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { config } from '../config.js';
import { lutrisGame, prefixBusy } from '../lutris.js';
import { screens } from '../screens.js';

const MAAEND = process.env.MAAEND_DIR || path.join(os.homedir(), 'Code/vendor/MaaEnd/install');
// The CLI takes the project from its libraries' folder: the runtime is a folder of links that
// holds both (endfield/link-runtime.sh builds it).
const RUNTIME = path.join(config.dataDir, 'maaend-runtime');
const GAME_SUBDIR = 'drive_c/Program Files/Hypergryph Launcher/games/Arknights Endfield';
const EXE = 'Endfield.exe';
// Processes carrying this mark are the run's own (the game, MaaEnd and its agents): the idle
// judgement leaves their load out.
export const OWN_MARK = 'MAA_DAILY_OWN=1';

// ---- MaaEnd's catalogue: tasks, their options and presets, with Chinese labels ----

function readJsonc(file) {
  const text = fs.readFileSync(file, 'utf8');
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

let catalogCache = null;

export function catalog() {
  const iface = path.join(MAAEND, 'interface.json');
  const stamp = fs.existsSync(iface) ? fs.statSync(iface).mtimeMs : 0;
  if (catalogCache?.stamp === stamp) return catalogCache;
  if (!stamp) return { stamp, available: false, error: `没有找到 MaaEnd：${MAAEND}`, tasks: [], defaults: {} };
  const data = readJsonc(iface);
  let labels = {};
  try {
    labels = readJsonc(path.join(MAAEND, 'locales/interface/zh_cn.json'));
  } catch {}
  const label = (s) => (typeof s === 'string' && s.startsWith('$') ? labels[s.slice(1)] || s.slice(1) : s);
  const tasks = [];
  const options = { ...(data.option || {}) };
  const presets = {};
  for (const rel of data.import || []) {
    let d;
    try {
      d = readJsonc(path.join(MAAEND, rel));
    } catch {
      continue;
    }
    for (const t of d.task || []) tasks.push(t);
    Object.assign(options, d.option || {});
    for (const p of d.preset || []) presets[p.name] = p;
  }
  const linux = tasks.filter((t) => !t.controller || t.controller.includes('Linux-Wlroots'));
  const full = presets.DailyFull?.task || [];
  const quick = new Set((presets.QuickDaily?.task || []).map((t) => t.name));
  // A new account starts from MaaEnd's full daily preset with the quick-daily tasks enabled.
  const defaults = {};
  for (const t of full) if (linux.some((x) => x.name === t.name)) defaults[t.name] = { enable: quick.has(t.name), option: t.option || {} };
  catalogCache = {
    stamp,
    available: true,
    version: data.version,
    tasks: linux.map((t) => ({ name: t.name, label: label(t.label) || t.name, entry: t.entry, options: t.option || [] })),
    optionLabels: Object.fromEntries(Object.entries(options).map(([k, v]) => [k, label(v.label) || k])),
    entries: Object.fromEntries(linux.map((t) => [t.entry, t.name])),
    defaults,
  };
  return catalogCache;
}

export function defaultTasks() {
  return structuredClone(catalog().defaults);
}

export function checkTasks(tasks) {
  const known = new Set(catalog().tasks.map((t) => t.name));
  for (const [k, v] of Object.entries(tasks)) {
    if (known.size && !known.has(k)) throw new Error(`MaaEnd 没有任务 ${k}`);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`任务 ${k} 的参数必须是 JSON 对象`);
  }
}

// An account's tasks as the CLI's configuration: a string is a selected case, a list the checked
// cases, an object the fields of an input option.
function piOptions(option = {}) {
  return Object.entries(option).map(([name, v]) =>
    Array.isArray(v) ? { name, values: v.map(String) }
      : v && typeof v === 'object' ? { name, inputs: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) }
        : { name, value: String(v) });
}

function piConfig(acc, socket, switchAccount) {
  const task = [];
  if (switchAccount && acc.account_name) {
    task.push({ name: 'AccountSwitch', option: piOptions({ AccountSwitchMatchMode: 'LastFourDigits', AccountSwitchLastFourDigits: { LastFourDigits: acc.account_name.slice(-4) } }) });
  }
  for (const [name, t] of Object.entries(acc.tasks || {})) if (t.enable) task.push({ name, option: piOptions(t.option) });
  return { controller: { name: 'Linux-Wlroots' }, lnx: { wlr_socket_path: socket }, resource: '官服', task };
}

// ---- a run ----

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const endfield = {
  id: 'endfield',
  label: '明日方舟：终末地',
  activeScreen: null,

  async run(ctx, run, accounts) {
    const settings = ctx.settings;
    const cat = catalog();
    if (!cat.available) throw new Error(cat.error);
    if (!fs.existsSync(path.join(RUNTIME, 'maafw', 'MaaPiCli'))) throw new Error('MaaEnd 运行目录没有建好：运行 endfield/link-runtime.sh');
    const game = lutrisGame(settings.endfieldLutrisGame || 'arknight');
    const gameDir = path.join(game.prefix, GAME_SUBDIR);
    if (!fs.existsSync(path.join(gameDir, EXE))) throw new Error(`Lutris 前缀里没有终末地：${gameDir}`);
    if (prefixBusy(game.prefix, EXE)) throw new Error('终末地已经在运行（可能有人在玩），这一轮不运行');

    ctx.stage('申请屏幕');
    const screen = await screens.open({ label: '终末地日常', ttl: (accounts.length * settings.accountTimeoutMin + 30) * 60 });
    this.activeScreen = screen.id;
    const env = { ...game.env, WINEPREFIX: game.prefix, WINEESYNC: '1', WINEFSYNC: '1', WINEDEBUG: '-all', DXVK_LOG_LEVEL: 'none', MAA_DAILY_OWN: '1' };
    const envArgs = Object.entries(env).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
    try {
      ctx.stage('启动终末地');
      const launched = await screens.launch(screen.id, `sh -c ${sh(`cd ${sh(gameDir)} && exec env ${envArgs} ${sh(game.wine)} ${EXE}`)}`, 90);
      if (!launched.windows.length) throw new Error('终末地 90 秒内没有打开窗口');
      ctx.log(`终末地已启动（屏幕 ${screen.id}）`);

      for (const acc of accounts) {
        if (ctx.stopping()) break;
        ctx.event({ ev: 'account', account: acc.id, phase: 'start' });
        const started = Date.now();
        const result = await this.runAccount(ctx, acc, screen, cat, accounts.length > 1);
        ctx.event({ ev: 'account', account: acc.id, phase: 'end', ...result, seconds: Math.round((Date.now() - started) / 1000) });
      }
    } finally {
      this.activeScreen = null;
      ctx.stage('关闭终末地');
      try {
        execFileSync(game.wineserver, ['-k'], { env: { ...process.env, WINEPREFIX: game.prefix }, timeout: 30_000 });
      } catch {}
      await screens.close(screen.id);
    }
  },

  // The game opened for a person (a first login, a tutorial MaaEnd does not handle), in a pool
  // screen watched and worked from the pool's browser viewer, until closeForUser.
  manualScreen: null,

  async openForUser(settings) {
    if (this.manualScreen) return screens.get(this.manualScreen);
    const game = lutrisGame(settings.endfieldLutrisGame || 'arknight');
    const gameDir = path.join(game.prefix, GAME_SUBDIR);
    if (prefixBusy(game.prefix, EXE)) throw new Error('终末地已经在运行');
    const screen = await screens.open({ label: '终末地（手动）', ttl: 3 * 3600 });
    const env = { ...game.env, WINEPREFIX: game.prefix, WINEESYNC: '1', WINEFSYNC: '1', WINEDEBUG: '-all', DXVK_LOG_LEVEL: 'none', MAA_DAILY_OWN: '1' };
    const envArgs = Object.entries(env).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
    await screens.launch(screen.id, `sh -c ${sh(`cd ${sh(gameDir)} && exec env ${envArgs} ${sh(game.wine)} ${EXE}`)}`, 90);
    this.manualScreen = screen.id;
    return screens.get(screen.id);
  },

  async closeForUser(settings) {
    const game = lutrisGame(settings.endfieldLutrisGame || 'arknight');
    try {
      execFileSync(game.wineserver, ['-k'], { env: { ...process.env, WINEPREFIX: game.prefix }, timeout: 30_000 });
    } catch {}
    if (this.manualScreen) await screens.close(this.manualScreen);
    this.manualScreen = null;
  },

  // One account: the CLI runs its tasks; their outcomes come from MaaFramework's own log.
  async runAccount(ctx, acc, screen, cat, switchAccount) {
    const maafw = path.join(RUNTIME, 'maafw');
    fs.mkdirSync(path.join(maafw, 'config'), { recursive: true });
    const conf = piConfig(acc, screen.wayland_socket, switchAccount);
    fs.writeFileSync(path.join(maafw, 'config', 'maa_pi_config.json'), JSON.stringify(conf, null, 1));
    const logFile = path.join(maafw, 'debug', 'maafw.log');
    const before = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
    const offset = before ? before.size : 0;
    this.logIno = before?.ino ?? null;
    const wanted = conf.task.map((t) => t.name);
    ctx.log(`任务：${wanted.map((n) => cat.tasks.find((t) => t.name === n)?.label || n).join('、')}`, acc.name);

    const child = spawn(path.join(maafw, 'MaaPiCli'), ['-d'], {
      cwd: maafw, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LD_LIBRARY_PATH: maafw, MAA_DAILY_OWN: '1' },
    });
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    };
    ctx.setChild({ kill });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctx.log(`运行超过 ${ctx.settings.accountTimeoutMin} 分钟，停止`, acc.name);
      kill();
    }, ctx.settings.accountTimeoutMin * 60_000);
    const watch = setInterval(() => this.readOutcomes(ctx, acc, logFile, offset, cat, false), 5000);
    const code = await new Promise((resolve) => child.on('close', resolve));
    clearInterval(watch);
    clearTimeout(timer);
    ctx.setChild(null);
    const chains = this.readOutcomes(ctx, acc, logFile, offset, cat, true);
    for (const n of wanted) chains[n] ||= 'error';
    const done = wanted.filter((n) => chains[n] === 'done');
    const ok = code === 0 && done.length === wanted.length;
    return { ok, chains, timed_out: timedOut, partial: !ok && done.length > 0 && chains.AccountSwitch !== 'error' };
  },

  // Each task's start and end, from the framework log since `offset`: every call reads only what
  // was appended since the last one, and reports each change once.
  readOutcomes(ctx, acc, logFile, offset, cat, final) {
    const tracks = (this.tracks ||= new Map());
    const key = `${acc.id}:${offset}`;
    const track = tracks.get(key) || { pos: offset, ino: null, rest: '', state: {} };
    try {
      const fd = fs.openSync(logFile, 'r');
      const { size, ino } = fs.fstatSync(fd);
      // The framework rotates its log when it starts: another file, or a shorter one, is new.
      track.ino ??= offset ? this.logIno : ino;
      if (ino !== track.ino || size < track.pos) {
        track.pos = 0;
        track.ino = ino;
      }
      if (size > track.pos) {
        const buf = Buffer.alloc(size - track.pos);
        fs.readSync(fd, buf, 0, buf.length, track.pos);
        track.pos = size;
        track.rest += buf.toString('utf8');
      }
      fs.closeSync(fd);
    } catch {}
    const cut = track.rest.lastIndexOf('\n');
    const text = cut >= 0 ? track.rest.slice(0, cut) : '';
    track.rest = cut >= 0 ? track.rest.slice(cut + 1) : track.rest;
    const re = /\[msg=Tasker\.Task\.(Starting|Succeeded|Failed)\] \[details=\{"entry":"([^"]+)"/g;
    for (let m; (m = re.exec(text));) {
      const name = cat.entries[m[2]] || (m[2].startsWith('AccountSwitch') ? 'AccountSwitch' : m[2]);
      const st = m[1] === 'Starting' ? 'start' : m[1] === 'Succeeded' ? 'done' : 'error';
      if (track.state[name] === st) continue;
      track.state[name] = st;
      ctx.event({ ev: 'chain', account: acc.id, chain: name, state: st, label: cat.tasks.find((t) => t.name === name)?.label });
    }
    if (final) tracks.delete(key);
    else tracks.set(key, track);
    return { ...track.state };
  },
};
