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

FILES="index.html scene.css scene.js .htaccess favicon.ico models music"
[ -d stories ] && FILES="$FILES stories"

if [ "${1:-}" = "--go" ]; then
	DRY=
else
	DRY=--dry-run
	echo "Dry run. Use --go to copy." >&2
fi

# --checksum: compare contents, not mtimes, so a fresh checkout does not resend everything.
# test/ holds tests and mocks, not pages.
# shellcheck disable=SC2086
rsync -rltv --checksum --chmod=D775,F664 --exclude=test/ $DRY $FILES "$DEPLOY_HOST:$DEPLOY_ROOT/"
