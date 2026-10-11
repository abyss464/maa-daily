# maa-daily

Arknights dailies for several accounts, run on a schedule by [MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights)
inside a Windows machine from the local [windows pool](../windows-pool), and managed from a web page
at <http://127.0.0.1:30019/>.

- **Where the game runs.** A persistent pool instance (`arknights`, 16 GB, 8 CPUs) holds MuMu
  (Android 15, 1280×720, nested KVM, software rendering), the official and Bilibili clients, MAA
  (`C:\maa\MAA`) and an embedded Python (`C:\maa\python`).
- **A run.** At each configured time of day (or from the page) the service boots the instance if it
  is off, starts MuMu in the desktop session, copies `guest/runner.py` and the job in, and streams the
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
