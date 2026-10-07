#!/bin/sh
set -eu
test "$(id -u)" -eq 0
test -f /run/.containerenv
test -x /usr/sbin/policy-rc.d
if /usr/sbin/policy-rc.d; then exit 1; else test "$?" -eq 101; fi
test ! -e /usr/bin/pollyui
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends /inputs/packages/*.deb
set -- /runtime/pollydesktop-*-debian13-x86_64.tar.gz
test "$#" -eq 1
tar -xzf "$1" -C /
useradd --create-home --uid 1000 --shell /bin/sh polly
su -s /bin/sh polly -c 'PU_RENDERER=raster SDL_RENDER_DRIVER=software polly-desktop --headless --ime --audio --check'
su -s /bin/sh polly -c 'SDL_VIDEODRIVER=dummy PU_RENDERER=raster SDL_RENDER_DRIVER=software polly-app install /fixture && SDL_VIDEODRIVER=dummy PU_RENDERER=raster SDL_RENDER_DRIVER=software polly-app run org.example.packaged && SDL_VIDEODRIVER=dummy PU_RENDERER=raster SDL_RENDER_DRIVER=software polly-app run org.example.packaged'
echo "PASS: retained Debian binaries reconstruct an installed runtime without network or SDK"
