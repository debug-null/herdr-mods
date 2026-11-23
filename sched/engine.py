#!/usr/bin/env python3
"""sched-engine — scheduled tasks for the Herdr app.

Runs as a kept herdr-core terminal (started by the `sched` / `sched-entry` mod).
Reads jobs.json from its own folder every tick, fires due actions, and writes
state.json for the panel to render. Append a job id (one per line) to `run-now`
to fire it immediately.

Job:
  {
    "id": "nightly",            # slug; assigned by the panel
    "name": "Nightly review",   # display name
    "enabled": true,
    "schedule": {"every_min": 30} | {"cron": "0 22 * * *"} | {"at": "2026-11-21T09:00"},
    "action":
      {"type": "exec",   "cmd": "just test", "cwd": "~/repo"}
    | {"type": "prompt", "terminal": "t18", "text": "review the diff", "if": "idle"}
    | {"type": "spawn",  "argv": ["devin"], "task": "...", "name": "nightly",
        "folder": "~/repo", "space": null, "focus": false},
    "timeout_sec": 600,         # exec only
    "notify": "err"             # null off | "err" on failure | "always" every run
  }
"""

import json
import os
import signal
import subprocess
import threading
import time
from datetime import datetime, timedelta

DIR = os.path.dirname(os.path.abspath(__file__))
JOBS_FILE = os.path.join(DIR, "jobs.json")
STATE_FILE = os.path.join(DIR, "state.json")
LOG_FILE = os.path.join(DIR, "engine.log")
RUNNOW_FILE = os.path.join(DIR, "run-now")
ALERTS_FILE = os.path.join(DIR, "alerts")  # JSON lines the panel turns into toasts

TICK = 1.0
HEARTBEAT_SAVE = 8.0
LOG_CAP = 512 * 1024
HISTORY_CAP = 12
MSG_CAP = 2000

HC = os.environ.get("HC_BIN", "hc")
APP = os.environ.get("HERDR_APP_BIN", "herdr-app")

_lock = threading.RLock()
_jobs = []               # parsed job dicts
_jobs_mtime = -1.0
_jobs_error = None
_state = {
    "engine": {"pid": os.getpid(), "started_at": time.time(), "running": []},
    "jobs": {},
}
_running = set()         # job ids with a live run
_stop = False


def log(msg):
    line = "%s %s" % (time.strftime("%H:%M:%S"), msg)
    print(line, flush=True)
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > LOG_CAP:
            with open(LOG_FILE) as f:
                tail = f.read()[-LOG_CAP // 2 :]
            with open(LOG_FILE, "w") as f:
                f.write(tail)
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def save_state():
    with _lock:
        _state["engine"]["heartbeat"] = time.time()
        _state["engine"]["jobs_error"] = _jobs_error
        _state["engine"]["running"] = sorted(_running)
        payload = json.dumps(_state, ensure_ascii=False, indent=1)
        tmp = "%s.tmp.%d" % (STATE_FILE, os.getpid())
        try:
            with open(tmp, "w") as f:
                f.write(payload)
            os.replace(tmp, STATE_FILE)
        except OSError as e:
            log("state write failed: %s" % e)


def load_jobs():
    global _jobs, _jobs_mtime, _jobs_error
    if not os.path.exists(JOBS_FILE):
        if _jobs_mtime != -2.0:
            _jobs = []
            _jobs_mtime = -2.0
            _jobs_error = None
        return
    try:
        mtime = os.path.getmtime(JOBS_FILE)
    except OSError:
        return
    if mtime == _jobs_mtime:
        return
    try:
        with open(JOBS_FILE) as f:
            data = json.load(f)
        new_jobs = [j for j in data.get("jobs", []) if isinstance(j, dict) and j.get("id")]
        _jobs = new_jobs
        _jobs_mtime = mtime
        _jobs_error = None
        live = {j["id"] for j in new_jobs}
        for stale in [k for k in _state["jobs"] if k not in live]:
            _state["jobs"].pop(stale, None)
        log("loaded %d job(s)" % len(_jobs))
    except (OSError, ValueError) as e:
        _jobs_error = "jobs.json: %s" % e
        log(_jobs_error)


# --- schedules -------------------------------------------------------------

def _cron_field(spec, lo, hi):
    vals = set()
    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, st = part.split("/", 1)
            step = max(1, int(st))
        if part in ("*", ""):
            a, b = lo, hi
        elif "-" in part:
            a, b = (int(x) for x in part.split("-", 1))
        else:
            a = b = int(part)
        if a < lo or b > hi or a > b:
            raise ValueError("cron field %r out of range %d..%d" % (part, lo, hi))
        vals.update(range(a, b + 1, step))
    if not vals:
        raise ValueError("empty cron field %r" % spec)
    return vals


def cron_next(expr, now):
    """Next datetime strictly after `now` matching a 5-field cron expr."""
    f = expr.split()
    if len(f) != 5:
        raise ValueError("cron needs 5 fields")
    mins = _cron_field(f[0], 0, 59)
    hrs = _cron_field(f[1], 0, 23)
    dom = _cron_field(f[2], 1, 31)
    mons = _cron_field(f[3], 1, 12)
    dows = _cron_field(f[4], 0, 7)  # 0-6 sun-sat; allow 7=sun
    dows = {d % 7 for d in dows}
    dom_any, dow_any = f[2] == "*", f[4] == "*"

    t = now.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(4 * 366 * 24 * 60):  # up to 4 years
        if t.month not in mons:
            t = (t.replace(day=1) + timedelta(days=32)).replace(day=1, hour=0, minute=0)
            continue
        # vixie rule: if both dom and dow are restricted, either may match
        if dom_any or dow_any:
            day_ok = t.day in dom and (t.weekday() + 1) % 7 in dows
        else:
            day_ok = t.day in dom or (t.weekday() + 1) % 7 in dows
        if not day_ok:
            t = (t + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if t.hour not in hrs:
            t = (t + timedelta(hours=1)).replace(minute=0)
            continue
        if t.minute not in mins:
            t += timedelta(minutes=1)
            continue
        return t.timestamp()
    raise ValueError("no match within 4 years")


def sched_key(job):
    return json.dumps(job.get("schedule", {}), sort_keys=True)


def next_run(job, st, now):
    """Seconds of the next fire time, or None when finished/unknown."""
    s = job.get("schedule", {})
    try:
        if "every_min" in s:
            every = max(0.5, float(s["every_min"]))
            base = st.get("last_run") or now
            nxt = base + every * 60
            return nxt if nxt > now else now + every * 60
        if "cron" in s:
            return cron_next(s["cron"], datetime.now())
        if "at" in s:
            return datetime.fromisoformat(s["at"]).timestamp()
    except (ValueError, TypeError) as e:
        st["schedule_error"] = str(e)
        return None
    return None


# --- actions ---------------------------------------------------------------

def _cmd(args, timeout=None):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "timeout after %ss" % timeout
    except OSError as e:
        return 127, str(e)


def act_exec(a, job):
    cmd = a["cmd"]
    cwd = os.path.expanduser(a.get("cwd") or "~")
    timeout = float(job.get("timeout_sec") or 600)
    try:
        p = subprocess.run(
            ["/bin/sh", "-c", cmd],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "timeout after %ss" % timeout
    except OSError as e:
        return 127, str(e)


def act_prompt(a, job):
    args = [HC, "send", a["terminal"], a["text"]]
    only_if = a.get("if")
    if only_if:
        args += ["--if", only_if]
    rc, out = _cmd(args)
    if rc != 0 and only_if:
        return "skip", out.strip() or "status is not %s" % only_if
    return rc, out


def _fire_result(res):
    """Normalize an action result to (status, output). rc 'skip' means the
    action declined to run this time (e.g. prompt --if idle)."""
    rc, out = res
    status = "ok" if rc == 0 else ("skip" if rc == "skip" else "err")
    return status, out


def act_spawn(a, job):
    name = a.get("name") or job.get("name") or job["id"]
    argv = a.get("argv") or []
    task = a.get("task") or ""
    # Prefer the app so the tab lands in the UI; fall back to a bare core
    # terminal (works while the window is closed).
    args = [
        APP, "do", "tab.new",
        "--name", name,
        "--argv", json.dumps(argv, ensure_ascii=False),
        "--focus", "true" if a.get("focus") is True else "false",
    ]
    if task:
        args += ["--task", task]
    if a.get("folder"):
        args += ["--folder", os.path.expanduser(a["folder"])]
    if a.get("space"):
        args += ["--space", a["space"]]
    rc, out = _cmd(args)
    if rc == 0:
        return 0, out
    # app unreachable -> run the agent on core and send the task
    tname = "%s-%d" % (job["id"], int(time.time()))
    hc_args = [
        HC, "run", "--bg", "--name", tname,
        "--label", "herdr.sched=%s" % job["id"],
    ]
    if a.get("folder"):
        hc_args += ["--cwd", os.path.expanduser(a["folder"])]
    hc_args += ["--"] + argv
    rc2, out2 = _cmd(hc_args)
    if rc2 != 0:
        return rc, "app: %s\ncore: %s" % (out.strip(), out2.strip())
    if task:
        time.sleep(3)
        _cmd([HC, "send", tname, task])
    return 0, "spawned %s via hc" % tname


def append_alert(job, status, out):
    try:
        with open(ALERTS_FILE, "a") as f:
            f.write(json.dumps({
                "id": job["id"],
                "job": job.get("name") or job["id"],
                "status": status,
                "msg": (out or "").strip()[-400:],
                "ts": time.time(),
            }, ensure_ascii=False) + "\n")
    except OSError as e:
        log("alert write failed: %s" % e)


def fire(job, forced=False):
    jid = job["id"]
    a = job.get("action", {})
    started = time.time()
    try:
        if a.get("type") == "prompt":
            res = act_prompt(a, job)
        elif a.get("type") == "spawn":
            res = act_spawn(a, job)
        else:
            res = act_exec(a, job)
        status, out = _fire_result(res)
    except Exception as e:  # never let one job kill the loop
        status, out = "err", "%s: %s" % (type(e).__name__, e)

    now = time.time()
    duration_ms = max(0, int((now - started) * 1000))
    trimmed = (out or "").strip()[-MSG_CAP:]

    with _lock:
        st = _state["jobs"].setdefault(jid, {})
        hist = list(st.get("history") or [])
        hist.insert(0, {
            "ts": now,
            "duration_ms": duration_ms,
            "status": status,
            "msg": trimmed,
            "forced": bool(forced),
        })
        st.update({
            "running": False,
            "running_since": None,
            "last_run": now,
            "last_duration_ms": duration_ms,
            "last_status": status,
            "last_msg": trimmed[-400:],
            "run_count": st.get("run_count", 0) + 1,
            "history": hist[:HISTORY_CAP],
        })
        is_at = "at" in job.get("schedule", {})
        if is_at:
            at_ts = next_run(job, st, now)
            # Only mark done & disable when fired by schedule or already past target time
            if not forced or at_ts is None or now >= at_ts:
                st["next_run"] = None
                st["done"] = True
                _disable_job(jid)
            else:
                st["next_run"] = at_ts
        else:
            st["next_run"] = next_run(job, st, now)

    want = job.get("notify")
    if want == "always" or (want == "err" and status == "err"):
        append_alert(job, status, out)
    log("job %s -> %s (%dms)%s" % (
        jid, status, duration_ms,
        "" if status == "ok" else " (%s)" % (out or "").strip()[-120:],
    ))


def _disable_job(jid):
    try:
        with open(JOBS_FILE) as f:
            data = json.load(f)
        for j in data.get("jobs", []):
            if j.get("id") == jid:
                j["enabled"] = False
        tmp = "%s.tmp.%d" % (JOBS_FILE, os.getpid())
        with open(tmp, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, JOBS_FILE)
    except (OSError, ValueError) as e:
        log("disable %s failed: %s" % (jid, e))


def consume_runnow():
    try:
        with open(RUNNOW_FILE) as f:
            ids = [l.strip() for l in f if l.strip()]
        os.remove(RUNNOW_FILE)
    except OSError:
        return []
    return ids


def tick():
    now = time.time()
    force_ids = set(consume_runnow())
    dirty = False
    for job in _jobs:
        jid = job["id"]
        st = _state["jobs"].setdefault(jid, {})
        skey = sched_key(job)
        enabled = job.get("enabled", True)

        if st.get("sched_key") != skey:
            st["sched_key"] = skey
            st.pop("schedule_error", None)
            st.pop("done", None)
            st["next_run"] = next_run(job, st, now)
            dirty = True
        elif st.get("done") and enabled and "at" in job.get("schedule", {}):
            # User re-enabled an `at` job; if target time is in the future, arm it again
            at_ts = next_run(job, st, now)
            if at_ts is not None and at_ts > now:
                st.pop("done", None)
                st["next_run"] = at_ts
                dirty = True

        forced = jid in force_ids
        due = forced or (
            enabled
            and not st.get("done")
            and st.get("next_run") is not None
            and now >= st["next_run"]
        )
        if due and jid not in _running:
            _running.add(jid)
            st["running"] = True
            st["running_since"] = now
            dirty = True
            job_copy = json.loads(json.dumps(job))
            threading.Thread(
                target=_run_guard, args=(job_copy, forced), daemon=True
            ).start()
    return dirty


def _run_guard(job, forced=False):
    jid = job["id"]
    try:
        fire(job, forced=forced)
    finally:
        with _lock:
            _running.discard(jid)
            st = _state["jobs"].get(jid)
            if st is not None:
                st["running"] = False
                st["running_since"] = None
        save_state()


def shutdown(*_):
    global _stop
    _stop = True


def main():
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    log("sched-engine started (dir %s, pid %d)" % (DIR, os.getpid()))
    with _lock:
        load_jobs()
    last_save = 0.0
    while not _stop:
        with _lock:
            load_jobs()
            dirty = tick()
        if dirty or time.time() - last_save >= HEARTBEAT_SAVE:
            save_state()
            last_save = time.time()
        time.sleep(TICK)
    save_state()
    log("sched-engine stopped")


if __name__ == "__main__":
    main()
