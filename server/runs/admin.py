#!/usr/bin/env python3
"""The speedrun board, by hand: for the maintainer (a member of the group
`runs`), over ssh.

    admin.py runs [N]          the latest runs, hidden ones too
    admin.py hide ID           off the board (kept)
    admin.py show ID           back on it
    admin.py delete ID         gone: the run and its recording
    admin.py bugs              the bug reports not yet dealt with
    admin.py bug ID            one report, and where its recording is
    admin.py done ID           a report dealt with
    admin.py board             write the board again

Each change writes the board again at once (worker.py --board).
"""

import json
import os
import sqlite3
import subprocess
import sys

ROOT = os.environ.get("RUNS_ROOT", "/srv/runs")
DB = os.path.join(ROOT, "data", "runs.db")
WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py")


def board():
    subprocess.run([sys.executable, WORKER, "--board"], check=True)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    what, args = sys.argv[1], sys.argv[2:]
    con = sqlite3.connect(DB)
    if what == "runs":
        n = int(args[0]) if args else 20
        for row in con.execute("select id, created, nick, tas, physics, complete, total, hidden, runs from runs "
                               "order by created desc limit ?", (n,)):
            id_, created, nick, tas, physics, complete, total, hidden, runs = row
            k = len(json.loads(runs))
            print("%s  %s  %-24s %8.2f s  %2d chamber%s  %s%s%s%s" % (
                id_, created[:16], nick, total, k, "" if k == 1 else "s", physics,
                "  TAS" if tas else "", "" if complete else "  incomplete", "  HIDDEN" if hidden else ""))
    elif what in ("hide", "show") and args:
        con.execute("update runs set hidden = ? where id = ?", (1 if what == "hide" else 0, args[0]))
        con.commit()
        board()
    elif what == "delete" and args:
        con.execute("delete from runs where id = ?", (args[0],))
        con.commit()
        for p in ("public/rec/%s.txt", "public/run/%s.json", "public/status/%s.json"):
            path = os.path.join(ROOT, p % args[0])
            if os.path.exists(path):
                os.remove(path)
        board()
    elif what == "bugs":
        for id_, created, nick, note, contact, version in con.execute(
                "select id, created, nick, note, contact, version from bugs where done = 0 order by created"):
            print("%s  %s  %s (%s)%s\n    %s" % (id_, created[:16], nick, version, "  " + contact if contact else "",
                                               note.replace("\n", "\n    ")))
    elif what == "bug" and args:
        row = con.execute("select * from bugs where id = ?", (args[0],)).fetchone()
        if row is None:
            sys.exit("no such report")
        print(json.dumps(dict(zip([d[0] for d in con.execute("select * from bugs").description], row)), indent=1))
        print("recording:", os.path.join(ROOT, "data", "bugs", args[0], "recording.txt"))
    elif what == "done" and args:
        con.execute("update bugs set done = 1 where id = ?", (args[0],))
        con.commit()
    elif what == "board":
        board()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
