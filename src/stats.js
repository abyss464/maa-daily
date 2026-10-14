// Statistics over the recorded runs: per account totals (each account's game, its tasks' outcomes,
// and for Arknights battles, drops and recruits), and per day the tasks done and battles fought.

import { store, runs } from './store.js';

const dayOf = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function stats({ days = 30 } = {}) {
  const all = runs.list().filter((r) => r.status !== 'running');
  const since = Date.now() - days * 86400_000;
  const accounts = {};
  const daily = {};
  let total = 0;
  let ok = 0;
  for (const r of all) {
    if (r.status === 'skipped') continue;
    total += 1;
    if (r.status === 'ok') ok += 1;
    const day = dayOf(r.startedAt);
    for (const [id, a] of Object.entries(r.accounts || {})) {
      if (['skipped', 'pending'].includes(a.status)) continue;
      const s = (accounts[id] ||= { id, name: a.name, game: a.game || 'arknights', runs: 0, ok: 0, tasks: {}, tasksDone: 0, battles: 0, seconds: 0, recruits: 0, medicine: 0, stone: 0, drops: {}, stages: {}, lastOk: null, lastRun: null });
      // A yielded account's battles and drops count; the attempt itself does not.
      if (a.status !== 'yielded') s.runs += 1;
      if (a.status === 'ok') {
        s.ok += 1;
        if (!s.lastOk || r.startedAt > s.lastOk) s.lastOk = r.startedAt;
      }
      if (!s.lastRun || r.startedAt > s.lastRun) s.lastRun = r.startedAt;
      s.battles += a.battles || 0;
      s.seconds += a.seconds || 0;
      s.recruits += a.recruits || 0;
      s.medicine += a.medicine || 0;
      s.stone += a.stone || 0;
      for (const [k, v] of Object.entries(a.drops || {})) s.drops[k] = (s.drops[k] || 0) + v;
      for (const [k, v] of Object.entries(a.stages || {})) s.stages[k] = (s.stages[k] || 0) + v;
      let done = 0;
      for (const [c, st] of Object.entries(a.chains || {})) {
        if (['StartUp', 'CloseDown', 'AccountSwitch'].includes(c)) continue;
        const t = (s.tasks[c] ||= { label: a.chainLabels?.[c] || c, done: 0, failed: 0 });
        if (st === 'done') {
          t.done += 1;
          done += 1;
        } else if (st === 'error') t.failed += 1;
      }
      s.tasksDone += done;
      if (Date.parse(r.startedAt) >= since) {
        const dd = (daily[day] ||= { day, battles: 0, runs: 0, tasks: 0 });
        dd.battles += a.battles || 0;
        dd.tasks += done;
      }
    }
    if (Date.parse(r.startedAt) >= since) (daily[day] ||= { day, battles: 0, runs: 0, tasks: 0 }).runs += 1;
  }
  // Current names win over the names recorded in old runs.
  for (const a of store.accounts()) if (accounts[a.id]) Object.assign(accounts[a.id], { name: a.name, game: a.game || 'arknights' });
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOf(new Date(Date.now() - i * 86400_000).toISOString());
    series.push(daily[day] || { day, battles: 0, runs: 0, tasks: 0 });
  }
  return { runs: total, ok, accounts: Object.values(accounts), daily: series };
}
