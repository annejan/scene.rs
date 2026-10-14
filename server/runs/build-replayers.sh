#!/bin/sh
# The board's replays, one per physics: Portals' tests/host_runcheck.c (from
# its main branch) built static against each physics' last release, so they
# run on beehive as they are. Out: OUT/runcheck-<physics>.
#
#   server/runs/build-replayers.sh [PORTALS_REPO] [OUT]
#
# A new physics (GAME_PHYSICS in Portals' main/game.h) wants a line below
# and one in worker.py's PHYSICS.
set -eu

REPO=${1:-$HOME/Projects/tanmatsu-portal}
OUT=${2:-$(pwd)/build/replayers}
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'git -C "$REPO" worktree prune; rm -rf "$WORK"' EXIT

build() {  # physics, git ref
	dir="$WORK/$1"
	git -C "$REPO" worktree add -q --detach "$dir" "$2"
	cp "$REPO/tests/host_runcheck.c" "$dir/tests/host_runcheck.c"
	(cd "$dir" && make chambers_c >/dev/null)
	srcs=$(sed -n 's/^HOST_SRCS *:= *//p;' "$dir/Makefile" | tr -d '\\')
	cont=$(sed -n '/^HOST_SRCS *:=/{n;p}' "$dir/Makefile" | tr -d '\\' | sed 's#$(BUILD)#build#')
	(cd "$dir" && cc -O2 -static -Imain tests/host_runcheck.c $srcs $cont -lm -o "$OUT/runcheck-$1")
	got=$("$OUT/runcheck-$1" /dev/null | sed -n 's/.*"physics":"\([^"]*\)".*/\1/p')
	[ "$got" = "$1" ] || { echo "runcheck-$1 says its physics is $got" >&2; exit 1; }
	git -C "$REPO" worktree remove --force "$dir"
	echo "$OUT/runcheck-$1"
}

build 0.12.0 v0.12.7
build 0.12.8 main
