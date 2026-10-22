// Arknights, played in the Windows guest: MuMu runs the Android client, and guest/runner.py
// drives MaaCore account by account, streaming its events back over SSH. The guest is booted if
// it was off, and shut down again afterwards when the run was what booted it.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { vm, ps } from '../vm.js';

const RUNNER = path.join(config.root, 'guest', 'runner.py');
const JOBS = path.join(config.dataDir, 'jobs');
fs.mkdirSync(JOBS, { recursive: true, mode: 0o700 });

// The tasks a new account starts with: MAA's own parameters, so the advanced editor shows
// exactly what MAA receives.
export function defaultTasks() {
  return {
    Fight: { enable: true, stage: '1-7', medicine: 0, medicine_expire_days: 0, stone: 0, series: 0, report_to_penguin: false },
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

export function checkTasks(tasks) {
  for (const [k, v] of Object.entries(tasks)) {
    if (!TASK_NAMES.includes(k)) throw new Error(`未知任务：${k}（可用：${TASK_NAMES.join('、')}）`);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`任务 ${k} 的参数必须是 JSON 对象`);
  }
}

export const arknights = {
  id: 'arknights',
  label: '明日方舟',

  async run(ctx, run, accounts) {
    const settings = ctx.settings;
    const ref = settings.instance;
    let wasRunning = true;
    const checkStopped = () => {
      if (ctx.stopping()) throw new Error('运行已停止');
    };
    try {
      checkStopped();
      wasRunning = (await vm.inspect(ref)).status !== 'stopped';
      await vm.ensureRunning(ref, (s) => ctx.stage(s), ctx.stopping);
      const inst = await vm.inspect(ref);
      checkStopped();
      ctx.stage('启动模拟器');
      await vm.mumu(ref, 'launch', ctx.stopping);
      checkStopped();

      const g = config.guest;
      const job = {
        adb: `${g.mumuDir}\\adb.exe`, address: g.address, maa_dir: g.maaDir,
        account_timeout: settings.accountTimeoutMin * 60, close_game: settings.closeGame,
        accounts: accounts.map((a) => ({ id: a.id, name: a.name, client_type: a.client_type, account_name: a.account_name, tasks: a.tasks })),
      };
      const jobFile = path.join(JOBS, `${run.id}.json`);
      fs.writeFileSync(jobFile, JSON.stringify(job), { mode: 0o600 });
      await vm.exec(ref, `New-Item -ItemType Directory -Force ${ps(g.runnerDir)} | Out-Null`);
      checkStopped();
      await vm.cpIn(ref, RUNNER, `${g.runnerDir}\\runner.py`);
      checkStopped();
      await vm.cpIn(ref, jobFile, `${g.runnerDir}\\job.json`);
      fs.rmSync(jobFile, { force: true });
      checkStopped();

      ctx.stage('MAA 运行中');
      let fatal = null;
      let finished = false;
      const child = vm.stream(inst, `& ${ps(g.python)} -u ${ps(`${g.runnerDir}\\runner.py`)} ${ps(`${g.runnerDir}\\job.json`)}`, (line) => {
        if (!line.startsWith('@@ ')) return ctx.log(line);
        let ev;
        try {
          ev = JSON.parse(line.slice(3));
        } catch {
          return ctx.log(line);
        }
        if (ev.ev === 'fatal') fatal = ev.msg;
        if (ev.ev === 'finished') finished = true;
        ctx.event(ev);
      });
      ctx.setChild({
        kill: () => {
          child.kill();
          // Ending the SSH session may leave the guest's Python running: end it there too.
          vm.exec(ref, `Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | ` +
            `Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${ps(`${g.runnerDir}\\runner.py`)}) } | ` +
            `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; 'ok'`).catch(() => {});
        },
      });
      await child.done;
      ctx.setChild(null);
      if (!ctx.stopping() && (fatal || !finished)) throw new Error(fatal || 'MAA 意外退出');
    } finally {
      if (settings.shutdownAfter && !wasRunning) {
        try {
          ctx.stage('关闭模拟器和 Windows');
          if ((await vm.status(ref))?.status === 'ready') await vm.mumu(ref, 'shutdown').catch(() => {});
          await vm.stop(ref);
          ctx.log('Windows 已关机');
        } catch (e) {
          ctx.log(`关机失败：${e.message}`);
        }
      }
    }
  },
};

