#!/bin/sh
set -eu
. /etc/os-release
test "$ID" = debian
test "$VERSION_CODENAME" = trixie
test "$(dpkg --print-architecture)" = amd64
getconf GNU_LIBC_VERSION
test -s /usr/share/polly-minbase-packages.txt
test "$(stat -c '%a:%u:%g' /etc/apt/sources.list.d/debian.sources)" = 644:0:0
test ! -f /etc/apt/sources.list
grep -q '^Suites: trixie trixie-updates[[:space:]]*$' /etc/apt/sources.list.d/debian.sources
grep -q '^Suites: trixie-security[[:space:]]*$' /etc/apt/sources.list.d/debian.sources
grep -q '^Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg[[:space:]]*$' /etc/apt/sources.list.d/debian.sources
if dpkg-query -W -f='${binary:Package}\n' | grep -E '^(gnome-shell|plasma-desktop|task-.+-desktop|build-essential|gcc|clang|debootstrap)$'; then
    echo "Unexpected desktop or SDK package in minbase" >&2
    exit 1
fi
if /usr/sbin/policy-rc.d; then result=0; else result=$?; fi
test "$result" -eq 101
printf 'PASS: Debian trixie amd64 minbase, glibc, signed fixed suites and no desktop/SDK\n'
