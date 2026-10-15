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
const EXE = 'Endfield.exe';
// The client starts only from the official launcher, whose window carries this title; the game's
// window and its SDK's (login, agreements) carry these.
const LAUNCHER_TITLE = '鹰角启动器';
const GAME_TITLE = 'Endfield';
const SDK_TITLE = 'UIPlatform';
// An update of the client downloads and installs several GB: the launcher gets this long.
const LAUNCHER_LIMIT_MIN = 90;
// Processes carrying this mark are the run's own (the game, MaaEnd and its agents): the idle
// judgement leaves their load out.
export const OWN_MARK = 'MAA_DAILY_OWN=1';
const MANUAL_LABEL = '终末地（手动）';

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
  // AutoPlay is the flow controller every run goes through, not a task to pick.
  const linux = tasks.filter((t) => (!t.controller || t.controller.includes('Linux-Wlroots')) && t.name !== 'AutoPlay');
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
    definitions: { tasks: Object.fromEntries(tasks.map((t) => [t.name, t])), options },
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

// A task's pipeline override, resolved from its options as MaaPiCli does: the task's own override,
// then each of the task's options in order, set or not: the chosen case's override (select /
// switch: a string, unset meaning the default case or else the first; checkbox: a list, unset
// meaning the default cases) followed by the options that case opens, or an input option's
// override with its fields filled in (unset fields take their defaults). Overrides apply in order,
// a later one replacing the fields it names on each node, except attach, which merges.
function resolveOverride(cat, name, option = {}) {
  const def = cat.definitions.tasks[name];
  const merged = {};
  const apply = (o) => {
    for (const [node, fields] of Object.entries(o || {})) {
      const prev = merged[node] || {};
      merged[node] = { ...prev, ...fields };
      // as in MaaFramework, attach merges key by key instead of being replaced
      if (prev.attach && fields?.attach) merged[node].attach = { ...prev.attach, ...fields.attach };
    }
  };
  const visit = (key, seen) => {
    const opt = cat.definitions.options[key];
    if (!opt || opt.type === 'hotkey' || seen.has(key)) return;
    seen.add(key);
    const value = option[key];
    if (opt.type === 'input') {
      let text = JSON.stringify(opt.pipeline_override || {});
      for (const input of opt.inputs || []) {
        const v = String(value?.[input.name] ?? input.default ?? '');
        const raw = (input.pipeline_type || 'string') === 'string' ? JSON.stringify(v).slice(1, -1) : v;
        text = text.split(`"{${input.name}}"`).join((input.pipeline_type || 'string') === 'string' ? JSON.stringify(v) : v).split(`{${input.name}}`).join(raw);
      }
      try {
        apply(JSON.parse(text));
      } catch {}
      return;
    }
    const cases = opt.cases || [];
    let chosen;
    if (opt.type === 'checkbox') {
      const names = Array.isArray(value) ? value : Array.isArray(opt.default_case) ? opt.default_case : [];
      chosen = cases.filter((c) => names.includes(c.name));
    } else {
      const pick = value !== undefined && !Array.isArray(value) ? String(value) : (opt.default_case ?? cases[0]?.name);
      chosen = cases.filter((c) => c.name === pick);
    }
    for (const c of chosen) {
      apply(c.pipeline_override);
      for (const sub of c.option || []) visit(sub, seen);
    }
  };
  apply(def?.pipeline_override);
  const seen = new Set();
  for (const key of def?.option || []) visit(key, seen);
  return merged;
}

// The flow controller's plan for one account: switching to it when several accounts share the
// game, then its enabled tasks, each with its options resolved, then playing on for playMinutes
// (the player state machine: skips story, follows the tracked quest) between two rounds of
// claiming what the menus' badges mark (events, mail, the action manual, the pass).
function flowPlan(acc, cat, switchAccount, budgetS, report, playMinutes = 0) {
  const steps = [];
  if (switchAccount && acc.account_name) {
    steps.push({
      id: 'AccountSwitch', label: '切换账号', entry: cat.definitions.tasks.AccountSwitch?.entry || 'AccountSwitchStart', required: true, retries: 1,
      override: resolveOverride(cat, 'AccountSwitch', { AccountSwitchMatchMode: 'LastFourDigits', AccountSwitchLastFourDigits: { LastFourDigits: acc.account_name.slice(-4) } }),
    });
  }
  for (const [name, t] of Object.entries(acc.tasks || {})) {
    const def = cat.tasks.find((x) => x.name === name);
    if (!t.enable || !def) continue;
    steps.push({ id: name, label: def.label, entry: def.entry, override: resolveOverride(cat, name, t.option), retries: 2 });
  }
  if (playMinutes > 0) {
    // claiming what the badges mark before and after playing: playing turns up more to claim
    const badges = (id) => ({ id, label: '🎁领红点奖励', entry: 'AutoPlayBadges', retries: 0 });
    steps.push(badges('Badges'));
    steps.push({
      id: 'Play', label: '🎮推进任务', entry: 'AutoPlayPlayer', retries: 0,
      override: { AutoPlayPlayer: { custom_action_param: { budget_s: playMinutes * 60 } } },
    });
    steps.push(badges('BadgesAfter'));
  }
  return { steps, session_budget_s: budgetS, report };
}

const INTERRUPTS = {
  CheckAnywhere: '「点击任意处继续」', CheckSpecialInfoPanel: '档案 / 语音面板', HandleTutorialPaging: '说明书', HandleTutorialConfirm: '说明书',
  HandleTutorialGuide_RightUp: '新手引导', HandleTutorialGuide_LeftUp: '新手引导', RealTimeAutoSkip: '剧情',
};

// ---- a run ----

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const gameEnv = (game) => ({ ...game.env, WINEPREFIX: game.prefix, WINEESYNC: '1', WINEFSYNC: '1', WINEDEBUG: '-all', DXVK_LOG_LEVEL: 'none', MAA_DAILY_OWN: '1' });

// A shell command starting a Windows program of the game's prefix from its own folder.
function wineCommand(game, exe) {
  const envArgs = Object.entries(gameEnv(game)).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
  return `sh -c ${sh(`cd ${sh(path.dirname(exe))} && exec env ${envArgs} ${sh(game.wine)} ${sh(path.basename(exe))}`)}`;
}

function killPrefix(game) {
  try {
    execFileSync(game.wineserver, ['-k'], { env: { ...process.env, WINEPREFIX: game.prefix }, timeout: 30_000 });
  } catch {}
}

// Whether a window of this title is on the screen within the time given (present = false: whether
// none is).
async function waitWindow(screenId, title, seconds, present = true) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const found = await screens.get(screenId).then((x) => x.windows.some((w) => w.title === title), () => false);
    if (found === present || Date.now() >= until) return found === present;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// The run report's new lines since the last call, each handed to onEvent.
function readLines(file, track, onEvent) {
  try {
    const fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    if (size > track.pos) {
      const buf = Buffer.alloc(size - track.pos);
      fs.readSync(fd, buf, 0, buf.length, track.pos);
      track.pos = size;
      track.rest += buf.toString('utf8');
    }
    fs.closeSync(fd);
  } catch {}
  const lines = track.rest.split('\n');
  track.rest = lines.pop();
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    onEvent(ev);
  }
}

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
    if (!game.exe || !fs.existsSync(game.exe)) throw new Error(`Lutris 里终末地的启动程序不存在：${game.exe || '未设置'}`);
    if (prefixBusy(game.prefix, EXE, path.basename(game.exe))) throw new Error('终末地或它的启动器已经在运行（可能有人在玩），这一轮不运行');

    ctx.stage('申请屏幕');
    const screen = await screens.open({ label: '终末地日常', ttl: (accounts.length * settings.accountTimeoutMin + LAUNCHER_LIMIT_MIN + 30) * 60 });
    this.activeScreen = screen.id;
    try {
      ctx.stage('启动终末地');
      await this.startGame(ctx, screen, game);
      ctx.log(`终末地已启动（屏幕 ${screen.id}）`);

      let restarted = false;
      for (const acc of accounts) {
        if (ctx.stopping()) break;
        ctx.event({ ev: 'account', account: acc.id, phase: 'start' });
        const started = Date.now();
        let attempt = await this.runAccount(ctx, acc, screen, cat, accounts.length > 1);
        // A game that quits (it asks for a restart once an update's resources are in, or quits
        // over an outdated client) or cannot reach the open world (it hangs on a screen nothing
        // handles) is restarted once from the launcher, which first installs an update when there
        // is one, and the account runs again.
        // The SDK's window still up means the game waits for a person (a login, a new agreement):
        // a run never answers it, and a restart would not either.
        const waitsForPerson = attempt.track.enterFailed && (await waitWindow(screen.id, SDK_TITLE, 0));
        if (waitsForPerson) ctx.log('终末地在等人登录或同意新协议：在面板上「打开终末地」处理后，下一轮会接着跑', acc.name);
        if ((attempt.gone || attempt.track.enterFailed) && !waitsForPerson && !restarted && !ctx.stopping()) {
          restarted = true;
          ctx.log(`${attempt.gone ? '游戏退出了' : '进不了大世界'}：从启动器重启终末地（有新版本就先更新），再试一次`, acc.name);
          killPrefix(game);
          ctx.stage('重启终末地');
          await this.startGame(ctx, screen, game);
          attempt = await this.runAccount(ctx, acc, screen, cat, accounts.length > 1);
        }
        const result = this.outcome(ctx, acc, attempt);
        ctx.event({ ev: 'account', account: acc.id, phase: 'end', ...result, seconds: Math.round((Date.now() - started) / 1000) });
      }
    } finally {
      this.activeScreen = null;
      ctx.stage('关闭终末地');
      killPrefix(game);
      await screens.close(screen.id);
    }
  },

  // The game starts as a player starts it, with the program Lutris starts it with: the official
  // launcher (the client refuses to start on its own). The launcher's task in our MaaEnd branch
  // updates the client when the launcher offers an update and then starts it; the launcher is then
  // put out of sight. The SDK's window (login, agreements) floats over the game instead of taking
  // half of the screen.
  async startGame(ctx, screen, game) {
    // a launcher just killed may still be closing
    await waitWindow(screen.id, LAUNCHER_TITLE, 30, false);
    await screens.hyprctl(screen.id, `keyword windowrule float on, match:title ^(${SDK_TITLE})$`);
    await screens.launch(screen.id, wineCommand(game, game.exe), 90);
    if (!(await waitWindow(screen.id, LAUNCHER_TITLE, 90))) throw new Error('启动器 90 秒内没有打开');
    const report = path.join(config.dataDir, 'flow', 'launcher.report.jsonl');
    for (let attempt = 1; attempt <= 3 && !ctx.stopping(); attempt++) {
      const { timedOut } = await this.runPi(ctx, screen, { task: 'AutoPlayLauncher', limitMin: LAUNCHER_LIMIT_MIN, report, onEvent: (ev) => {
        if (ev.ev === 'launcher' && ev.state === 'update') {
          ctx.stage('更新终末地');
          ctx.log('启动器里有新版本，正在更新终末地');
        }
      } });
      if (timedOut) throw new Error(`启动器 ${LAUNCHER_LIMIT_MIN} 分钟内没有把终末地启动起来（更新没有完成？）`);
      if (await waitWindow(screen.id, GAME_TITLE, 60)) {
        await screens.hyprctl(screen.id, `dispatch movetoworkspacesilent special:launcher,title:^(${LAUNCHER_TITLE})$`);
        await screens.hyprctl(screen.id, `dispatch focuswindow title:^(${GAME_TITLE})$`);
        return;
      }
    }
    if (!ctx.stopping()) throw new Error('启动器没能把终末地启动起来');
  },

  // One MaaEnd task through its CLI on this screen, ended after limitMin minutes, or as soon as
  // alive() (asked every 10 seconds) answers false twice running; the run report it writes is
  // handed to onEvent line by line as it grows.
  async runPi(ctx, screen, { task, env = {}, limitMin, report: reportFile, onEvent, alive }) {
    const maafw = path.join(RUNTIME, 'maafw');
    fs.mkdirSync(path.join(maafw, 'config'), { recursive: true });
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, '');
    const conf = { controller: { name: 'Linux-Wlroots' }, lnx: { wlr_socket_path: screen.wayland_socket }, resource: '官服', task: [{ name: task }] };
    fs.writeFileSync(path.join(maafw, 'config', 'maa_pi_config.json'), JSON.stringify(conf, null, 1));
    const child = spawn(path.join(maafw, 'MaaPiCli'), ['-d'], {
      cwd: maafw, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, LD_LIBRARY_PATH: maafw, MAA_DAILY_OWN: '1', MAA_DAILY_FLOW_REPORT: reportFile,
        // the agents turn the camera through this compositor's virtual pointer (MaaFramework's Wlr input has no relative move)
        MAAEND_WLR_SOCKET: screen.wayland_socket, ...env },
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
      kill();
    }, limitMin * 60_000);
    let gone = false;
    let missed = 0;
    const check = alive && setInterval(async () => {
      missed = (await alive()) ? 0 : missed + 1;
      if (missed >= 2 && !gone) {
        gone = true;
        kill();
      }
    }, 10_000);
    const track = { pos: 0, rest: '' };
    const read = () => readLines(reportFile, track, onEvent);
    const watch = setInterval(read, 2000);
    await new Promise((resolve) => child.on('close', resolve));
    clearInterval(watch);
    clearInterval(check);
    clearTimeout(timer);
    ctx.setChild(null);
    read();
    return { timedOut, gone };
  },

  // The game opened for a person (a first login, a new agreement, a tutorial MaaEnd does not
  // handle), in a pool screen watched and worked from the pool's browser viewer, until
  // closeForUser. It starts as for a run, so an update is installed first.
  manualScreen: null,

  async openForUser(settings, stage = () => {}) {
    if (this.manualScreen) return screens.get(this.manualScreen);
    const game = lutrisGame(settings.endfieldLutrisGame || 'arknight');
    if (!game.exe || !fs.existsSync(game.exe)) throw new Error(`Lutris 里终末地的启动程序不存在：${game.exe || '未设置'}`);
    if (prefixBusy(game.prefix, EXE, path.basename(game.exe))) throw new Error('终末地或它的启动器已经在运行');
    const screen = await screens.open({ label: MANUAL_LABEL, ttl: 3 * 3600, held: false });
    this.manualScreen = screen.id;
    await this.startGame({ log: () => {}, stage, stopping: () => false, setChild: () => {} }, screen, game);
    return screens.get(screen.id);
  },

  // After a restart of this service: the screen it had opened for a person, if still there.
  async rediscover() {
    try {
      const found = (await screens.list()).find((x) => x.owner === 'maa-daily' && x.label === MANUAL_LABEL);
      this.manualScreen = found?.id || null;
    } catch {}
  },

  async closeForUser(settings) {
    killPrefix(lutrisGame(settings.endfieldLutrisGame || 'arknight'));
    if (this.manualScreen) await screens.close(this.manualScreen);
    this.manualScreen = null;
  },

  // One account: MaaEnd's flow controller runs the account's plan (see AutoPlay in our MaaEnd
  // branch), and reports each step to a file read here.
  async runAccount(ctx, acc, screen, cat, switchAccount) {
    const dir = path.join(config.dataDir, 'flow');
    fs.mkdirSync(dir, { recursive: true });
    const planFile = path.join(dir, `${acc.id}.plan.json`);
    const reportFile = path.join(dir, `${acc.id}.report.jsonl`);
    // The controller ends itself a little before the hard limit below.
    const budgetS = Math.max(300, ctx.settings.accountTimeoutMin * 60 - 180);
    const plan = flowPlan(acc, cat, switchAccount, budgetS, reportFile, ctx.settings.endfieldPlayMinutes ?? 0);
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 1));
    ctx.log(`计划：${plan.steps.map((st) => st.label).join(' → ') || '（没有启用的任务）'}`, acc.name);

    const track = { chains: {}, ended: null, enterFailed: false };
    const { timedOut, gone } = await this.runPi(ctx, screen, {
      task: 'AutoPlay', env: { MAA_DAILY_FLOW_PLAN: planFile }, limitMin: ctx.settings.accountTimeoutMin, report: reportFile,
      onEvent: (ev) => this.onReport(ctx, acc, ev, track),
      // the game quits by itself after an update's resources are in, asking to be restarted
      alive: () => waitWindow(screen.id, GAME_TITLE, 0),
    });
    if (timedOut) ctx.log(`运行超过 ${ctx.settings.accountTimeoutMin} 分钟，强制停止`, acc.name);
    if (gone) ctx.log('终末地的窗口没了（游戏退出了），停下这一轮流程', acc.name);
    if (!track.ended && !gone) ctx.log('流程控制器没有正常结束', acc.name);
    return { plan, track, timedOut, gone };
  },

  // An account's outcome from its last attempt: the steps it never finished count as errors.
  outcome(ctx, acc, { plan, track, timedOut }) {
    const wanted = plan.steps.map((st) => st.id);
    for (const n of wanted) {
      if (!track.chains[n] || track.chains[n] === 'start') {
        track.chains[n] = 'error';
        ctx.event({ ev: 'chain', account: acc.id, chain: n, state: 'error', label: plan.steps.find((st) => st.id === n)?.label });
      }
    }
    const done = wanted.filter((n) => track.chains[n] === 'done');
    const ok = Boolean(track.ended) && done.length === wanted.length;
    return { ok, chains: track.chains, timed_out: timedOut, partial: !ok && done.length > 0 && track.chains.AccountSwitch !== 'error' };
  },

  // One transition of the controller's report.
  onReport(ctx, acc, ev, track) {
    if (ev.ev === 'step') {
      if (ev.id === 'EnterWorld') {
        if (ev.state === 'skipped') {
          track.enterFailed = true;
          ctx.log(`无法进入大世界：${ev.reason || ''}`, acc.name);
        }
        return;
      }
      if (ev.state === 'retry') {
        ctx.log(`${ev.label} 第 ${ev.attempt} 次没成功（${ev.reason}），清理画面、回到大世界后重试`, acc.name);
        return;
      }
      const state = ev.state === 'skipped' ? 'error' : ev.state;
      track.chains[ev.id] = state;
      ctx.event({ ev: 'chain', account: acc.id, chain: ev.id, state, label: ev.label });
      if (ev.state === 'skipped') ctx.log(`${ev.label} 跳过：${ev.reason || ''}`, acc.name);
    } else if (ev.ev === 'interrupt') {
      ctx.log(`处理了${INTERRUPTS[ev.node] || ev.node}`, acc.name);
    } else if (ev.ev === 'recover' && !ev.ok) {
      ctx.log('回到大世界失败', acc.name);
    } else if (ev.ev === 'badges') {
      ctx.log(`跟着红点点了 ${ev.clicks} 处`, acc.name);
    } else if (ev.ev === 'play') {
      ctx.log(`推进任务 ${Math.round(ev.seconds / 60)} 分钟：任务目标推进 ${ev.advances} 次`, acc.name);
    } else if (ev.ev === 'session' && ev.phase === 'end') {
      track.ended = ev;
      ctx.log(`流程结束：完成 ${ev.done} 项，跳过 ${ev.skipped} 项${ev.reason ? `（${ev.reason}）` : ''}`, acc.name);
    }
  },
};
