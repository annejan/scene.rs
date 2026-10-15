#!/bin/sh
# Once, as root, on the annejan.com box: the speedrun board's film
# renderer, as its own user, and the timer that runs it. Safe to run again.
#
#   sudo sh server/films/setup.sh [MAINTAINER]
#
#   /srv/runfilm/      the user `runfilm` (no login)
#     app/             Portals' tools/make_movie.py, textures/, metadata/   (the maintainer deploys)
#     bin/             movie-<physics>, Portals' `make board-tools`        (the maintainer deploys)
#     packs/           the story packs                                      (the maintainer deploys)
#     work/            a film being made: gone when it is done
#     out/             the films: annejan.com/portals/runs/ (a symlink there)
#     c64/             the C64 demos' films, disks and films.json: vidr.nl/c64/ (the maintainer copies them)
set -eu

WHO=${1:-annejan}
apt-get install -y --no-install-recommends ffmpeg python3-pil fonts-dejavu-core
id runfilm >/dev/null 2>&1 || useradd --system --home-dir /srv/runfilm --no-create-home --shell /usr/sbin/nologin runfilm
usermod -aG runfilm "$WHO"
install -d -o runfilm -g runfilm -m 2775 /srv/runfilm /srv/runfilm/app /srv/runfilm/bin /srv/runfilm/packs /srv/runfilm/out /srv/runfilm/c64
install -d -o runfilm -g runfilm -m 2770 /srv/runfilm/work

cat > /etc/systemd/system/runfilm-render.service <<'EOF'
[Unit]
Description=Portals speedrun board: film the new runs
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=runfilm
Group=runfilm
UMask=0002
Nice=15
IOSchedulingClass=idle
ExecStart=/usr/bin/python3 /srv/runfilm/app/render.py
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/srv/runfilm
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
MemoryMax=3G
CPUQuota=300%
TimeoutStartSec=2h
EOF

cat > /etc/systemd/system/runfilm-render.timer <<'EOF'
[Unit]
Description=Portals speedrun board: look for runs to film every two minutes

[Timer]
OnBootSec=3min
OnUnitInactiveSec=2min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now runfilm-render.timer
echo "Done. $WHO is in the group runfilm: log in again for it to count."
