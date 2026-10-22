"""Runs one day's MAA work for a list of Arknights accounts inside the Windows guest.

Usage: python runner.py JOB.json

The job names the emulator's adb, the MAA folder and the accounts with their tasks. Every
event goes to stdout as one line `@@ {json}`; the host service streams and records them.
Accounts run one after another on the same emulator: StartUp with `account_name` switches to
an account that has logged in on this emulator before.
"""

import json
import os
import subprocess
import sys
import threading
import time

LOCK = threading.Lock()
# The console code page of an SSH session cannot carry Chinese; the host reads UTF-8.
sys.stdout.reconfigure(encoding="utf-8")


def emit(ev, **data):
    with LOCK:
        sys.stdout.write("@@ " + json.dumps({"ev": ev, "t": time.time(), **data}, ensure_ascii=False) + "\n")
        sys.stdout.flush()


# The account being run, so log lines from MAA's callback carry it.
CURRENT = {"id": None, "chains": {}}


def log(msg, level="info"):
    emit("log", level=level, msg=msg, account=CURRENT["id"])


def wait_boot(adb, address, timeout):
    """Waits until Android in the emulator has finished booting."""
    end = time.time() + timeout
    while time.time() < end:
        subprocess.run([adb, "connect", address], capture_output=True, timeout=30)
        r = subprocess.run([adb, "-s", address, "shell", "getprop", "sys.boot_completed"],
                           capture_output=True, text=True, timeout=30)
        if r.stdout.strip() == "1":
            return True
        time.sleep(3)
    return False


def fetch_ota_tasks(maa_dir):
    """Activity stages need MAA's latest tasks.json, loaded as an incremental resource."""
    path = os.path.join(maa_dir, "cache", "resource", "tasks.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Windows' own curl uses the system certificate store, which a fresh guest fills on demand;
    # Python's bundled OpenSSL sees only the roots already present.
    tmp = path + ".part"
    r = subprocess.run(["curl.exe", "-sSfL", "--max-time", "120", "-o", tmp,
                        "https://api.maa.plus/MaaAssistantArknights/api/resource/tasks.json"],
                       capture_output=True, text=True)
    if r.returncode == 0:
        os.replace(tmp, path)
    else:
        log(f"活动关卡资源更新失败：{r.stderr.strip()}", "warn")
    return os.path.join(maa_dir, "cache") if os.path.exists(path) else None


# Android package of each client.
PACKAGES = {"Official": "com.hypergryph.arknights", "Bilibili": "com.hypergryph.arknights.bilibili"}


def adb_shell(adb, address, *cmd):
    return subprocess.run([adb, "-s", address, "shell", *cmd], capture_output=True, text=True, timeout=60).stdout.strip()


def ensure_game(adb, address, client):
    """Starts the account's client unless it is already running, and stops the other client.

    MAA's own start (two `am start` calls in quick succession) leaves a cold-started client on
    the launcher in this emulator; one launcher intent brings it up reliably.
    """
    pkg = PACKAGES.get(client, PACKAGES["Official"])
    for other in PACKAGES.values():
        if other != pkg and adb_shell(adb, address, "pidof", other):
            adb_shell(adb, address, "am", "force-stop", other)
    if adb_shell(adb, address, "pidof", pkg):
        return True
    log("启动游戏")
    adb_shell(adb, address, "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")
    for _ in range(30):
        time.sleep(2)
        if adb_shell(adb, address, "pidof", pkg):
            return True
    return False


# The task chains an account may enable, in the order MAA runs them.
ORDER = ["Fight", "Recruit", "Infrast", "Mall", "Award"]


def build_tasks(acc):
    """MAA task list of one account: StartUp first, then its enabled tasks."""
    client = acc.get("client_type") or "Official"
    t = acc.get("tasks") or {}
    tasks = [("StartUp", {"client_type": client, "start_game_enabled": False,
                          **({"account_name": acc["account_name"]} if acc.get("account_name") else {})})]
    for name in ORDER:
        p = t.get(name)
        if not p or not p.get("enable"):
            continue
        p = {k: v for k, v in p.items() if k != "enable"}
        if name == "Fight":
            p.setdefault("client_type", client)
            p.setdefault("server", "CN")
        tasks.append((name, p))
    return tasks


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        job = json.load(f)
    maa_dir = job["maa_dir"]
    sys.path.insert(0, os.path.join(maa_dir, "Python"))
    from asst.asst import Asst  # noqa: E402
    from asst.utils import InstanceOptionType, Message  # noqa: E402

    adb, address = job["adb"], job["address"]
    log("等待模拟器启动完成")
    if not wait_boot(adb, address, job.get("boot_timeout", 300)):
        emit("fatal", msg="模拟器没有在限定时间内启动完成")
        return 2

    incremental = fetch_ota_tasks(maa_dir)
    user_dir = os.path.join(maa_dir, "runner-data")
    os.makedirs(user_dir, exist_ok=True)
    if not Asst.load(path=maa_dir, incremental_path=incremental, user_dir=user_dir):
        emit("fatal", msg="MAA 资源加载失败")
        return 2

    def handle_callback(current, msg, details, arg):
        if not current["active"]:
            return
        try:
            m = Message(msg)
        except ValueError:
            return
        try:
            d = json.loads(details.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            emit("log", level="error", msg=f"Invalid MAA callback payload: {details!r}",
                 account=current["id"])
            return
        acc = current["id"]

        def callback_log(msg, level="info"):
            emit("log", level=level, msg=msg, account=acc)

        chain = d.get("taskchain")
        if m == Message.ConnectionInfo:
            what = d.get("what")
            if what in ("ConnectFailed", "UnsupportedResolution", "ResolutionError", "Disconnect", "ScreencapFailed"):
                callback_log(f"连接问题：{what} {d.get('why', '')}", "error")
            elif what in ("Connected", "Reconnecting", "Reconnected"):
                callback_log(f"连接：{what}")
        elif m in (Message.TaskChainStart, Message.TaskChainCompleted, Message.TaskChainError, Message.TaskChainStopped):
            state = {Message.TaskChainStart: "start", Message.TaskChainCompleted: "done",
                     Message.TaskChainError: "error", Message.TaskChainStopped: "stopped"}[m]
            if chain:
                # A later completion cannot erase a reported chain failure.
                if current["chains"].get(chain) not in ("error", "stopped"):
                    current["chains"][chain] = state
                emit("chain", account=acc, chain=chain, state=current["chains"][chain])
        elif m == Message.SubTaskError:
            callback_log(f"MAA subtask error: {json.dumps(d, ensure_ascii=False)}", "warn")
        elif m == Message.SubTaskExtraInfo:
            what, det = d.get("what"), d.get("details") or {}
            if what == "StageDrops":
                emit("drops", account=acc, stage=(det.get("stage") or {}).get("stageCode"),
                     stars=det.get("stars"), times=det.get("cur_times") or 1,
                     drops=[{"id": x.get("itemId"), "name": x.get("itemName"), "n": x.get("quantity")}
                            for x in det.get("drops") or []])
            elif what == "RecruitResult":
                emit("recruit", account=acc, level=det.get("level"), tags=det.get("tags"))
            elif what == "RecruitTagsSelected":
                callback_log(f"公招选择：{'、'.join(det.get('tags') or [])}")
            elif what == "ProductOfFacility":
                callback_log(f"基建：{det.get('facility')} {det.get('index')} 产物 {det.get('product')}")
            elif what == "NotEnoughStaff":
                callback_log(f"基建：{det.get('facility')} 可用干员不足", "warn")
            elif what == "UseMedicine":
                emit("medicine", account=acc, count=det.get("count"), expiring=det.get("is_expiring"))
            elif what == "StoneConfirm" or what == "UseStone":
                emit("stone", account=acc, count=det.get("count"))
            elif what == "FightTimes" and det.get("times_finished"):
                callback_log(f"作战：已完成 {det.get('times_finished')} 次")
            elif what == "SanityBeforeStage":
                emit("sanity", account=acc, current=det.get("current_sanity"), max=det.get("max_sanity"))

    account_timeout = job.get("account_timeout", 5400)
    cancellation_timeout = 60
    accounts = job.get("accounts") or []
    # Retain native callback objects until shutdown, including those of stopped accounts.
    instances = []
    for i, acc in enumerate(accounts):
        current = {"id": acc["id"], "chains": {}, "active": True}
        CURRENT["id"] = acc["id"]
        started = time.monotonic()
        deadline = started + account_timeout
        timed_out = False
        cancelled = True
        error = None
        tasks = build_tasks(acc)
        if i == len(accounts) - 1 and job.get("close_game"):
            tasks.append(("CloseDown", {"client_type": acc.get("client_type") or "Official"}))
        requested = [name for name, _ in tasks]

        @Asst.CallBackType
        def callback(msg, details, arg, context=current):
            handle_callback(context, msg, details, arg)

        asst = Asst(callback=callback)
        instances.append((asst, callback, current))
        asst.set_instance_option(InstanceOptionType.touch_type, job.get("touch_type", "maatouch"))

        def stop_and_wait():
            """Do not transfer the shared emulator while native work is still active."""
            asst.stop()
            stop_deadline = time.monotonic() + cancellation_timeout
            while asst.running() and time.monotonic() < stop_deadline:
                time.sleep(0.2)
            return not asst.running()

        def run_phase(phase_tasks):
            nonlocal timed_out, cancelled, error
            for name, params in phase_tasks:
                current["chains"][name] = "pending"
                if not asst.append_task(name, params):
                    current["chains"][name] = "error"
                    error = f"MAA could not append task: {name}"
                    log(error, "error")
                    cancelled = stop_and_wait()
                    return False
            if time.monotonic() >= deadline:
                timed_out = True
                error = f"Account exceeded its {account_timeout} second limit"
                log(error, "error")
                cancelled = stop_and_wait()
                return False
            if not asst.start():
                error = "MAA could not start the task queue"
                log(error, "error")
                cancelled = stop_and_wait()
                return False
            while asst.running():
                if time.monotonic() >= deadline:
                    timed_out = True
                    error = f"Account exceeded its {account_timeout} second limit"
                    log(error, "error")
                    cancelled = stop_and_wait()
                    return False
                if (len(phase_tasks) == 1 and phase_tasks[0][0] == "StartUp"
                        and current["chains"].get("StartUp") in ("error", "stopped")):
                    error = "MAA reported an unsuccessful task chain"
                    log(error, "error")
                    cancelled = stop_and_wait()
                    return False
                time.sleep(0.2)
            incomplete = [name for name, _ in phase_tasks if current["chains"].get(name) != "done"]
            if incomplete:
                error = f"MAA did not complete requested tasks: {', '.join(incomplete)}"
                log(error, "error")
                return False
            return True

        emit("account", account=acc["id"], phase="start", name=acc.get("name"))
        log(f"MAA {asst.get_version()} 连接 {address}")
        if not asst.connect(adb, address, job.get("connect_config", "General")):
            error = "MAA could not connect to the emulator"
            log(error, "error")
        elif not ensure_game(adb, address, acc.get("client_type") or "Official"):
            error = "The game did not start"
            log("游戏没有启动起来", "error")
        elif run_phase(tasks[:1]) and len(tasks) > 1:
            run_phase(tasks[1:])
        # Each native instance owns its immutable account context. Late callbacks from
        # this account cannot update the next account, and are ignored after its end.
        current["active"] = False
        chains = {name: current["chains"].get(name, "not_run") for name in requested}
        failed = [name for name, state in chains.items() if state != "done"]
        ok = not error and not timed_out and not failed
        emit("account", account=acc["id"], phase="end", ok=ok, chains=chains, timed_out=timed_out,
             error=error, seconds=round(time.monotonic() - started))
        if not cancelled:
            emit("fatal", msg=f"MAA is still active {cancellation_timeout} seconds after cancellation; "
                 "remaining accounts were not started")
            return 2
    emit("finished")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 - reported to the host as the run's failure
        emit("fatal", msg=f"{type(e).__name__}: {e}")
        sys.exit(1)
