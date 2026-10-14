#!/usr/bin/env python3
"""Films of the speedrun board's runs, rendered on the annejan.com box as
the user `runfilm` (runfilm-render.timer), served at
https://vidr.nl/portals/<id>.mp4 for scene.rs/runs to show, with the
queue (queue.json) public at vidr.nl.

A film can always be made again from its recording, so the films are a
cache, not data: of a fixed size, the least lately watched going first
(its file's access time: the pages read it when they show the run).
Kept always: the best few on each board ("pin" in the board's index) and
the few someone asked for on the run's page ("wanted", runs/want.php).

Each turn: the board's list of runs (scene.rs/runs/data/index.json); the
films of runs gone from the board deleted; the cache trimmed; then a few
films made, the asked-for and the pinned in turn (the list read again
before each film), then the kept films made before they had chapters
made again: the recording fetched, filmed by Portals' own film tool for
the physics it was made on (make_movie.py --recording, the badge's view,
HUD and run timer, at its native 800 x 480), encoded once at a high
quality, a poster from it, and <id>.json: where in the film each of its
runs starts and ends, and which make of the film this is ("v", for the
pages to ask for the film by). A run that cannot be filmed is not tried
again (<id>.fail says why, and queue.json); one that failed for a passing
reason (the network, the disk) is tried again later (<id>.retry). A film
that does not fit the disk now waits, and the next one that fits goes.

    render.py [--once ID]
"""

import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = os.environ.get("RUNFILM_ROOT", "/srv/runfilm")
APP = os.path.join(ROOT, "app")      # tools/make_movie.py, textures/, metadata/ (Portals')
BIN = os.path.join(ROOT, "bin")      # movie-<physics> (Portals' make board-tools)
PACKS = os.path.join(ROOT, "packs")  # the story packs, as on a card
WORK = os.path.join(ROOT, "work")
OUT = os.path.join(ROOT, "out")      # served at vidr.nl/portals/
BOARD = os.environ.get("RUNFILM_BOARD", "https://scene.rs/runs/data/")
PER_TURN = 3              # films a turn, at most
LONGEST = 10 * 60.0       # seconds of film (the index's "length": the chambers as filmed, and the pauses), at most
CHAMBER_CAP = 300         # seconds of one chamber that does not reach its exit, at most
RETRY = 30 * 60           # a film that failed for a passing reason is tried again after this
TOOL_TIMEOUT = 30 * 60    # one film, at most: PER_TURN of them fit in the service's TimeoutStartSec (2 h)
GB = 1 << 30
CACHE = float(os.environ.get("RUNFILM_CACHE_GB", "10")) * GB  # the films, at most (the kept ones may go over)
FLOOR = float(os.environ.get("RUNFILM_FLOOR_GB", "10")) * GB  # free disk always left on the box
# The film: x264 at quality 16 (clean on the badge's flat pixels; about 16 MB a minute), tuned for them.
QUALITY = ["--crf", "16", "--preset", "medium", "--tune", "animation"]
FILES = (".mp4", ".jpg", ".json")  # a film's, as served


def fetch(url, path=None):
    req = urllib.request.Request(url, headers={"User-Agent": "portals-runfilm/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(4 << 20)
    if path is None:
        return data
    with open(path, "wb") as f:
        f.write(data)


def out(name):
    return os.path.join(OUT, name)


def put(name, text):
    """A small file into OUT, whole or not at all."""
    tmp = out("." + name + ".tmp")
    with open(tmp, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, out(name))


def remove(name):
    try:
        os.remove(out(name))
    except FileNotFoundError:
        pass


def fail(id_, why, detail="", passing=False):
    """A run that will not film: <id>.fail for good, its first line public (queue.json); or, for a
    passing reason, <id>.retry, tried again after RETRY."""
    put(id_ + (".retry" if passing else ".fail"), why + "\n" + detail[:300] + "\n")
    print(id_, "will be tried again later:" if passing else "failed:", why, detail[:300])


def blocked(id_):
    if os.path.exists(out(id_ + ".fail")):
        return True
    try:
        return time.time() - os.path.getmtime(out(id_ + ".retry")) < RETRY
    except OSError:
        return False


def valid(run):
    return (re.fullmatch(r"[0-9a-f]{16}", str(run.get("id", ""))) is not None and
            re.fullmatch(r"\d+\.\d+\.\d+", str(run.get("physics", ""))) is not None)


def length(run):
    """Seconds of film, about (worker.py's estimate; the run's total for an older index)."""
    return float(run.get("length") or (run.get("total") or 0) + 6 * (run.get("chambers") or 1))


def rejected(run):
    """Why a run cannot be filmed at all, found without filming it; or None."""
    if not os.path.exists(os.path.join(BIN, "movie-" + run["physics"])):
        return "no film tool for the %s physics" % run["physics"]
    if length(run) > LONGEST:
        return "longer than %d minutes of film" % (LONGEST // 60)
    return None


def film(run):
    id_, physics = run["id"], run["physics"]
    why = rejected(run)
    if why:
        return fail(id_, why)
    work = os.path.join(WORK, id_)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    try:
        rec = os.path.join(work, "run.txt")
        fetch(BOARD + "rec/%s.txt" % id_, rec)
        tmp = os.path.join(work, "film.mp4")
        chapters = os.path.join(work, "chapters.json")  # where each run is in the film, for the pages
        # A chamber that reaches its exit is filmed whole, however long (the run's length is checked above).
        seconds = int(min(max(CHAMBER_CAP, float(run.get("longest") or 0) + 5), LONGEST))
        cmd = [sys.executable, os.path.join(APP, "tools", "make_movie.py"), "--recording", rec,
               "--recorder", os.path.join(BIN, "movie-" + physics), "--packs", PACKS, "--scale", "1",
               "--seconds", str(seconds), "--work", work, "--mp4", tmp, "--chapters", chapters] + QUALITY
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=TOOL_TIMEOUT)
        if done.returncode != 0 or not os.path.exists(tmp):
            last = (done.stderr.strip().splitlines() or ["?"])[-1]
            if free() < FLOOR:
                return fail(id_, "too little disk to film it", last, passing=True)
            return fail(id_, "the film tool could not film it", last)
        try:
            with open(chapters) as f:
                info = json.load(f)
        except (OSError, ValueError):
            info = {"chapters": []}
        info["v"] = int(time.time())  # this make of the film: the pages ask for <id>.mp4?v=
        with open(chapters, "w") as f:
            json.dump(info, f, separators=(",", ":"))
        poster = os.path.join(work, "poster.jpg")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "3", "-i", tmp, "-frames:v", "1", "-q:v", "4",
                        poster], check=True, timeout=120)
        for src, name in ((poster, id_ + ".jpg"), (tmp, id_ + ".mp4"), (chapters, id_ + ".json")):  # .json says
            os.chmod(src, 0o644)                                                                     # it is all there
            os.replace(src, out(name))
        remove(id_ + ".retry")
        print(id_, "filmed")
    except subprocess.TimeoutExpired:
        fail(id_, "took too long to film")
    except (OSError, ValueError, subprocess.SubprocessError) as e:  # the network, the disk: another time
        fail(id_, "could not be filmed just now", str(e), passing=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def free():
    st = os.statvfs(OUT)
    return st.f_bavail * st.f_frsize


def need(run):
    """Disk a film takes while it is made: its frames, about a GB a minute of film."""
    return length(run) / 60 * GB + GB / 4


def films():
    """id -> (last watched, bytes) of each film made."""
    have = {}
    for name in os.listdir(OUT):
        id_, _, ext = name.partition(".")
        if len(id_) == 16 and ext == "mp4":
            try:
                st = os.stat(out(name))
                size = st.st_size + sum(os.path.getsize(out(id_ + e)) for e in (".jpg", ".json")
                                        if os.path.exists(out(id_ + e)))
            except OSError:  # gone meanwhile
                continue
            have[id_] = (st.st_atime, size)
    return have


def evict(id_):
    for ext in FILES:
        remove(id_ + ext)
    print(id_, "let go (cache)")


def trim(keep, room=0):
    """The least lately watched films not in keep let go until the films fit the cache; then, for
    room more on the disk, more of them, but only if that can make the room. Says whether the disk
    has FLOOR and room free."""
    have = films()
    used = sum(b for _, b in have.values())
    loose = sorted((i for i in have if i not in keep), key=lambda i: have[i][0])
    while loose and used > CACHE:
        i = loose.pop(0)
        evict(i)
        used -= have[i][1]
    if free() >= FLOOR + room:
        return True
    if free() + sum(have[i][1] for i in loose) < FLOOR + room:
        return False  # letting them all go would not do: keep them
    while loose and free() < FLOOR + room:
        evict(loose.pop(0))
    return free() >= FLOOR + room


def gone(runs):
    """Runs gone from the board (hidden or deleted): so are their films."""
    listed = {r.get("id") for r in runs}
    for name in os.listdir(OUT):
        id_ = name.split(".")[0]
        if len(id_) == 16 and id_ not in listed:
            remove(name)


def plan(index):
    """The runs by id; the films to keep whatever (pinned, asked for); the films to make, in
    order: the asked-for (the latest ask first) and the pinned (the oldest first) in turn, so
    neither starves the other; then the kept ones with no chapters yet."""
    by_id = {r["id"]: r for r in index.get("runs", []) if valid(r)}
    wanted = [i for i in index.get("wanted", []) if i in by_id]
    pinned = [i for i in by_id if by_id[i].get("pin")]
    keep = set(wanted) | set(pinned)
    for i in sorted(keep):  # what cannot be filmed at all, said so now: it never holds up the queue
        if not blocked(i) and not os.path.exists(out(i + ".mp4")):
            why = rejected(by_id[i])
            if why:
                fail(i, why)
    todo = lambda i: not os.path.exists(out(i + ".mp4")) and not blocked(i)
    asked = [i for i in wanted if todo(i)]
    best = [i for i in pinned if todo(i) and i not in asked]
    queue = [x for pair in zip(asked, best) for x in pair] + asked[len(best):] + best[len(asked):]
    queue += [i for i in sorted(keep) if os.path.exists(out(i + ".mp4")) and not os.path.exists(out(i + ".json"))
              and not blocked(i)]
    return by_id, keep, [by_id[i] for i in queue]


def public(r, at=None, v=None):
    n = r.get("chambers") or 1
    what = (r.get("first") or "") if n == 1 else "all twenty" if n == 20 else "%d chambers" % n
    obj = {"id": r["id"], "nick": r.get("nick") or "", "what": what, "total": r.get("total"),
           "physics": r.get("physics"), "tas": bool(r.get("tas"))}
    if at:
        obj["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))
    if v:
        obj["v"] = v
    return obj


def made_v(id_):
    try:
        with open(out(id_ + ".json")) as f:
            return int(json.load(f).get("v") or 0) or None
    except (OSError, ValueError, AttributeError):
        return None


def publish(making, queue, by_id, keep):
    """queue.json, public (vidr.nl, and the run pages): the film being made, the ones waiting,
    the kept ones that cannot be made and why, the latest made."""
    have = films()
    when = {}
    for i in have:
        try:
            when[i] = os.path.getmtime(out(i + ".mp4"))
        except OSError:
            pass
    made = sorted((i for i in when if i in by_id), key=lambda i: -when[i])[:24]
    failed = []
    for i in sorted(keep):
        try:
            with open(out(i + ".fail")) as f:
                failed.append(dict(public(by_id[i]), why=f.readline().strip()[:120]))
        except OSError:
            pass
    put("queue.json", json.dumps(
        {"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
         "making": public(making) if making else None,
         "queue": [public(r) for r in queue if r is not making],
         "failed": failed,
         "made": [public(by_id[i], when[i], made_v(i)) for i in made],
         "films": len(have), "bytes": sum(b for _, b in have.values()), "cache": CACHE},
        ensure_ascii=False, separators=(",", ":")))


def main():
    os.umask(0o002)
    os.makedirs(WORK, exist_ok=True)
    # One at a time (the timer's turn, or --once): what a killed one left in WORK goes.
    lock = open(os.path.join(WORK, ".lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another turn is filming: not now")
        return
    for name in os.listdir(WORK):
        if name != ".lock":
            shutil.rmtree(os.path.join(WORK, name), ignore_errors=True)
    try:
        index = json.loads(fetch(BOARD + "index.json"))
    except (OSError, ValueError) as e:
        print("the board's index:", e)
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--once":
        for r in index.get("runs", []):
            if r.get("id") == sys.argv[2] and valid(r):
                for ext in FILES + (".fail", ".retry"):
                    remove(r["id"] + ext)
                film(r)
        return
    gone(index.get("runs", []))
    by_id, keep, queue = plan(index)
    trim(keep)
    publish(None, queue, by_id, keep)
    try:
        for turn in range(PER_TURN):
            if turn:  # the board again: someone may have asked for a film meanwhile
                try:
                    index = json.loads(fetch(BOARD + "index.json"))
                except (OSError, ValueError) as e:
                    print("the board's index:", e)
                    break
                by_id, keep, queue = plan(index)
            pick = next((r for r in queue if trim(keep, need(r))), None)
            if pick is None:
                if queue:
                    print("too little disk left for any film waiting (%.1f GB free): later" % (free() / GB))
                break
            publish(pick, queue, by_id, keep)
            film(pick)
    finally:
        by_id, keep, queue = plan(index)
        publish(None, queue, by_id, keep)


if __name__ == "__main__":
    main()
