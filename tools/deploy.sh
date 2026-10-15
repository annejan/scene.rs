#!/bin/sh
# Copy the served files to the web root on scene.rs.
#
#   tools/deploy.sh          dry run: show what would change
#   tools/deploy.sh --go     copy for real
#
# Only the files below are sent. Files that exist only on the server
# (pets/, keybase.txt) are never touched: there is no --delete.
set -eu

DEPLOY_HOST=${DEPLOY_HOST:-scene.rs}
DEPLOY_ROOT=${DEPLOY_ROOT:-sceners}

cd "$(dirname "$0")/.."

FILES="index.html scene.css scene.js .htaccess favicon.ico robots.txt sitemap.xml models music"
[ -d stories ] && FILES="$FILES stories"
[ -d runs ] && FILES="$FILES runs"

if [ "${1:-}" = "--go" ]; then
	DRY=
else
	DRY=--dry-run
	echo "Dry run. Use --go to copy." >&2
fi

# --checksum: compare contents, not mtimes, so a fresh checkout does not resend everything.
# test/ holds tests and mocks, not pages.
# shellcheck disable=SC2086
# runs/data is the board's, a symlink made on the server (server/runs/setup.sh).
rsync -rltv --checksum --chmod=D775,F664 --exclude=test/ --exclude=runs/data $DRY $FILES "$DEPLOY_HOST:$DEPLOY_ROOT/"
# The board's worker and its tools, into /srv/runs/app (the group runs may write there).
if [ -d server/runs ]; then
	rsync -rltvO --checksum --chmod=D2775,F664 $DRY server/runs/worker.py server/runs/admin.py server/runs/notify.py "$DEPLOY_HOST:/srv/runs/app/"
fi
