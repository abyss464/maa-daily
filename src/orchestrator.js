// One operation at a time on the guest: a run (every enabled account through MAA), getting the
// game on screen for a first login, or shutting the guest down. A run boots Windows and the
// emulator if needed, streams the guest runner's events into its record, and shuts down again
// afterwards when it was the one that booted Windows.

import fs from 'node:fs';
import path from 'node:path';
import { config, PACKAGES } from './config.js';
import { store, runs, newRunId } from './store.js';
import { vm, ps } from './vm.js';

const RUNNER = path.join(config.root, 'guest', 'runner.py');
const JOBS = path.join(config.dataDir, 'jobs');
fs.mkdirSync(JOBS, { recursive: true, mode: 0o700 });

const time = (t = Date.now()) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

function emptyResult(acc) {
  return { name: acc.name, status: 'pending', chains: {}, seconds: 0, battles: 0, stages: {}, drops: {}, recruits: 0, recruitLevels: {}, medicine: 0, stone: 0 };
}

class Orchestrator {
  constructor() {
    this.current = null; // { kind, label, runId, stage, startedAt, stopping, child }
    // A run cut short by a restart of this service.
    for (const r of runs.list()) {
      if (r.status === 'running') {
        r.status = 'interrupted';
        r.error ||= '服务重启，运行被中断';
        r.endedAt ||= new Date().toISOString();
        runs.save(r);
      }
    }
  }

  busy() {
    if (!this.current) return null;
    const { kind, label, runId, trigger, stage, startedAt, stopping } = this.current;
    return { kind, label, runId, trigger, stage, startedAt, stopping: Boolean(stopping) };
  }

  claim(kind, label) {
    if (this.current) throw Object.assign(new Error(`正在${this.current.label}，请等它结束`), { status: 409 });
    this.current = { kind, label, stage: '准备中', startedAt: new Date().toISOString() };
    return this.current;
  }

  stage(text) {
    if (this.current) this.current.stage = text;
    if (this.current?.runId) this.log(this.current.runId, text);
  }

  log(runId, msg, who = '') {
    runs.appendLog(runId, `[${time()}]${who ? ` [${who}]` : ''} ${msg}`);
  }

  // ---- run ----

  startRun(trigger, accountIds = null) {
    const all = store.accounts();
    const accounts = accountIds ? all.filter((a) => accountIds.includes(a.id)) : all.filter((a) => a.enabled);
    if (!accounts.length) throw Object.assign(new Error('没有可运行的账号'), { status: 400 });
    const cur = this.claim('run', '运行日常');
    const run = {
      id: newRunId(), trigger, startedAt: new Date().toISOString(), endedAt: null, status: 'running', error: null,
      order: accounts.map((a) => a.id),
      accounts: Object.fromEntries(accounts.map((a) => [a.id, emptyResult(a)])),
    };
    cur.runId = run.id;
    cur.trigger = trigger;
    runs.save(run);
    this.log(run.id, `开始运行（${TRIGGER[trigger] || trigger}），账号：${accounts.map((a) => a.name).join('、')}`);
    this.execute(run, accounts).finally(() => {
      this.current = null;
    });
    return run;
  }

  async execute(run, accounts) {
    const settings = store.settings();
    const ref = settings.instance;
    let wasRunning = true;
    let inst;
    try {
      wasRunning = await vm.ensureRunning(ref, (s) => this.stage(s));
      inst = await vm.inspect(ref);
      if (this.current.stopping) throw new Error('已手动停止');
      this.stage('启动模拟器');
      await vm.mumu(ref, 'launch');

      const g = config.guest;
      const job = {
        adb: `${g.mumuDir}\\adb.exe`, address: g.address, maa_dir: g.maaDir,
        account_timeout: settings.accountTimeoutMin * 60, close_game: settings.closeGame,
        accounts: accounts.map((a) => ({ id: a.id, name: a.name, client_type: a.client_type, account_name: a.account_name, tasks: a.tasks })),
      };
      const jobFile = path.join(JOBS, `${run.id}.json`);
      fs.writeFileSync(jobFile, JSON.stringify(job), { mode: 0o600 });
      await vm.exec(ref, `New-Item -ItemType Directory -Force ${ps(g.runnerDir)} | Out-Null`);
      await vm.cpIn(ref, RUNNER, `${g.runnerDir}\\runner.py`);
      await vm.cpIn(ref, jobFile, `${g.runnerDir}\\job.json`);
      fs.rmSync(jobFile, { force: true });
      if (this.current.stopping) throw new Error('已手动停止');

      this.stage('MAA 运行中');
      let fatal = null;
      let finished = false;
      const child = vm.stream(inst, `& ${ps(g.python)} -u ${ps(`${g.runnerDir}\\runner.py`)} ${ps(`${g.runnerDir}\\job.json`)}`, (line) => {
        if (!line.startsWith('@@ ')) return this.log(run.id, line);
        let ev;
        try {
          ev = JSON.parse(line.slice(3));
        } catch {
          return this.log(run.id, line);
        }
        if (ev.ev === 'fatal') fatal = ev.msg;
        if (ev.ev === 'finished') finished = true;
        this.onEvent(run, ev);
      });
      this.current.child = child;
      await child.done;
      this.current.child = null;

      const results = Object.values(run.accounts);
      if (this.current.stopping) {
        this.markStopped(run);
      } else if (fatal || !finished) {
        run.status = 'failed';
        run.error = fatal || 'MAA 意外退出';
      } else {
        run.status = results.every((r) => r.status === 'ok') ? 'ok' : results.some((r) => ['ok', 'partial'].includes(r.status)) ? 'partial' : 'failed';
      }
      for (const r of results) if (r.status === 'pending' || r.status === 'running') r.status = r.status === 'running' ? 'failed' : 'skipped';
    } catch (e) {
      if (this.current?.stopping) this.markStopped(run);
      else {
        run.status = 'failed';
        run.error = e.message;
        this.log(run.id, `出错：${e.message}`);
      }
    }
    run.endedAt = new Date().toISOString();
    runs.save(run);
    this.log(run.id, `结束：${STATUS[run.status] || run.status}${run.error ? `（${run.error}）` : ''}`);

    if (settings.shutdownAfter && !wasRunning) {
      try {
        this.stage('关闭模拟器和 Windows');
        await vm.mumu(ref, 'shutdown').catch(() => {});
        await vm.stop(ref);
        this.log(run.id, 'Windows 已关机');
      } catch (e) {
        this.log(run.id, `关机失败：${e.message}`);
      }
    }
  }

  onEvent(run, ev) {
    const acc = ev.account ? run.accounts[ev.account] : null;
    const who = acc?.name || '';
    switch (ev.ev) {
      case 'log':
        this.log(run.id, `${ev.level === 'error' ? '错误：' : ev.level === 'warn' ? '注意：' : ''}${ev.msg}`, who);
        return;
      case 'fatal':
        this.log(run.id, `失败：${ev.msg}`, who);
        break;
      case 'account':
        if (!acc) return;
        if (ev.phase === 'start') {
          acc.status = 'running';
          this.stage(`MAA 运行中：${acc.name}`);
          this.log(run.id, '开始', who);
        } else {
          acc.chains = ev.chains || acc.chains;
          // Some tasks done after a successful start is partial: the day's work is mostly in.
          const doneAny = Object.entries(acc.chains).some(([c, st]) => c !== 'StartUp' && c !== 'CloseDown' && st === 'done');
          acc.status = ev.ok ? 'ok' : acc.chains.StartUp === 'done' && doneAny ? 'partial' : 'failed';
          acc.seconds = ev.seconds || 0;
          if (ev.timed_out) acc.timedOut = true;
          const bad = Object.entries(acc.chains).filter(([, s]) => s !== 'done').map(([c, s]) => `${CHAINS[c] || c}${CHAIN_STATE[s] || s}`);
          this.log(run.id, `完成：${STATUS[acc.status]}，用时 ${Math.round(acc.seconds / 60)} 分钟${bad.length ? `（${bad.join('、')}）` : ''}`, who);
        }
        break;
      case 'chain':
        if (!acc) return;
        acc.chains[ev.chain] = ev.state;
        if (ev.state !== 'start') this.log(run.id, `${CHAINS[ev.chain] || ev.chain}${CHAIN_STATE[ev.state] || ev.state}`, who);
        break;
      case 'drops': {
        if (!acc) return;
        const n = Number(ev.times) || 1;
        acc.battles += n;
        if (ev.stage) acc.stages[ev.stage] = (acc.stages[ev.stage] || 0) + n;
        for (const d of ev.drops || []) if (d.name) acc.drops[d.name] = (acc.drops[d.name] || 0) + (Number(d.n) || 0);
        const list = (ev.drops || []).map((d) => `${d.name}×${d.n}`).join('、');
        this.log(run.id, `作战 ${ev.stage || '?'}${n > 1 ? ` ×${n}` : ''} 掉落：${list || '无'}`, who);
        break;
      }
      case 'recruit':
        if (!acc) return;
        acc.recruits += 1;
        acc.recruitLevels[ev.level] = (acc.recruitLevels[ev.level] || 0) + 1;
        this.log(run.id, `公招：${ev.level} 星 tag（${(ev.tags || []).join('、')}）`, who);
        break;
      case 'medicine':
        if (acc) acc.medicine += Number(ev.count) || 1;
        break;
      case 'stone':
        if (acc) acc.stone += Number(ev.count) || 1;
        break;
      case 'finished':
        break;
      default:
        return;
    }
    runs.save(run);
  }

  // A run stopped by hand, or because the owner came back to an idle run ('yield'). Accounts
  // it interrupted count as yielded, not failed, so they stay due without a retry delay.
  markStopped(run) {
    const yielded = this.current.stopReason === 'yield';
    run.status = yielded ? 'yielded' : 'stopped';
    run.error = yielded ? '电脑有人使用，已让出' : '已手动停止';
    for (const a of Object.values(run.accounts)) {
      if (a.status === 'running') a.status = 'yielded';
      else if (a.status === 'pending') a.status = 'skipped';
    }
  }

  stop(reason = 'manual') {
    if (!this.current) throw Object.assign(new Error('当前没有运行'), { status: 409 });
    if (this.current.kind !== 'run') throw Object.assign(new Error(`正在${this.current.label}，不能停止`), { status: 409 });
    this.current.stopping = true;
    this.current.stopReason = reason;
    if (this.current.runId) this.log(this.current.runId, reason === 'yield' ? '检测到电脑有人使用，停止运行' : '收到停止请求');
    this.current.stage = '正在停止';
    if (this.current.child) {
      this.current.child.kill();
      // Ending the SSH session may leave the guest's Python running: end it there too.
      vm.exec(store.settings().instance, "Get-Process python -ErrorAction SilentlyContinue | Stop-Process -Force; 'ok'").catch(() => {});
    }
    return this.busy();
  }

  // ---- manual operations ----

  prepare(clientType) {
    const pkg = PACKAGES[clientType] || PACKAGES.Official;
    this.claim('prepare', '打开游戏');
    const ref = store.settings().instance;
    (async () => {
      try {
        await vm.ensureRunning(ref, (s) => this.stage(s));
        this.stage('启动模拟器');
        await vm.mumu(ref, 'launch');
        this.stage('启动游戏');
        await vm.startGame(ref, pkg);
        this.lastNotice = { ok: true, msg: '游戏已打开，可以在远程画面里登录', at: new Date().toISOString() };
      } catch (e) {
        this.lastNotice = { ok: false, msg: `打开游戏失败：${e.message}`, at: new Date().toISOString() };
      } finally {
        this.current = null;
      }
    })();
    return this.busy();
  }

  shutdown() {
    this.claim('shutdown', '关机');
    const ref = store.settings().instance;
    (async () => {
      try {
        const inst = await vm.inspect(ref);
        if (inst.status === 'ready') {
          this.stage('关闭模拟器');
          await vm.mumu(ref, 'shutdown').catch(() => {});
        }
        this.stage('关闭 Windows');
        await vm.stop(ref);
        this.lastNotice = { ok: true, msg: 'Windows 已关机', at: new Date().toISOString() };
      } catch (e) {
        this.lastNotice = { ok: false, msg: `关机失败：${e.message}`, at: new Date().toISOString() };
      } finally {
        this.current = null;
      }
    })();
    return this.busy();
  }
}

export const STATUS = { running: '运行中', ok: '成功', partial: '部分成功', failed: '失败', stopped: '已停止', yielded: '已让出', interrupted: '被中断', skipped: '跳过' };
const TRIGGER = { idle: '闲时', manual: '手动' };
const CHAINS = { StartUp: '开始唤醒', Fight: '理智作战', Recruit: '公开招募', Infrast: '基建换班', Mall: '信用商店', Award: '领取奖励', CloseDown: '关闭游戏' };
const CHAIN_STATE = { done: '完成', error: '出错', stopped: '被停止', start: '进行中' };

export const orchestrator = new Orchestrator();
