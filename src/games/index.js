// The games maa-daily plays. Each driver runs a list of its accounts within one run, reporting
// through the run's context (log, stage, events, the child to stop); each account names its game.

import { arknights, defaultTasks as arknightsTasks, checkTasks as arknightsCheck } from './arknights.js';
import { endfield, defaultTasks as endfieldTasks, checkTasks as endfieldCheck, catalog } from './endfield.js';

Object.assign(arknights, { defaultTasks: arknightsTasks, checkTasks: arknightsCheck });
Object.assign(endfield, { defaultTasks: endfieldTasks, checkTasks: endfieldCheck, catalog });

export const GAMES = { arknights, endfield };
export const gameOf = (account) => GAMES[account.game || 'arknights'];
