#!/bin/sh
# The board's replays, one per physics, from Portals' `make board-tools`
# (each physics built from the current code with PORTALS_PHYSICS), static,
# so they run on beehive as they are. Copies them, and the film tools for
# the renderer, to OUT.
#
#   server/runs/build-replayers.sh [PORTALS_REPO] [OUT]
#
# A new physics (GAME_PHYSICS in Portals' main/game.h) wants a line in its
# Makefile's BOARD_PHYSICS and in worker.py's PHYSICS.
set -eu
REPO=${1:-$HOME/Projects/tanmatsu-portal}
OUT=${2:-$(pwd)/build/replayers}
make -C "$REPO" board-tools >/dev/null
mkdir -p "$OUT"
cp "$REPO"/build/board/runcheck-* "$REPO"/build/board/movie-* "$OUT"/
ls "$OUT"
