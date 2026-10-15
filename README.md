# maa-daily

Arknights and Arknights: Endfield dailies for several accounts, run while the computer is idle (by CPU, GPU and memory load) by [MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights)
inside a Windows machine from the local [windows pool](../windows-pool), and managed from a web page
at <http://127.0.0.1:30019/>, and from outside at <https://maa.home.nightabyss.com/> (home Caddy behind
Authelia, admins only; the remote viewer opens only from the local page).

- **Where the game runs.** A persistent pool instance (`arknights`, 16 GB, 8 CPUs) holds MuMu
  (Android 15, 1280×720, nested KVM, software rendering), the official and Bilibili clients, MAA
  (`C:\maa\MAA`) and an embedded Python (`C:\maa\python`).
- **Endfield.** The PC client from its Lutris prefix (the Lutris game `arknight`, the official
  launcher's install; prefix, Wine build and environment are read from Lutris at every launch) runs
  under Wine in a screen of the hypr-screens pool, on the real GPU and invisible. MaaEnd, from our own
  branch (`~/Code/vendor/MaaEnd`, branch `maa-daily`, see its `MAA-DAILY.md`), drives it with its CLI
  through the `Linux-Wlroots` controller, account after account. Each account is one MaaEnd
  `AutoPlay` task whose flow controller runs a plan the service writes
  (`~/.local/share/maa-daily/flow/<account>.plan.json`: switching to the account when several share
  the game, the account's enabled tasks with their options resolved as MaaPiCli resolves them, then
  "推进任务" for the configured minutes) and reports every step as a JSON line
  (`<account>.report.jsonl`), which the run log and chains are built from. "推进任务" is MaaEnd's player
  state machine on a virtual pad (it skips story and follows the tracked quest; see `MAA-DAILY.md`);
  it needs write access to `/dev/uinput`, and 0 minutes turns it off.
  `endfield/link-runtime.sh` lays the built MaaEnd out the way its CLI wants it.
  The game starts as a player starts it, with the program Lutris starts it with, the official
  launcher (the client refuses to start on its own): MaaEnd's `AutoPlayLauncher` task does what the
  launcher's button says, installing an update first when there is one, and starts the game; the
  launcher is then moved to a hidden workspace of the screen, and the SDK's window (login,
  agreements) floats over the game. When the game quits during a run (it asks for a restart once an
  update's resources are in) or cannot reach the open world, it is restarted once from the launcher
  and the account runs again. The client's anti-cheat (ACE) needs a Wine build that carries its
  fixes: dwproton 11.0-13 or later for the 1.6 client.
  A run skips Endfield when the game or its launcher already runs in that prefix (the owner
  playing). For a login, a new agreement or a tutorial MaaEnd does not handle, "打开终末地（用于操作）"
  starts the game the same way in a pool screen worked from the pool's browser viewer; a run never
  enters credentials or agrees to anything itself.
- **When it runs.** While the computer is idle by load, not by input: every 10 s the service samples
  the CPU share of everything except the run itself (the guest container's cgroup, and the
  processes marked `MAA_DAILY_OWN=1`: Endfield and MaaEnd; their GPU time comes from DRM fdinfo), the busiest GPU (`gpu_busy_percent`), and the
  memory the guest has or could get. Idle means the averages over the configured minutes stay within
  the limits (default CPU 35 %, GPU 40 %, guest RAM + 8 GB free, 5 minutes). The run takes the accounts
  that are due: not successful since the CN daily reset (04:00 UTC+8) or for the configured hours, and
  not inside the retry delay after a failure. Load above the limits for two minutes (or less than
  2 GB of memory left) stops an idle run; the accounts it did not finish are marked yielded and stay
  due. A run started from the page is not stopped by load.
- **A run.** The service boots the instance if it is off, starts MuMu in the desktop session, copies `guest/runner.py` and the job in, and streams the
  runner over SSH. The runner drives MaaCore through MAA's Python binding: for each enabled account in
  list order, `StartUp` (switching to the account by its login name) and the account's tasks (Fight,
  Recruit, Infrast, Mall, Award), reporting every event as a `@@ {json}` line. Afterwards the service
  shuts MuMu and Windows down again when the run was what booted them.
- **Accounts.** MAA switches only between accounts that have logged in on this emulator: each account is
  logged in once by hand ("打开游戏（用于登录）", then the remote viewer), and its login name fragment
  (e.g. the phone number's last four digits) goes into the account. An account's tasks are MAA's own
  task parameters; the page edits the common ones and shows the full JSON for the rest.
- **Records.** `~/.local/share/maa-daily/`: `state.json` (settings, accounts), `runs/<id>.json`
  (status, per-account chains, battles, stages, drops, recruits) and `runs/<id>.log`. Statistics are
  computed from the run records.

## Interfaces

The page, and the HTTP API it uses (`src/server.js` lists the routes): state, settings, accounts,
run / stop / prepare / shutdown, runs with logs, statistics, the guest's screen.

## Running

```sh
ln -s ~/Code/apps/maa-daily/deploy/maa-daily.service ~/.config/systemd/user/
systemctl --user enable --now maa-daily.service
```

Needs `windows-pool.service` and its persistent instance `arknights` prepared as above. MAA updates:
replace `C:\maa\MAA` with a newer `MAA-*-win-x64.zip`; activity stage data is fetched on every run.
