#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$here/libinput.json")
test "$(dpkg-query -W -f='${Version}' libinput10)" = "$version"
mkdir -p /opt/pollyui-input-source
chown _apt:root /opt/pollyui-input-source
cd /opt/pollyui-input-source
apt-get source "libinput=$version"
meson setup libinput-1.28.1/build libinput-1.28.1 \
    --prefix=/opt/pollyui-input --libdir=lib --datadir=/usr/share --buildtype=release \
    --wrap-mode=nofallback -Dlibwacom=false -Ddebug-gui=false -Dtests=false \
    -Ddocumentation=false
meson compile -C libinput-1.28.1/build -j 2
DESTDIR=/opt/pollyui-input-staged meson install -C libinput-1.28.1/build
cp -a /opt/pollyui-input-staged/opt/pollyui-input /opt/pollyui-input
patchelf --set-rpath /opt/pollyui-input/lib /opt/pollyui-wlroots/lib/libwlroots-0.19.so
if ldd /opt/pollyui-wlroots/lib/libwlroots-0.19.so | grep -E 'lib(glib|gio|gobject)-2\.0|not found'; then
    echo "Unexpected private wlroots/input dependency" >&2
    exit 1
fi
