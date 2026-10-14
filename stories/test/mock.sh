#!/usr/bin/env bash
# Build badgemock: the badge's own BadgeLink C code (badge.team esp32-component-badgelink) as a
# host program, with the host's filesystem as the SD card. Copies the component out of tree and
# patches what the upstream mock misses, so the component itself stays untouched.
#
#   test/mock.sh [badgelink dir] [build dir]     -> prints the path of the badgemock binary
set -euo pipefail
src=${1:-$HOME/Projects/tanmatsu-portal/badgelink}
out=${2:-${TMPDIR:-/tmp}/scene-badgemock}
rm -rf "$out" && mkdir -p "$out"
cp -r "$src"/*.c "$src"/*.h "$src"/mock "$src"/nanopb "$out"/
rm -rf "$out/mock/build"
cd "$out/mock"
# badgelink_start() takes the send callback now, and the badge's answers must not sit in stdio.
sed -i 's#badgelink_start();#badgelink_start(usb_send_data);#; s#fwrite(data, 1, len, mock__outfd);#&\n    fflush(mock__outfd);#' src/main.c
# badgelink_fs.c wants ESP-IDF's heap_caps_malloc.
printf '#pragma once\n#include <stdlib.h>\n#define MALLOC_CAP_DMA 0\n#define MALLOC_CAP_INTERNAL 0\n#define heap_caps_malloc(size, caps) malloc(size)\n' > src/esp_mock/esp_heap_caps.h
# Start-app and USB-mode requests are not part of the mock: answer them "not supported".
printf '#include "badgelink_internal.h"\nvoid badgelink_startapp_handle(void) { badgelink_status_unsupported(); }\nvoid badgelink_setusbmode_handle(void) { badgelink_status_unsupported(); }\n' > src/stubs.c
sed -i 's#    src/main.c#&\n    src/stubs.c#' CMakeLists.txt
cmake -B build >/dev/null && cmake --build build >/dev/null
echo "$out/mock/build/badgemock"
