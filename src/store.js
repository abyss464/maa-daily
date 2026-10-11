// Settings, accounts and run records, as JSON files under the data directory:
//   state.json          settings and accounts
//   runs/<id>.json      one run: trigger, times, status, per-account results
//   runs/<id>.log       its log, one line per event

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const STATE = path.join(config.dataDir, 'state.json');
const RUNS = path.join(config.dataDir, 'runs');

export const DEFAULT_SETTINGS = {
  enabled: true,
  // Local times of day ("HH:MM") a run starts on its own.
  times: ['05:00', '17:00'],
  instance: 'arknights',
  // Shut the emulator and Windows down after a run, when the run was what started Windows.
  shutdownAfter: true,
  closeGame: true,
  accountTimeoutMin: 90,
};

// The tasks a new account starts with: MAA's own parameters, so the advanced editor shows
// exactly what MAA receives.
export function defaultTasks() {
  return {
    Fight: { enable: true, stage: '', medicine: 0, medicine_expire_days: 0, stone: 0, series: 0, report_to_penguin: false },
    Recruit: { enable: true, refresh: true, select: [4], confirm: [3, 4], times: 4, set_time: true, expedite: false },
    Infrast: {
      enable: true, mode: 0, facility: ['Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Dorm'],
      drones: 'Money', threshold: 0.3, replenish: true,
    },
    Mall: { enable: true, visit_friends: true, shopping: true, buy_first: ['招聘许可', '龙门币'], blacklist: ['家具零件', '碳'] },
    Award: { enable: true, award: true, mail: true, recruit: false },
  };
}

const TASK_NAMES = Object.keys(defaultTasks());

fs.mkdirSync(RUNS, { recursive: true, mode: 0o700 });

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return { settings: { ...DEFAULT_SETTINGS, ...s.settings }, accounts: s.accounts || [] };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, accounts: [] };
  }
}

let state = load();
const save = () => writeAtomic(STATE, state);

export class InputError extends Error {}

function checkTimes(times) {
  if (!Array.isArray(times)) throw new InputError('运行时间必须是列表');
  const out = [...new Set(times.map((t) => String(t).trim()).filter(Boolean))];
  for (const t of out) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new InputError(`时间格式应为 HH:MM：${t}`);
  return out.sort();
}

function cleanAccount(body, base = {}) {
  const a = { ...base };
  if (body.name !== undefined) a.name = String(body.name).trim().slice(0, 60);
  if (!a.name) throw new InputError('账号需要一个名称');
  if (body.client_type !== undefined) {
    if (!['Official', 'Bilibili'].includes(body.client_type)) throw new InputError('服务器只能是官服或 B 服');
    a.client_type = body.client_type;
  }
  a.client_type ||= 'Official';
  if (body.account_name !== undefined) a.account_name = String(body.account_name).trim().slice(0, 60);
  if (body.enabled !== undefined) a.enabled = Boolean(body.enabled);
  a.enabled ??= true;
  if (body.note !== undefined) a.note = String(body.note).slice(0, 500);
  if (body.tasks !== undefined) {
    if (typeof body.tasks !== 'object' || body.tasks === null || Array.isArray(body.tasks)) throw new InputError('任务参数必须是 JSON 对象');
    const tasks = {};
    for (const [k, v] of Object.entries(body.tasks)) {
      if (!TASK_NAMES.includes(k)) throw new InputError(`未知任务：${k}（可用：${TASK_NAMES.join('、')}）`);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new InputError(`任务 ${k} 的参数必须是 JSON 对象`);
      tasks[k] = v;
    }
    a.tasks = tasks;
  }
  a.tasks ||= defaultTasks();
  return a;
}

export const store = {
  settings: () => state.settings,
  accounts: () => state.accounts,
  account: (id) => state.accounts.find((a) => a.id === id),

  updateSettings(body) {
    const s = { ...state.settings };
    if (body.enabled !== undefined) s.enabled = Boolean(body.enabled);
    if (body.times !== undefined) s.times = checkTimes(body.times);
    if (body.shutdownAfter !== undefined) s.shutdownAfter = Boolean(body.shutdownAfter);
    if (body.closeGame !== undefined) s.closeGame = Boolean(body.closeGame);
    if (body.accountTimeoutMin !== undefined) {
      const n = Number(body.accountTimeoutMin);
      if (!Number.isInteger(n) || n < 5 || n > 600) throw new InputError('单账号超时应为 5–600 分钟');
      s.accountTimeoutMin = n;
    }
    if (body.instance !== undefined) s.instance = String(body.instance).trim() || DEFAULT_SETTINGS.instance;
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
