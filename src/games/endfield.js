// Arknights: Endfield, played on this machine: the PC client from its Lutris prefix runs under Wine
// in a screen of the hypr-screens pool (invisible, on the real GPU), and MaaEnd's CLI drives it
// through the Linux-Wlroots controller, one account after another. MaaEnd is our own branch of it
// (~/Code/vendor/MaaEnd, branch maa-daily), built into its install/ folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { lutrisGame, prefixBusy } from '../lutris.js';
import { screens } from '../screens.js';

const MAAEND = process.env.MAAEND_DIR || path.join(os.homedir(), 'Code/vendor/MaaEnd/install');
// The CLI takes the project from its libraries' folder: the runtime is a folder of links that
// holds both (endfield/link-runtime.sh builds it).
const RUNTIME = path.join(config.dataDir, 'maaend-runtime');
const PREFIX = process.env.MAA_DAILY_ENDFIELD_PREFIX || path.join(config.dataDir, 'endfield-prefix');
const EXE = 'Endfield.exe';
// The target client and its SDK's login/agreements window.
const GAME_TITLE = 'Endfield';
const LAUNCHER_TITLE = '鹰角启动器';
const SDK_TITLE = 'UIPlatform';
// Processes carrying this mark are the run's own (the game, MaaEnd and its agents): the idle
// judgement leaves their load out.
export const OWN_MARK = 'MAA_DAILY_OWN=1';
const MANUAL_LABEL = '终末地（手动）';

// Lutris supplies the runtime and installed files; automation keeps its Windows state separate.
function dailyGame(settings) {
  const game = lutrisGame(settings.endfieldLutrisGame || 'arknight');
  const registry = fs.readFileSync(path.join(game.prefix, 'system.reg'), 'utf8');
  const section = registry.split(/\n\n/).find((s) => s.includes('"Publisher"="Shanghai Hypergryph Network Technology Co., Ltd."'));
  const location = section && /^"InstallLocation"="(.+)"$/m.exec(section)?.[1].replaceAll('\\\\', '\\');
  const install = location && /^C:\\/i.test(location)
    ? path.join(game.prefix, 'drive_c', ...location.slice(3).split('\\'), 'games') : null;
  const folders = install && fs.existsSync(install) ? fs.readdirSync(install) : [];
  const client = path.basename(game.exe || '').toLowerCase() === EXE.toLowerCase() ? game.exe
    : folders.map((name) => path.join(install, name, EXE)).find((p) => fs.existsSync(p));
  if (!client || !fs.existsSync(client)) throw new Error('没有找到已安装的终末地客户端 Endfield.exe');
  const localClient = path.join(PREFIX, path.relative(game.prefix, client));
  const localLauncher = path.join(PREFIX, path.relative(game.prefix, path.join(path.dirname(install), 'Launcher.exe')));
  if (!fs.existsSync(localClient) || !fs.existsSync(localLauncher)) throw new Error('终末地日常的独立运行环境尚未准备好');
  return { ...game, sourcePrefix: game.prefix, prefix: PREFIX, exe: localClient, launcher: localLauncher };
}

function gameBlocked(game) {
  return prefixBusy(game.sourcePrefix, EXE) || prefixBusy(game.prefix, EXE) ? '终末地正在其他窗口运行' : null;
}

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

const gameEnv = (game) => ({ ...game.env, WINEPREFIX: game.prefix, WINEESYNC: '1', WINEFSYNC: '1', WINEDEBUG: '-all',
  DXVK_LOG_LEVEL: 'error', MAA_DAILY_OWN: '1',
  ...(game.proton ? { PROTONPATH: game.proton, PROTON_VERB: 'run', GAMEID: 'umu-endfield', UMU_RUNTIME_UPDATE: '0',
    UMU_FOLDERS_PATH: path.join(os.homedir(), '.local/share') } : {}) });

// A shell command starting a Windows program of the game's prefix from its own folder.
function wineCommand(game, exe, args = []) {
  const envArgs = Object.entries(gameEnv(game)).map(([k, v]) => `${k}=${sh(v)}`).join(' ');
  const log = path.join(config.dataDir, 'endfield-client.log');
  const runtime = game.proton ? game.umu : game.wine;
  const command = [exe, ...args].map(sh).join(' ');
  return `sh -c ${sh(`cd ${sh(path.dirname(exe))} && exec env ${envArgs} ${sh(runtime)} ${command} > ${sh(log)} 2>&1`)}`;
}

function killGame(game) {
  const prefix = fs.realpathSync(game.prefix);
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (!env.includes(OWN_MARK)) continue;
      const ownPrefix = env.find((v) => v.startsWith('WINEPREFIX='))?.slice('WINEPREFIX='.length);
      if (!ownPrefix || fs.realpathSync(ownPrefix) !== prefix) continue;
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0];
      // Shared Wine infrastructure may also serve a different game in the same prefix.
      if (/wineserver|services\.exe|winedevice\.exe|rpcss\.exe/i.test(command)) continue;
      process.kill(Number(pid), 'SIGTERM');
    } catch {}
  }
}

// Whether a window of this title is on the screen within the time given (present = false: whether
// none is).
async function waitWindow(screenId, title, seconds, present = true, stopping = () => false) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    if (stopping()) throw new Error('运行已停止');
    const found = await screens.get(screenId).then((x) => x.windows.some((w) => w.title === title ||
      (title === GAME_TITLE && w.title.startsWith(`${GAME_TITLE} - `))), () => false);
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

  blocked(settings) {
    if (this.activeScreen) return null;
    try {
      const game = dailyGame(settings);
      return gameBlocked(game);
    } catch (e) {
      return e.message;
    }
  },

  async run(ctx, run, accounts) {
    const settings = ctx.settings;
    const cat = catalog();
    if (!cat.available) throw new Error(cat.error);
    if (!fs.existsSync(path.join(RUNTIME, 'maafw', 'MaaPiCli'))) throw new Error('MaaEnd 运行目录没有建好：运行 endfield/link-runtime.sh');
    const game = dailyGame(settings);
    if (!game.exe || !fs.existsSync(game.exe)) throw new Error(`Lutris 里终末地的启动程序不存在：${game.exe || '未设置'}`);
    if (gameBlocked(game)) throw new Error(gameBlocked(game));

    ctx.stage('申请屏幕');
    const screen = await screens.open({ width: 1280, height: 720, label: '终末地日常', ttl: (accounts.length * settings.accountTimeoutMin + 120) * 60 });
    this.activeScreen = screen.id;
    try {
      if (ctx.stopping()) throw new Error('运行已停止');
      ctx.stage('启动终末地');
      await this.startGame(ctx, screen, game);
      ctx.log(`终末地已启动（屏幕 ${screen.id}）`);

      let restarted = false;
      for (const acc of accounts) {
        if (ctx.stopping()) break;
        ctx.event({ ev: 'account', account: acc.id, phase: 'start' });
        const started = Date.now();
        let attempt = await this.runAccount(ctx, acc, screen, cat, accounts.length > 1);
        // Retry the target client once if it exits or fails to enter the open world.
        // The SDK's window still up means the game waits for a person (a login, a new agreement):
        // a run never answers it, and a restart would not either.
        const waitsForPerson = attempt.track.enterFailed && (await waitWindow(screen.id, SDK_TITLE, 0));
        if (waitsForPerson) ctx.log('终末地在等人登录或同意新协议：在面板上「打开终末地」处理后，下一轮会接着跑', acc.name);
        if ((attempt.gone || attempt.track.enterFailed) && !waitsForPerson && !restarted && !ctx.stopping()) {
          restarted = true;
          ctx.log(`${attempt.gone ? '游戏退出了' : '进不了大世界'}：重启终末地，再试一次`, acc.name);
          killGame(game);
          ctx.stage('重启终末地');
          await this.startGame(ctx, screen, game);
          attempt = await this.runAccount(ctx, acc, screen, cat, accounts.length > 1);
        }
        if (ctx.stopping()) break;
        const result = this.outcome(ctx, acc, attempt);
        ctx.event({ ev: 'account', account: acc.id, phase: 'end', ...result, seconds: Math.round((Date.now() - started) / 1000) });
      }
    } finally {
      this.activeScreen = null;
      ctx.stage('关闭终末地');
      killGame(game);
      await screens.close(screen.id);
    }
  },

  // Launch the target client in its own screen; other games and their launchers stay independent.
  async startGame(ctx, screen, game) {
    const checkStopped = () => {
      if (ctx.stopping()) throw new Error('运行已停止');
    };
    checkStopped();
    await screens.hyprctl(screen.id, `keyword windowrule float on, match:title ^(${SDK_TITLE})$`);
    checkStopped();
    await screens.launch(screen.id, wineCommand(game, game.launcher, ['--game=endfield', '--reason=4']), 0);
    checkStopped();
    if (!(await waitWindow(screen.id, LAUNCHER_TITLE, 90, true, ctx.stopping))) {
      const log = fs.readFileSync(path.join(config.dataDir, 'endfield-client.log'), 'utf8').trim();
      if (log) ctx.log(log.slice(-2000));
      throw new Error('终末地客户端没有打开，见运行记录中的客户端输出');
    }
    checkStopped();
    ctx.stage('启动终末地客户端');
    const report = path.join(config.dataDir, 'flow', 'launcher.report.jsonl');
    const result = await this.runPi(ctx, screen, { task: 'AutoPlayLauncher', limitMin: 90, report, onEvent: (ev) => {
      if (ev.ev === 'launcher' && ev.state === 'update') ctx.log('终末地客户端需要更新，正在更新');
    } });
    checkStopped();
    if (result.timedOut || !prefixBusy(game.prefix, EXE)) throw new Error('终末地客户端未能启动，见目标屏幕画面');
    if (!(await waitWindow(screen.id, GAME_TITLE, 90, true, ctx.stopping))) throw new Error('终末地客户端没有显示游戏窗口');
    await screens.hyprctl(screen.id, `dispatch movetoworkspacesilent special:launcher,title:^(${LAUNCHER_TITLE})$`);
    await screens.hyprctl(screen.id, `dispatch focuswindow title:^(${GAME_TITLE})$`);
    await screens.hyprctl(screen.id, 'dispatch fullscreenstate 2 2');
  },

  // One MaaEnd task through its CLI on this screen, ended after limitMin minutes, or as soon as
  // alive() (asked every 10 seconds) answers false twice running; the run report it writes is
  // handed to onEvent line by line as it grows.
  async runPi(ctx, screen, { task, env = {}, limitMin, report: reportFile, onEvent, alive }) {
    if (ctx.stopping()) throw new Error('运行已停止');
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
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
    } finally {
      clearInterval(watch);
      clearInterval(check);
      clearTimeout(timer);
      ctx.setChild(null);
      read();
    }
    return { timedOut, gone };
  },

  // The game opened for a person (a first login, a new agreement, a tutorial MaaEnd does not
  // handle), in a pool screen watched and worked from the pool's browser viewer, until
  // closeForUser. It starts as for a run, so an update is installed first.
  manualScreen: null,

  async openForUser(settings, stage = () => {}) {
    if (this.manualScreen) return screens.get(this.manualScreen);
    const game = dailyGame(settings);
    if (!game.exe || !fs.existsSync(game.exe)) throw new Error(`Lutris 里终末地的启动程序不存在：${game.exe || '未设置'}`);
    if (gameBlocked(game)) throw new Error(gameBlocked(game));
    const screen = await screens.open({ width: 1280, height: 720, label: MANUAL_LABEL, ttl: 3 * 3600, held: false });
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
    killGame(dailyGame(settings));
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
