#!/usr/bin/env python3
"""Films of the speedrun board's runs, rendered on the annejan.com box as
the user `runfilm` (runfilm-render.timer), served at
https://annejan.com/portals/runs/<id>.mp4 for scene.rs/runs to show.

Each turn: the board's list of runs (scene.rs/runs/data/index.json), and
for a few without a film yet, oldest first: the recording fetched, filmed
by Portals' own film tool for the physics it was made on (make_movie.py
--recording, the badge's view, HUD and run timer, at its 800 x 480),
encoded small, a poster from it. A run gone from the board loses its film.
A run that will not film is not tried again (<id>.fail says why).

    render.py [--once ID]
"""

import json
import os
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
OUT = os.path.join(ROOT, "out")      # served at annejan.com/portals/runs/
BOARD = "https://scene.rs/runs/data/"
PER_TURN = 3          # films a turn, at most
LONGEST = 10 * 60.0   # a run longer than this is not filmed (its frames: about 0.7 GB a minute while it is made)
CHAMBER_CAP = 300     # seconds of one chamber, at most


def fetch(url, path=None):
    req = urllib.request.Request(url, headers={"User-Agent": "portals-runfilm/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(4 << 20)
    if path is None:
        return data
    with open(path, "wb") as f:
        f.write(data)


def fail(id_, why):
    with open(os.path.join(OUT, id_ + ".fail"), "w") as f:
        f.write(why + "\n")
    print(id_, "failed:", why)


def film(run):
    id_, physics = run["id"], run["physics"]
    tool = os.path.join(BIN, "movie-" + physics)
    if not os.path.exists(tool):
        return fail(id_, "no film tool for the %s physics" % physics)
    if (run.get("total") or 0) > LONGEST:
        return fail(id_, "longer than %d minutes" % (LONGEST // 60))
    work = os.path.join(WORK, id_)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    try:
        rec = os.path.join(work, "run.txt")
        fetch(BOARD + "rec/%s.txt" % id_, rec)
        raw = os.path.join(work, "raw.mp4")
        cmd = [sys.executable, os.path.join(APP, "tools", "make_movie.py"), "--recording", rec, "--recorder", tool,
               "--packs", PACKS, "--scale", "1", "--seconds", str(CHAMBER_CAP), "--work", work, "--mp4", raw]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=45 * 60)
        if out.returncode != 0 or not os.path.exists(raw):
            return fail(id_, "the film tool: " + (out.stderr.strip().splitlines() or ["?"])[-1][:200])
        tmp = os.path.join(work, "film.mp4")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-c:v", "libx264", "-preset", "slow", "-crf",
                        "27", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", tmp],
                       check=True, timeout=30 * 60)
        poster = os.path.join(work, "poster.jpg")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "3", "-i", tmp, "-frames:v", "1", "-q:v", "4",
                        poster], check=True, timeout=120)
        for src, name in ((poster, id_ + ".jpg"), (tmp, id_ + ".mp4")):  # the film last: it says it is there
            os.chmod(src, 0o644)
            os.replace(src, os.path.join(OUT, name))
        print(id_, "filmed")
    except (OSError, subprocess.SubprocessError) as e:
        fail(id_, str(e)[:200])
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    os.umask(0o002)
    os.makedirs(WORK, exist_ok=True)
    if len(sys.argv) == 3 and sys.argv[1] == "--once":
        runs = json.loads(fetch(BOARD + "index.json"))["runs"]
        for r in runs:
            if r["id"] == sys.argv[2]:
                for ext in (".fail", ".mp4", ".jpg"):
                    p = os.path.join(OUT, sys.argv[2] + ext)
                    if os.path.exists(p):
                        os.remove(p)
                film(r)
        return
    runs = json.loads(fetch(BOARD + "index.json"))["runs"]
    listed = {r["id"] for r in runs}
    # Gone from the board (hidden or deleted): so are their films.
    for name in os.listdir(OUT):
        id_ = name.split(".")[0]
        if len(id_) == 16 and id_ not in listed:
            os.remove(os.path.join(OUT, name))
    done = 0
    for r in runs:  # oldest first
        if done >= PER_TURN:
            break
        id_ = r["id"]
        if any(os.path.exists(os.path.join(OUT, id_ + ext)) for ext in (".mp4", ".fail")):
            continue
        film(r)
        done += 1
    filmed = sorted(n[:-4] for n in os.listdir(OUT) if n.endswith(".mp4"))
    with open(os.path.join(OUT, "index.json.tmp"), "w") as f:
        json.dump({"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "films": filmed}, f)
    os.chmod(os.path.join(OUT, "index.json.tmp"), 0o644)
    os.replace(os.path.join(OUT, "index.json.tmp"), os.path.join(OUT, "index.json"))


if __name__ == "__main__":
    main()
