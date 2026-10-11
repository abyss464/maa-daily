// The Windows guest, reached through the Windows pool: boot and shut it down, run PowerShell
// in it, copy files in, and stream a long command over SSH.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, path, body, timeoutMs = 0) {
  const url = new URL(path, config.poolUrl);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        } catch {
          data = { message: Buffer.concat(chunks).toString('utf8') };
        }
        if (res.statusCode >= 400) {
          const e = new Error(data?.message || `Windows 虚拟机池返回 ${res.statusCode}`);
          e.status = res.statusCode;
          reject(e);
        } else resolve(data);
      });
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('Windows 虚拟机池没有响应')));
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error('Windows 虚拟机池服务没有运行（windows-pool.service）') : e));
    if (payload) req.write(payload);
    req.end();
  });
}

const enc = encodeURIComponent;
const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;

export const vm = {
  inspect: (ref) => call('GET', `/api/instances/${enc(ref)}`, undefined, 15_000),

  async status(ref) {
    try {
      return await vm.inspect(ref);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },

  // Boots the instance if needed and waits until Windows answers. Returns whether it was
  // already running.
  async ensureRunning(ref, onWait = () => {}) {
    let inst = await vm.inspect(ref);
    if (inst.status === 'ready') return true;
    if (inst.status === 'stopped') {
      onWait('启动 Windows 虚拟机');
      await call('POST', `/api/instances/${enc(ref)}/start`, {});
    }
    const end = Date.now() + 10 * 60_000;
    while (Date.now() < end) {
      await sleep(5000);
      inst = await vm.inspect(ref);
      if (inst.status === 'ready') return false;
    }
    throw new Error(`Windows 虚拟机 10 分钟内没有就绪（状态：${inst.status}）`);
  },

  stop: (ref) => call('POST', `/api/instances/${enc(ref)}/stop`, {}),

  async exec(ref, command, { desktop = false, timeout = 300 } = {}) {
    const r = await call('POST', `/api/instances/${enc(ref)}/exec`, { command, desktop, timeout });
    if (r.exit_code !== 0) throw new Error(`虚拟机命令失败（${r.exit_code}）：${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
    return r.stdout;
  },

  async cpIn(ref, hostPath, guestPath) {
    await call('POST', `/api/instances/${enc(ref)}/cp`, { direction: 'to_guest', host_path: hostPath, guest_path: guestPath });
  },

  async screenshot(ref) {
    const r = await call('POST', `/api/instances/${enc(ref)}/screenshot`, {}, 30_000);
    return Buffer.from(r.png_base64, 'base64');
  },

  // MuMu is a desktop program: start and stop it in the logged-on session. Right after boot
  // SSH answers before the automatic logon has finished, so a first failure is retried.
  async mumu(ref, action) {
    const m = `${config.guest.mumuDir}\\MuMuManager.exe`;
    for (let i = 0; ; i++) {
      try {
        return await vm.exec(ref, `& ${ps(m)} control -v 0 ${action}`, { desktop: true, timeout: 120 });
      } catch (e) {
        if (i >= 5) throw e;
        await sleep(15_000);
      }
    }
  },

  // Waits for Android in the emulator, then starts the game client.
  startGame(ref, pkg) {
    const adb = ps(`${config.guest.mumuDir}\\adb.exe`);
    const addr = ps(config.guest.address);
    return vm.exec(ref, `$ok = $false; for ($i = 0; $i -lt 100; $i++) { & ${adb} connect ${addr} | Out-Null; ` +
      `if ((& ${adb} -s ${addr} shell getprop sys.boot_completed 2>$null) -eq '1') { $ok = $true; break }; Start-Sleep 3 }; ` +
      `if (-not $ok) { throw 'emulator did not boot' }; ` +
      `& ${adb} -s ${addr} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 | Out-Null; 'started'`, { timeout: 400 });
  },

  // Runs a command over SSH, calling onLine for each line of its output. Resolves with the
  // exit code; the returned object's kill() ends it.
  stream(inst, command, onLine) {
    const args = ['-i', config.sshKey, '-p', String(inst.ssh_port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30', `${inst.user || 'pool'}@127.0.0.1`, command];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const done = new Promise((resolve) => child.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim());
      resolve(code);
    }));
    return { done, kill: () => child.kill('SIGTERM') };
  },
};

export { ps };
