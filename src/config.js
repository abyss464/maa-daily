// Where maa-daily listens, keeps its data, and finds the Windows guest it drives.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const int = (name, dflt) => (env[name] ? Number.parseInt(env[name], 10) : dflt);

export const config = {
  root: ROOT,
  host: '127.0.0.1',
  port: int('MAA_DAILY_PORT', 30019),
  dataDir: env.MAA_DAILY_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'maa-daily'),

  // The Windows pool and the persistent instance that holds MuMu, Arknights and MAA.
  poolUrl: env.WINDOWS_POOL_URL || 'http://127.0.0.1:30018',
  sshKey: path.join(os.homedir(), 'VMs', 'windows-pool', 'secrets', 'id_ed25519'),

  // Inside the guest.
  guest: {
    mumuDir: 'C:\\Program Files\\Netease\\MuMu\\nx_main',
    maaDir: 'C:\\maa\\MAA',
    python: 'C:\\maa\\python\\python.exe',
    runnerDir: 'C:\\maa\\runner',
    address: '127.0.0.1:16384',
  },
};

// Android package of each client, for starting the game by hand before a first login.
export const PACKAGES = {
  Official: 'com.hypergryph.arknights',
  Bilibili: 'com.hypergryph.arknights.bilibili',
};
