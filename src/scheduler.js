// Starts a run at each configured local time of day. A time that passes while another
// operation holds the guest, or while this service is down, is recorded as skipped.

import { store, runs, newRunId } from './store.js';
import { orchestrator } from './orchestrator.js';

const fired = new Set();

function tick() {
  const s = store.settings();
  if (!s.enabled) return;
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(now.getHours())}:${p(now.getMinutes())}`;
  if (!s.times.includes(hm)) return;
  const key = `${now.toDateString()} ${hm}`;
  if (fired.has(key)) return;
  fired.add(key);
  try {
    orchestrator.startRun('schedule');
  } catch (e) {
    const at = new Date().toISOString();
    runs.save({ id: newRunId(), trigger: 'schedule', startedAt: at, endedAt: at, status: 'skipped', error: e.message, order: [], accounts: {} });
  }
}

export function startScheduler() {
  setInterval(tick, 15_000);
  tick();
}

// The next time a run will start on its own, as an ISO string, or null.
export function nextRun() {
  const s = store.settings();
  if (!s.enabled || !s.times.length) return null;
  const now = new Date();
  for (let d = 0; d < 2; d++) {
    for (const t of s.times) {
      const [h, m] = t.split(':').map(Number);
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, m);
      if (at > now) return at.toISOString();
    }
  }
  return null;
}
