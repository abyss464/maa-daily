// Settings, accounts and run records, as JSON files under the data directory:
//   state.json          settings and accounts
//   runs/<id>.json      one run: trigger, times, status, per-account results
//   runs/<id>.log       its log, one line per event

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { GAMES } from './games/index.js';

const STATE = path.join(config.dataDir, 'state.json');
const RUNS = path.join(config.dataDir, 'runs');

export const DEFAULT_SETTINGS = {
  enabled: true,
  // A run starts on its own for the accounts that are due once the computer has been idle for
  // this many minutes: the load of everything but the Windows guest itself stays under these
  // limits (CPU as a share of all cores, the busiest GPU), and the guest's memory plus a margin
  // is free.
  idleMinutes: 5,
  cpuMax: 35,
  gpuMax: 40,
  memMarginGb: 8,
  // An account is due when it has not succeeded since the daily reset, or for this many hours.
  intervalHours: 10,
  // After a failed attempt an account waits this long before the next idle run tries it again.
  retryMinutes: 60,
  // Load above the limits for two minutes ends an idle run; the accounts it did not finish stay due.
  stopWhenBusy: true,
  instance: 'arknights',
  // The Lutris game whose Wine prefix holds Endfield (the official launcher's install).
  endfieldLutrisGame: 'arknight',
  endfieldPlayMinutes: 20,
  // Shut the emulator and Windows down after a run, when the run was what started Windows.
  shutdownAfter: true,
  closeGame: true,
  accountTimeoutMin: 90,
};

fs.mkdirSync(RUNS, { recursive: true, mode: 0o700 });

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const settings = { ...DEFAULT_SETTINGS, ...s.settings };
    if (settings.stopWhenActive !== undefined) settings.stopWhenBusy = settings.stopWhenActive;
    delete settings.times;
    delete settings.stopWhenActive;
    return { settings, accounts: s.accounts || [] };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, accounts: [] };
  }
}

let state = load();
const save = () => writeAtomic(STATE, state);

export class InputError extends Error {}

function intIn(v, min, max, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${what}应为 ${min}–${max} 的整数`);
  return n;
}

function cleanAccount(body, base = {}) {
  const a = { ...base };
  if (body.name !== undefined) a.name = String(body.name).trim().slice(0, 60);
  if (!a.name) throw new InputError('账号需要一个名称');
  if (body.game !== undefined && !a.tasks) {
    if (!GAMES[body.game]) throw new InputError(`不支持的游戏：${body.game}`);
    a.game = body.game;
  }
  a.game ||= 'arknights';
  const game = GAMES[a.game];
  if (body.client_type !== undefined) {
    if (a.game === 'arknights' && !['Official', 'Bilibili'].includes(body.client_type)) throw new InputError('服务器只能是官服或 B 服');
    a.client_type = body.client_type;
  }
  a.client_type ||= 'Official';
  if (body.account_name !== undefined) a.account_name = String(body.account_name).trim().slice(0, 60);
  if (body.enabled !== undefined) a.enabled = Boolean(body.enabled);
  a.enabled ??= true;
  if (body.note !== undefined) a.note = String(body.note).slice(0, 500);
  if (body.tasks !== undefined) {
    if (typeof body.tasks !== 'object' || body.tasks === null || Array.isArray(body.tasks)) throw new InputError('任务参数必须是 JSON 对象');
    try {
      game.checkTasks(body.tasks);
    } catch (e) {
      throw new InputError(e.message);
    }
    a.tasks = body.tasks;
  }
  a.tasks ||= game.defaultTasks();
  return a;
}

export const store = {
  settings: () => state.settings,
  accounts: () => state.accounts,
  account: (id) => state.accounts.find((a) => a.id === id),

  updateSettings(body) {
    const s = { ...state.settings };
    if (body.enabled !== undefined) s.enabled = Boolean(body.enabled);
    if (body.idleMinutes !== undefined) s.idleMinutes = intIn(body.idleMinutes, 1, 240, '空闲分钟数');
    if (body.cpuMax !== undefined) s.cpuMax = intIn(body.cpuMax, 1, 100, 'CPU 上限');
    if (body.gpuMax !== undefined) s.gpuMax = intIn(body.gpuMax, 1, 100, 'GPU 上限');
    if (body.memMarginGb !== undefined) s.memMarginGb = intIn(body.memMarginGb, 0, 256, '内存余量');
    if (body.intervalHours !== undefined) s.intervalHours = intIn(body.intervalHours, 1, 48, '间隔小时数');
    if (body.retryMinutes !== undefined) s.retryMinutes = intIn(body.retryMinutes, 5, 1440, '失败重试分钟数');
    if (body.stopWhenBusy !== undefined) s.stopWhenBusy = Boolean(body.stopWhenBusy);
    if (body.shutdownAfter !== undefined) s.shutdownAfter = Boolean(body.shutdownAfter);
    if (body.closeGame !== undefined) s.closeGame = Boolean(body.closeGame);
    if (body.accountTimeoutMin !== undefined) s.accountTimeoutMin = intIn(body.accountTimeoutMin, 5, 600, '单账号最长运行分钟数');
    if (body.instance !== undefined) s.instance = String(body.instance).trim() || DEFAULT_SETTINGS.instance;
    if (body.endfieldPlayMinutes !== undefined) s.endfieldPlayMinutes = intIn(body.endfieldPlayMinutes, 0, 600, '推进任务的分钟数');
    if (body.endfieldLutrisGame !== undefined) s.endfieldLutrisGame = String(body.endfieldLutrisGame).trim() || DEFAULT_SETTINGS.endfieldLutrisGame;
    state.settings = s;
    save();
    return s;
  },

  addAccount(body) {
    const a = cleanAccount(body, { id: crypto.randomBytes(4).toString('hex'), createdAt: new Date().toISOString() });
    state.accounts.push(a);
    save();
    return a;
  },

  updateAccount(id, body) {
    const i = state.accounts.findIndex((a) => a.id === id);
    if (i < 0) return null;
    state.accounts[i] = cleanAccount(body, state.accounts[i]);
    save();
    return state.accounts[i];
  },

  removeAccount(id) {
    const before = state.accounts.length;
    state.accounts = state.accounts.filter((a) => a.id !== id);
    save();
    return state.accounts.length < before;
  },

  moveAccount(id, dir) {
    const i = state.accounts.findIndex((a) => a.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= state.accounts.length) return false;
    [state.accounts[i], state.accounts[j]] = [state.accounts[j], state.accounts[i]];
    save();
    return true;
  },
};

// ---- runs ----

export function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const runs = {
  save: (run) => writeAtomic(path.join(RUNS, `${run.id}.json`), run),
  appendLog: (id, line) => fs.appendFileSync(path.join(RUNS, `${id}.log`), `${line}\n`, { mode: 0o600 }),
  log(id) {
    try {
      return fs.readFileSync(path.join(RUNS, `${id}.log`), 'utf8');
    } catch {
      return '';
    }
  },
  get(id) {
    if (!/^[\w-]+$/.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(RUNS, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  },
  // Newest first.
  list() {
    return fs.readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort().reverse()
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  },
};
