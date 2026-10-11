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


def log(msg, level="info"):
    emit("log", level=level, msg=msg)


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


# The task chains an account may enable, in the order MAA runs them.
ORDER = ["Fight", "Recruit", "Infrast", "Mall", "Award"]


def build_tasks(acc):
    """MAA task list of one account: StartUp first, then its enabled tasks."""
    client = acc.get("client_type") or "Official"
    t = acc.get("tasks") or {}
    tasks = [("StartUp", {"client_type": client, "start_game_enabled": True,
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

    current = {"id": None, "chains": {}}

    @Asst.CallBackType
    def callback(msg, details, arg):
        try:
            m = Message(msg)
        except ValueError:
            return
        d = json.loads(details.decode("utf-8"))
        acc = current["id"]
        chain = d.get("taskchain")
        if m == Message.ConnectionInfo:
            what = d.get("what")
            if what in ("ConnectFailed", "UnsupportedResolution", "ResolutionError", "Disconnect", "ScreencapFailed"):
                log(f"连接问题：{what} {d.get('why', '')}", "error")
            elif what in ("Connected", "Reconnecting", "Reconnected"):
                log(f"连接：{what}")
        elif m in (Message.TaskChainStart, Message.TaskChainCompleted, Message.TaskChainError, Message.TaskChainStopped):
            state = {Message.TaskChainStart: "start", Message.TaskChainCompleted: "done",
                     Message.TaskChainError: "error", Message.TaskChainStopped: "stopped"}[m]
            if chain:
                current["chains"][chain] = state
                emit("chain", account=acc, chain=chain, state=state)
        elif m == Message.SubTaskError:
            log(f"{chain} 子任务出错：{d.get('subtask', '')} {d.get('details', {})}", "warn")
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
                log(f"公招选择：{'、'.join(det.get('tags') or [])}")
            elif what == "ProductOfFacility":
                log(f"基建：{det.get('facility')} {det.get('index')} 产物 {det.get('product')}")
            elif what == "NotEnoughStaff":
                log(f"基建：{det.get('facility')} 可用干员不足", "warn")
            elif what == "UseMedicine":
                emit("medicine", account=acc, count=det.get("count"), expiring=det.get("is_expiring"))
            elif what == "StoneConfirm" or what == "UseStone":
                emit("stone", account=acc, count=det.get("count"))
            elif what == "FightTimes":
                log(f"作战：第 {det.get('times_finished', '?')} 次")
            elif what == "SanityBeforeStage":
                emit("sanity", account=acc, current=det.get("current_sanity"), max=det.get("max_sanity"))

    asst = Asst(callback=callback)
    asst.set_instance_option(InstanceOptionType.touch_type, job.get("touch_type", "maatouch"))
    log(f"MAA {asst.get_version()} 连接 {address}")
    if not asst.connect(adb, address, job.get("connect_config", "General")):
        emit("fatal", msg="MAA 无法连接模拟器")
        return 2

    account_timeout = job.get("account_timeout", 5400)
    accounts = job.get("accounts") or []
    for i, acc in enumerate(accounts):
        current["id"], current["chains"] = acc["id"], {}
        emit("account", account=acc["id"], phase="start", name=acc.get("name"))
        tasks = build_tasks(acc)
        for name, params in tasks:
            asst.append_task(name, params)
        if i == len(accounts) - 1 and job.get("close_game"):
            asst.append_task("CloseDown", {"client_type": acc.get("client_type") or "Official"})
        asst.start()
        started, timed_out = time.time(), False
        while asst.running():
            if time.time() - started > account_timeout:
                timed_out = True
                log(f"账号运行超过 {account_timeout // 60} 分钟，停止", "error")
                asst.stop()
                break
            time.sleep(1)
        chains = current["chains"]
        failed = [c for c, s in chains.items() if s != "done"]
        ok = not timed_out and chains.get("StartUp") == "done" and not failed
        emit("account", account=acc["id"], phase="end", ok=ok, chains=chains, timed_out=timed_out,
             seconds=round(time.time() - started))
    emit("finished")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 - reported to the host as the run's failure
        emit("fatal", msg=f"{type(e).__name__}: {e}")
        sys.exit(1)
