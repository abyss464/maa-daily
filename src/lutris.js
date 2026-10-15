// A Wine game as Lutris manages it: its prefix, Wine build and environment, read from the game's
// Lutris config at every launch, so Lutris stays the one place the game is set up.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const DB = path.join(HOME, '.local/share/lutris/pga.db');
const GAMES = path.join(HOME, '.config/lutris/games');
const RUNNERS = path.join(HOME, '.local/share/lutris/runners/wine');

// Lutris writes plain YAML; the few keys needed here are read without a YAML library.
function yamlValue(text, section, key) {
  const lines = text.split('\n');
  let inSection = section === null;
  for (const line of lines) {
    if (section !== null && /^\S/.test(line)) inSection = line.startsWith(`${section}:`);
    if (!inSection) continue;
    const m = new RegExp(`^\\s+${key}:\\s*(.*)$`).exec(line);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function yamlEnv(text, section) {
  const env = {};
  const lines = text.split('\n');
  let inSection = false;
  let inEnv = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inSection = line.startsWith(`${section}:`);
      inEnv = false;
      continue;
    }
    if (!inSection) continue;
    if (/^ {2}env:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv) {
      const m = /^ {4}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
      else if (/^ {2}\S/.test(line)) inEnv = false;
    }
  }
  return env;
}

export function lutrisGame(slug) {
  let configPath;
  try {
    configPath = execFileSync('sqlite3', [DB, `select configpath from games where slug = '${slug.replace(/'/g, "''")}' and installed = 1`], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('读不到 Lutris 的游戏库');
  }
  if (!configPath) throw new Error(`Lutris 里没有已安装的游戏 ${slug}`);
  const text = fs.readFileSync(path.join(GAMES, `${configPath}.yml`), 'utf8');
  const prefix = yamlValue(text, 'game', 'prefix');
  if (!prefix) throw new Error(`Lutris 游戏 ${slug} 没有 Wine 前缀`);
  // the program Lutris starts the game with (for a game with its own launcher, the launcher)
  const exe = yamlValue(text, 'game', 'exe');
  const globalWine = fs.existsSync(path.join(HOME, '.config/lutris/runners/wine.yml'))
    ? fs.readFileSync(path.join(HOME, '.config/lutris/runners/wine.yml'), 'utf8') : '';
  const version = yamlValue(text, 'wine', 'version') || yamlValue(globalWine, 'wine', 'version');
  const wine = path.join(RUNNERS, version || '', 'files/bin/wine');
  if (!version || !fs.existsSync(wine)) throw new Error(`找不到 Lutris 为 ${slug} 配置的 Wine：${version || '未设置'}`);
  const locale = yamlValue(text, 'system', 'locale') || yamlValue(globalWine, 'system', 'locale');
  return {
    slug,
    prefix,
    exe,
    wine,
    wineserver: path.join(path.dirname(wine), 'wineserver'),
    env: { ...(locale ? { LC_ALL: locale } : {}), ...yamlEnv(globalWine, 'system'), ...yamlEnv(text, 'system') },
  };
}

// Whether one of these Windows programs of this prefix runs anywhere (the owner may be playing).
export function prefixBusy(prefix, ...exes) {
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!exes.some((exe) => cmd.includes(exe))) continue;
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      if (env.includes(`WINEPREFIX=${prefix}\0`) || env.includes(`WINEPREFIX=${prefix}/\0`)) return Number(pid);
    } catch {}
  }
  return 0;
}
