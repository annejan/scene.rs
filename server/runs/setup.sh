#!/bin/sh
# Once, as root, on beehive: the speedrun board's own user and its folders,
# and the timer that replays uploads. Safe to run again.
#
#   sudo sh server/runs/setup.sh [MAINTAINER]
#
#   /srv/runs/            the user `runs` (no login, no home of its own)
#     app/                worker.py, admin.py           (the maintainer deploys)
#     bin/                runcheck-<physics>            (the maintainer deploys)
#     packs/              the story packs, for their chambers (the maintainer deploys)
#     spool/              uploads, written by the web server (www-data), taken by `runs`
#     data/               runs.db and the bug reports: `runs` and the maintainer only
#     public/             the board, served at scene.rs/runs/data/ (a symlink there)
set -eu

WHO=${1:-annejan}
id runs >/dev/null 2>&1 || useradd --system --home-dir /srv/runs --no-create-home --shell /usr/sbin/nologin runs
usermod -aG runs "$WHO"

install -d -o runs -g runs -m 2775 /srv/runs /srv/runs/app /srv/runs/bin /srv/runs/packs /srv/runs/public
install -d -o runs -g runs -m 2770 /srv/runs/data
# The web server writes here and nothing else; `runs` owns it, so takes and removes.
install -d -o runs -g www-data -m 2770 /srv/runs/spool

cat > /etc/systemd/system/runs-worker.service <<'EOF'
[Unit]
Description=Portals speedrun board: replay what was uploaded
After=network.target

[Service]
Type=oneshot
User=runs
Group=runs
UMask=0002
ExecStart=/usr/bin/python3 /srv/runs/app/worker.py
# A recording is anyone's file: the replay gets nothing it does not need.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateNetwork=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/srv/runs
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryMax=600M
CPUQuota=50%
TimeoutStartSec=300
EOF

cat > /etc/systemd/system/runs-worker.timer <<'EOF'
[Unit]
Description=Portals speedrun board: look for uploads every half minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now runs-worker.timer
echo "Done. $WHO is in the group runs: log in again for it to count."
echo "Then, as $WHO: ln -sfn /srv/runs/public ~/sceners/runs/data"
