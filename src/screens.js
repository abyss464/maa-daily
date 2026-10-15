// Screens from the local hypr-screens pool: invisible Hyprland desktops on the real GPU, where
// PC games run under Wine while MaaEnd drives them.

import http from 'node:http';

const POOL = process.env.HYPR_SCREENS_URL || 'http://127.0.0.1:30021';

function call(method, path, body, timeoutMs = 120_000) {
  const url = new URL(path, POOL);
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
          data = { error: Buffer.concat(chunks).toString('utf8') };
        }
        if (res.statusCode >= 400) reject(Object.assign(new Error(data?.error || `屏幕池返回 ${res.statusCode}`), { status: res.statusCode }));
        else resolve(data);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('屏幕池没有响应')));
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error('屏幕池服务没有运行（hypr-screens.service）') : e));
    if (payload) req.write(payload);
    req.end();
  });
}

export const screens = {
  // A temporary screen, by default held by this service's process: it ends with the service, or
  // after ttl. One opened for a person is not held, so a restart of the service keeps it.
  open: ({ width = 1920, height = 1080, label, ttl, held = true }) =>
    call('POST', '/api/screens', { width, height, owner: 'maa-daily', label, ...(held ? { pid: process.pid } : {}), ttl }),
  list: () => call('GET', '/api/screens', undefined, 15_000).then((r) => r.screens),
  close: (id) => call('DELETE', `/api/screens/${encodeURIComponent(id)}`).catch(() => {}),
  get: (id) => call('GET', `/api/screens/${encodeURIComponent(id)}`, undefined, 15_000),
  launch: (id, command, waitSeconds = 90) =>
    call('POST', `/api/screens/${encodeURIComponent(id)}/launch`, { command, wait_seconds: waitSeconds }, (waitSeconds + 30) * 1000),
  // A hyprctl command against the screen's own Hyprland: window rules, moving windows away.
  hyprctl: (id, command) => call('POST', `/api/screens/${encodeURIComponent(id)}/hyprctl`, { command }, 15_000),
  async screenshot(id) {
    const r = await call('POST', `/api/screens/${encodeURIComponent(id)}/screenshot`, {}, 30_000);
    return Buffer.from(r.png_base64, 'base64');
  },
};
