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
# The mock's AppFS is all abort(): give it a small one in memory, 16 apps, 16 MB of "flash".
cat > src/appfs_mock/appfs.c <<'C'
#include "appfs.h"
#include <stdlib.h>
#include <string.h>
#define N 16
static struct { int used; char name[48], title[64]; uint16_t version; size_t size; uint8_t* data; } apps[N];
static int find(const char* n) { for (int i = 0; i < N; i++) if (apps[i].used && !strcmp(apps[i].name, n)) return i; return -1; }
static size_t used(void) { size_t u = 0; for (int i = 0; i < N; i++) if (apps[i].used) u += apps[i].size; return u; }
int appfsExists(const char* n) { return find(n) >= 0; }
appfs_handle_t appfsOpen(const char* n) { return find(n); }
esp_err_t appfsDeleteFile(const char* n) {
    int i = find(n);
    if (i < 0) return ESP_ERR_NOT_FOUND;
    free(apps[i].data); apps[i].used = 0; return ESP_OK;
}
esp_err_t appfsCreateFileExt(const char* n, const char* title, uint16_t version, size_t size, appfs_handle_t* h) {
    appfsDeleteFile(n);   /* like AppFS: a new file of the same name replaces the old */
    if (used() + size > appfsGetTotalMem()) return ESP_ERR_NO_MEM;
    for (int i = 0; i < N; i++) if (!apps[i].used) {
        apps[i].used = 1; strncpy(apps[i].name, n, 47); strncpy(apps[i].title, title, 63);
        apps[i].version = version; apps[i].size = size; apps[i].data = calloc(1, size + 1);
        *h = i; return ESP_OK;
    }
    return ESP_ERR_NO_MEM;
}
esp_err_t appfsErase(appfs_handle_t fd, size_t start, size_t len) { (void)fd; (void)start; (void)len; return ESP_OK; }
esp_err_t appfsWrite(appfs_handle_t fd, size_t start, uint8_t* buf, size_t len) {
    if (fd < 0 || fd >= N || !apps[fd].used || start + len > apps[fd].size) return ESP_FAIL;
    memcpy(apps[fd].data + start, buf, len); return ESP_OK;
}
esp_err_t appfsRead(appfs_handle_t fd, size_t start, void* buf, size_t len) {
    if (fd < 0 || fd >= N || !apps[fd].used || start + len > apps[fd].size) return ESP_FAIL;
    memcpy(buf, apps[fd].data + start, len); return ESP_OK;
}
void appfsEntryInfoExt(appfs_handle_t fd, const char** name, const char** title, uint16_t* version, int* size) {
    if (name) *name = apps[fd].name;
    if (title) *title = apps[fd].title;
    if (version) *version = apps[fd].version;
    if (size) *size = (int)apps[fd].size;
}
appfs_handle_t appfsNextEntry(appfs_handle_t fd) {
    for (int i = fd < 0 ? 0 : fd + 1; i < N; i++) if (apps[i].used) return i;
    return APPFS_INVALID_FD;
}
size_t appfsGetFreeMem() { return appfsGetTotalMem() - used(); }
size_t appfsGetTotalMem() { return 16u << 20; }
C
cmake -B build >/dev/null && cmake --build build >/dev/null
echo "$out/mock/build/badgemock"
