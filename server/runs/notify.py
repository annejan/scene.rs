#!/usr/bin/env python3
"""An email for each new bug report on the speedrun board (scene.rs/runs).

The worker (worker.py) keeps each report in DATA/bugs/<id>/report.json,
with its recording; it runs with no network, so this does the telling:
from the maintainer's own crontab on the board's box, a few minutes
apart, through the box's mail system (/usr/sbin/sendmail), once a report.

    RUNS_NOTIFY_TO=you@example.org notify.py           mail the new ones
    RUNS_NOTIFY_TO=you@example.org notify.py --test ID  mail that one again, to see it arrive

The reports already told are listed in ~/.local/state/runs-notify/told;
the first run tells none of the reports already there, only notes them.
"""

import email.message
import json
import os
import subprocess
import sys

ROOT = os.environ.get("RUNS_ROOT", "/srv/runs")
BUGS = os.path.join(ROOT, "data", "bugs")
STATE = os.path.expanduser(os.environ.get("RUNS_NOTIFY_STATE", "~/.local/state/runs-notify"))
TOLD = os.path.join(STATE, "told")
FROM = os.environ.get("RUNS_NOTIFY_FROM", "scene.rs runs <runs@beehive42.org>")
ENVELOPE = os.environ.get("RUNS_NOTIFY_ENVELOPE", "runs@beehive42.org")  # beehive42.org's SPF names this box


def report(id_):
    with open(os.path.join(BUGS, id_, "report.json")) as f:
        return json.load(f)


def letter(id_, r, to):
    meta, replay = r.get("meta", {}), r.get("replay", {})
    who = meta.get("nick") or "someone"
    first = " ".join((meta.get("note") or "").split())
    m = email.message.EmailMessage()
    m["From"] = FROM
    m["To"] = to
    m["Subject"] = "Portals bug report from %s: %s" % (who, first[:60] + ("..." if len(first) > 60 else ""))
    lines = [
        "A bug report came in on https://scene.rs/runs/.",
        "",
        "From:     %s" % who,
        "Reach:    %s" % (meta.get("contact") or "(nothing given)"),
        "Received: %s" % meta.get("received", "?"),
        "Version:  %s" % (replay.get("version") or "?"),
        "",
        meta.get("note") or "(no words)",
        "",
    ]
    if replay.get("ok"):
        lines.append("The replay (%s, %s physics): %s, %.3f s to the exits." % (
            replay.get("kind"), replay.get("physics"), "complete" if replay.get("complete") else "not complete",
            replay.get("total") or 0))
        for run in replay.get("runs", []):
            lines.append("  %-28s %8.3f s  %s" % (run.get("name") or run.get("chamber"), run.get("time") or 0,
                                                   "exit" if run.get("exit") else (run.get("why") or "no exit")))
    else:
        lines.append("The replay failed: %s" % replay.get("error"))
    lines += [
        "",
        "Look at it:  ssh scene.rs python3 /srv/runs/app/admin.py bug %s" % id_,
        "Recording:   %s" % os.path.join(BUGS, id_, "recording.txt"),
        "Handled:     ssh scene.rs python3 /srv/runs/app/admin.py done %s" % id_,
    ]
    m.set_content("\n".join(lines) + "\n", cte="8bit")
    return m


def send(m):
    subprocess.run(["/usr/sbin/sendmail", "-t", "-oi", "-f", ENVELOPE], input=m.as_bytes(), check=True, timeout=60)


def main():
    to = os.environ.get("RUNS_NOTIFY_TO")
    if not to:
        sys.exit("RUNS_NOTIFY_TO: whom to tell")
    if len(sys.argv) == 3 and sys.argv[1] == "--test":
        send(letter(sys.argv[2], report(sys.argv[2]), to))
        print("sent", sys.argv[2])
        return
    os.makedirs(STATE, exist_ok=True)
    first_time = not os.path.exists(TOLD)
    told = set()
    if not first_time:
        with open(TOLD) as f:
            told = {line.strip() for line in f if line.strip()}
    for id_ in sorted(os.listdir(BUGS)):
        if id_ in told or not os.path.exists(os.path.join(BUGS, id_, "report.json")):
            continue
        if not first_time:
            try:
                send(letter(id_, report(id_), to))
            except (OSError, ValueError, subprocess.SubprocessError) as e:
                print(id_, "not told:", e)  # tried again next time
                continue
            print(id_, "told")
        with open(TOLD, "a") as f:
            f.write(id_ + "\n")


if __name__ == "__main__":
    main()
