// HTTP interface and web page of maa-daily, on 127.0.0.1 only.
//
//   GET    /                          the web page
//   GET    /api/state                 settings, accounts and whether each is due, idleness, what is running, the guest
//   PUT    /api/settings              {enabled, idleMinutes, intervalHours, retryMinutes, stopWhenActive,
//                                      shutdownAfter, closeGame, accountTimeoutMin, instance}
//   POST   /api/accounts              add {game, name, client_type, account_name, enabled, note, tasks}
//   PUT    /api/accounts/:id          change any of those
//   DELETE /api/accounts/:id
//   POST   /api/accounts/:id/move     {dir: -1 | 1} (accounts run in list order)
//   GET    /api/games                 the games: label, the tasks a new account starts with, and for
//                                      Endfield MaaEnd's task catalogue
//   POST   /api/run                   run now {accounts: [ids]} (default: every enabled account)
//   POST   /api/stop                  stop what is running
//   POST   /api/prepare               open a game for a person {client_type: Official | Bilibili (Arknights
//                                      in the guest) | endfield (in a pool screen, worked from its viewer)}
//   POST   /api/shutdown              shut the emulator and Windows down
//   POST   /api/close-endfield        close Endfield opened for a person, and its screen
//   GET    /api/runs                  run records, newest first {limit}
//   GET    /api/runs/:id              one record with its log
//   GET    /api/stats                 totals per account and battles per day {days}
//   GET    /api/screen                the screen of what runs as PNG: Endfield's pool screen while it
//                                      plays, else the Windows guest's screen

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { store, runs, InputError } from './store.js';
import { GAMES } from './games/index.js';
import { screens } from './screens.js';
import { orchestrator } from './orchestrator.js';
import { startScheduler, idle, accountStatus, nextDue } from './scheduler.js';
import { stats } from './stats.js';
import { vm } from './vm.js';

const PAGE = path.join(config.root, 'web', 'index.html');
const MAX_BODY = 256 * 1024;
const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`,
  ...(process.env.MAA_DAILY_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)]);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求太大'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function guest() {
  try {
    const inst = await vm.status(store.settings().instance);
    if (!inst) return { exists: false };
    return { exists: true, status: inst.status, viewer: inst.viewer, ram_gb: inst.ram_gb, cpus: inst.cpus };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

// The pool screen on show (Endfield playing, or opened for a person), with its viewer.
async function poolScreen() {
  const id = orchestrator.screen();
  if (!id) return null;
  try {
    const s = await screens.get(id);
    return { id, viewer: s.viewer, vnc: Boolean(s.vnc_port), vncError: s.vnc_error, manual: id === GAMES.endfield.manualScreen };
  } catch {
    return null;
  }
}

async function route(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const m = req.method;
  if (m === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(PAGE));
  }
  if (parts[0] !== 'api') return send(res, 404, { error: '没有这个页面' });
  const [, a, b, c] = parts;

  if (m === 'GET' && a === 'state') {
    return send(res, 200, {
      settings: store.settings(), accounts: store.accounts(), busy: orchestrator.busy(),
      notice: orchestrator.lastNotice || null, guest: await guest(), idle, due: accountStatus(), nextDue: nextDue(),
      screen: await poolScreen(),
    });
  }
  if (m === 'PUT' && a === 'settings') return send(res, 200, store.updateSettings(await readJson(req)));
  if (m === 'GET' && a === 'games') {
    const ef = GAMES.endfield.catalog();
    return send(res, 200, {
      arknights: { label: GAMES.arknights.label, defaults: GAMES.arknights.defaultTasks() },
      endfield: {
        label: GAMES.endfield.label, available: ef.available, error: ef.error, version: ef.version,
        tasks: ef.tasks, optionLabels: ef.optionLabels, defaults: ef.defaults,
      },
    });
  }
  if (a === 'accounts') {
    if (m === 'POST' && !b) return send(res, 201, store.addAccount(await readJson(req)));
    if (b && !c && m === 'PUT') {
      const acc = store.updateAccount(b, await readJson(req));
      return acc ? send(res, 200, acc) : send(res, 404, { error: '没有这个账号' });
    }
    if (b && !c && m === 'DELETE') return store.removeAccount(b) ? send(res, 200, { removed: true }) : send(res, 404, { error: '没有这个账号' });
    if (b && c === 'move' && m === 'POST') {
      const { dir } = await readJson(req);
      return send(res, 200, { moved: store.moveAccount(b, Number(dir)) });
    }
  }
  if (m === 'POST' && a === 'run') {
    const body = await readJson(req);
    const ids = Array.isArray(body.accounts) && body.accounts.length ? body.accounts.map(String) : null;
    return send(res, 202, orchestrator.startRun('manual', ids));
  }
  if (m === 'POST' && a === 'stop') return send(res, 200, orchestrator.stop());
  if (m === 'POST' && a === 'prepare') return send(res, 202, orchestrator.prepare((await readJson(req)).client_type));
  if (m === 'POST' && a === 'shutdown') return send(res, 202, orchestrator.shutdown());
  if (m === 'POST' && a === 'close-endfield') return send(res, 202, orchestrator.closeEndfield());
  if (m === 'GET' && a === 'runs' && !b) {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
    return send(res, 200, runs.list().slice(0, limit));
  }
  if (m === 'GET' && a === 'runs' && b) {
    const r = runs.get(b);
    return r ? send(res, 200, { ...r, log: runs.log(b) }) : send(res, 404, { error: '没有这次运行' });
  }
  if (m === 'GET' && a === 'stats') return send(res, 200, stats({ days: Math.min(Number(url.searchParams.get('days')) || 30, 365) }));
  if (m === 'GET' && a === 'screen') {
    const screen = orchestrator.screen();
    const png = screen ? await screens.screenshot(screen) : await vm.screenshot(store.settings().instance);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(png);
  }
  return send(res, 404, { error: '没有这个接口' });
}

export function serve() {
  const server = http.createServer(async (req, res) => {
    // Only this loopback address by name (no DNS rebinding), and no cross-site writes.
    if (!allowedHosts.has(req.headers.host || '')) return send(res, 421, { error: 'Host 不被接受' });
    if (req.method !== 'GET' && req.headers.origin && !allowedHosts.has(new URL(req.headers.origin).host)) {
      return send(res, 403, { error: '不接受跨站请求' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      await route(req, res, url);
    } catch (e) {
      const status = e instanceof InputError ? 400 : e.status && e.status < 600 ? e.status : 500;
      if (!res.headersSent) send(res, status, { error: e.message });
    }
  });
  server.listen(config.port, config.host, () => console.log(`maa-daily: http://${config.host}:${config.port}/`));
  startScheduler();
}
