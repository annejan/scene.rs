#!/usr/bin/env python3
"""The speedrun board's worker: every upload in the spool replayed, judged,
and the board written out. Runs as the user `runs` (runs-worker.service,
every minute), never as the web server.

    worker.py            take what is in the spool, then write the board
    worker.py --board    only write the board again (after an admin change)

An upload is two files in SPOOL, written by the web page (runs/submit.php):
<id>.txt, the recording, and <id>.json, what was said about it. The
recording is replayed by the game's own code (host_runcheck, built from
Portals: one for each physics, picked by the recording's version line),
with a time limit and little memory, as a file nobody else wrote. What it
says goes into the database; the times on the board are the replay's,
never the uploader's.

A bug report is kept for the maintainer only, in DATA/bugs/, with what the
replay made of it.

Out, in PUBLIC (served at scene.rs/runs/data/): board.json, run/<id>.json
for each listed run, rec/<id>.txt its recording to download, and
status/<id>.json for the page that uploaded it to ask after.
"""

import json
import os
import re
import resource
import shutil
import sqlite3
import subprocess
import sys
import time

ROOT = os.environ.get("RUNS_ROOT", "/srv/runs")
SPOOL = os.path.join(ROOT, "spool")
DATA = os.path.join(ROOT, "data")
PUBLIC = os.path.join(ROOT, "public")
BIN = os.path.join(ROOT, "bin")
PACKS = os.path.join(ROOT, "packs")
DB = os.path.join(DATA, "runs.db")

# Which build replays a recording: by its version line's first word (a
# release, or a ghost's physics), the newest physics it is at least.
PHYSICS = [((0, 12, 8), "0.12.8"), ((0, 12, 0), "0.12.0")]

# The twenty test chambers, in order: a run through all of them is "the twenty".
TWENTY = ["01-gap", "02-ledge", "03-fling", "04-button", "05-delivery", "06-faith-plate", "07-the-grill",
          "08-through-the-glass", "09-the-ferry", "10-two-buttons", "11-against-the-clock", "12-redirection",
          "13-hard-light", "14-repulsion", "15-catch", "16-relay", "17-gauntlet", "18-edgeless", "19-sentry",
          "20-excursion"]

TOP = 25  # entries kept on each board


def version_tuple(text):
    m = re.match(r"\s*(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else None


def physics_for(version):
    v = version_tuple(version)
    if v is None:
        return None
    for since, name in PHYSICS:
        if v >= since:
            return name
    return None


def recording_version(path):
    with open(path, "rb") as f:
        head = f.read(4096).decode("utf-8", "replace")
    for line in head.splitlines():
        key, _, value = line.partition(":")
        if key.strip() == "version":
            return value.strip()
    return ""


def limits():
    # The replay: a few seconds of CPU, little memory, no files of its own.
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
    resource.setrlimit(resource.RLIMIT_AS, (512 << 20, 512 << 20))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))


def replay(path, physics):
    tool = os.path.join(BIN, "runcheck-" + physics)
    if not os.path.exists(tool):
        return {"ok": False, "error": "no replay for the %s physics here" % physics}
    try:
        out = subprocess.run([tool, path, PACKS], capture_output=True, timeout=30, preexec_fn=limits,
                             env={}, cwd="/")
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "the replay took too long"}
    try:
        return json.loads(out.stdout.decode("utf-8", "replace"))
    except ValueError:
        return {"ok": False, "error": "the replay did not finish (%d)" % out.returncode}


def db():
    con = sqlite3.connect(DB)
    con.execute("""create table if not exists runs (
        id text primary key, created text, nick text, tas integer, video text, note text, source text,
        filename text, version text, physics text, rkind text, complete integer, total real, runs text,
        hidden integer default 0)""")
    con.execute("""create table if not exists bugs (
        id text primary key, created text, nick text, note text, contact text, version text, physics text,
        result text, done integer default 0)""")
    return con


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def status(id_, obj):
    write_json(os.path.join(PUBLIC, "status", id_ + ".json"), obj)


def packs():
    """The chamber runs among the story packs: {pack: [full chamber ids, in order]}."""
    out = {}
    if not os.path.isdir(PACKS):
        return out
    for pid in sorted(os.listdir(PACKS)):
        path = os.path.join(PACKS, pid, "pack.txt")
        if not os.path.exists(path):
            continue
        order, desk, name = [], False, pid
        with open(path) as f:
            for line in f:
                key, _, value = line.strip().partition(":")
                if key == "chamber" and value.strip() != "needs-update":
                    order.append(pid + "/" + value.strip())
                elif key == "frame" and value.strip() == "desk":
                    desk = True
                elif key == "name":
                    name = value.strip()
        if order and not desk:
            out[pid] = {"name": name, "order": order}
    return out


def take(con, meta_path):
    id_ = os.path.basename(meta_path)[:-5]
    rec = os.path.join(SPOOL, id_ + ".txt")
    try:
        with open(meta_path) as f:
            meta = json.load(f)
    except (OSError, ValueError):
        meta = None
    if meta is None or not os.path.exists(rec) or not re.fullmatch(r"[0-9a-f]{16}", id_):
        for p in (meta_path, rec):
            if os.path.exists(p):
                os.remove(p)
        return
    version = recording_version(rec)
    physics = physics_for(version)
    result = replay(rec, physics) if physics else {
        "ok": False, "error": "made on Portals %s: the board takes 0.12 and later" % (version or "(no version line)")}
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    nick = (meta.get("nick") or "anonymous")[:24]

    if meta.get("kind") == "bug":
        # For the maintainer only: the file, what was said, what the replay made of it.
        where = os.path.join(DATA, "bugs", id_)
        os.makedirs(where, exist_ok=True)
        shutil.copy(rec, os.path.join(where, "recording.txt"))
        with open(os.path.join(where, "report.json"), "w") as f:
            json.dump({"meta": meta, "replay": result, "physics": physics, "received": now}, f, indent=1)
        con.execute("insert or replace into bugs values (?,?,?,?,?,?,?,?,0)",
                    (id_, now, nick, (meta.get("note") or "")[:2000], (meta.get("contact") or "")[:200], version,
                     physics or "", json.dumps(result)))
        status(id_, {"state": "bug", "replay": summary(result), "physics": physics})
    elif not result.get("ok"):
        status(id_, {"state": "refused", "why": result.get("error", "it does not read"), "physics": physics})
    else:
        tas = bool(meta.get("tas")) or result.get("kind") != "frames"
        con.execute("insert or replace into runs values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
                    (id_, now, nick, int(tas), (meta.get("video") or "")[:300], (meta.get("note") or "")[:500],
                     (meta.get("source") or "")[:20], (meta.get("filename") or "")[:80], version, physics,
                     result.get("kind"), int(bool(result.get("complete"))), result.get("total") or 0.0,
                     json.dumps(result.get("runs") or [])))
        os.makedirs(os.path.join(PUBLIC, "rec"), exist_ok=True)
        shutil.copy(rec, os.path.join(PUBLIC, "rec", id_ + ".txt"))
        os.chmod(os.path.join(PUBLIC, "rec", id_ + ".txt"), 0o644)
        status(id_, {"state": "listed", "replay": summary(result), "physics": physics, "tas": tas})
    con.commit()
    os.remove(rec)
    os.remove(meta_path)


def summary(result):
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error")}
    return {"ok": True, "kind": result.get("kind"), "complete": result.get("complete"), "total": result.get("total"),
            "runs": [{k: r.get(k) for k in ("chamber", "name", "time", "exit", "why")} for r in result.get("runs", [])]}


def board(con):
    """board.json: per physics, the twenty, each story, each chamber; real and TAS apart, the best
    per nickname; and the latest runs. run/<id>.json for each listed run."""
    rows = con.execute("select id, created, nick, tas, video, note, physics, rkind, complete, total, runs, version "
                       "from runs where hidden = 0 order by created").fetchall()
    stories = packs()
    out = {"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "physics": [p for _, p in PHYSICS],
           "boards": {}, "recent": []}
    best = {}  # (physics, board, side, nick) -> entry

    def offer(physics, key, side, entry):
        k = (physics, key, side, entry["nick"].lower())
        if k not in best or entry["time"] < best[k]["time"]:
            best[k] = entry

    names = {}
    for (id_, created, nick, tas, video, note, physics, rkind, complete, total, runs, version) in rows:
        runs = json.loads(runs)
        side = "tas" if tas else "real"
        base = {"id": id_, "nick": nick, "date": created[:10], "video": video, "version": version}
        ok = [r for r in runs if r.get("exit")]
        ids = [r.get("chamber") or r.get("id") for r in runs]
        if complete and ids == TWENTY:
            offer(physics, "twenty", side, dict(base, time=round(total, 3)))
        for pid, p in stories.items():
            if complete and ids == p["order"]:
                offer(physics, "story:" + pid, side, dict(base, time=round(total, 3)))
        for r in ok:
            cid = r.get("chamber") or r.get("id") or "?"
            names[cid] = r.get("name") or cid
            offer(physics, "chamber:" + cid, side, dict(base, time=round(r.get("time") or 0.0, 3)))
        write_json(os.path.join(PUBLIC, "run", id_ + ".json"),
                   dict(base, note=note, physics=physics, tas=bool(tas), kind=rkind, complete=bool(complete),
                        total=round(total, 3), runs=runs, recording="rec/%s.txt" % id_))
        out["recent"].append(dict(base, physics=physics, tas=bool(tas), complete=bool(complete),
                                  total=round(total, 3), chambers=len(runs),
                                  first=(runs[0].get("name") if runs else "")))
    out["recent"] = out["recent"][::-1][:30]
    for (physics, key, side, _), entry in best.items():
        b = out["boards"].setdefault(physics, {}).setdefault(key, {"real": [], "tas": []})
        b[side].append(entry)
    for physics, boards in out["boards"].items():
        for key, b in boards.items():
            for side in ("real", "tas"):
                b[side] = sorted(b[side], key=lambda e: e["time"])[:TOP]
            if key.startswith("chamber:"):
                b["name"] = names.get(key[8:], key[8:])
            elif key.startswith("story:"):
                b["name"] = stories.get(key[6:], {}).get("name", key[6:])
            else:
                b["name"] = "The twenty test chambers"
    write_json(os.path.join(PUBLIC, "board.json"), out)


def main():
    os.umask(0o002)  # group runs (the maintainer's admin.py) may change what this writes
    con = db()
    if "--board" not in sys.argv:
        for name in sorted(os.listdir(SPOOL)):
            if name.endswith(".json") and not name.startswith("."):  # .<id>.json: still being written
                take(con, os.path.join(SPOOL, name))
    board(con)


if __name__ == "__main__":
    main()
