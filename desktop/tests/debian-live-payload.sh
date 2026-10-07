#!/bin/sh
set -eu
. /etc/os-release
test "$ID" = debian
test "$VERSION_CODENAME" = trixie
set -- /lib/modules/*
test "$#" -eq 1
kernel=${1##*/}
for module in i915 nouveau igc iwlwifi snd_hda_intel xhci_pci usb_storage virtio_gpu; do
    modinfo -k "$kernel" -n "$module"
done
test -r /boot/intel-ucode.img
test -r /lib/firmware/regulatory.db
test -s /usr/share/polly-live-packages.tsv
test -s /usr/share/licenses/pollyui/mesa/runtime-packages.txt
while IFS='=' read -r package version; do
    test "$(dpkg-query -W -f='${Version}' "$package")" = "$version" || {
        echo "Live assembly changed the corrected Mesa package: $package" >&2; exit 1;
    }
done < /usr/share/licenses/pollyui/mesa/runtime-packages.txt
test -s /usr/share/licenses/pollyui/mesa/mesa-lifetime.patch
test -s /usr/share/licenses/pollyui/mesa/source-inputs.json
test -z "$(find /var/cache/apt/archives -name '*.deb' -print -quit)"
test ! -f /var/cache/apt/pkgcache.bin
test ! -f /var/cache/apt/srcpkgcache.bin
test -z "$(grep -v '^#' /etc/fstab | tr -d '[:space:]')"
id -Gn polly | grep -qw netdev
id -Gn polly | grep -qw audio
test "$(getent passwd polly | cut -d: -f3)" -eq 1000
grep -q 'session required pam_systemd.so' /etc/pam.d/login
grep -q 'CanPowerOff' /etc/dbus-1/system.d/polly-live-power.conf
grep -q 'HandlePowerKey=ignore' /etc/systemd/logind.conf.d/50-polly.conf
grep -q '^resolv_conf=/run/polly-network/resolv.conf$' /etc/resolvconf.conf
for unit in apt-daily.timer apt-daily-upgrade.timer fstrim.timer; do
    test "$(systemctl is-enabled "$unit" || true)" = masked
done
for unit in getty@tty1.service iwd.service dhcpcd.service; do
    systemctl is-enabled "$unit"
done
for file in /etc/pam.d/login /etc/pam.d/polly-lock /etc/iwd/main.conf /etc/dhcpcd.conf \
    /etc/systemd/logind.conf.d/50-polly.conf /etc/systemd/journald.conf.d/polly.conf \
    /etc/systemd/system/getty@tty1.service.d/polly.conf /etc/systemd/system/polly-hardware-log.service; do
    test "$(stat -c '%a:%u:%g' "$file")" = 644:0:0
    if grep -q "$(printf '\r')" "$file"; then echo "CRLF configuration: $file" >&2; exit 1; fi
done
for file in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list.d/backports.sources; do
    test "$(stat -c '%a:%u:%g' "$file")" = 644:0:0
done
for file in /init /usr/bin/polly-live-session /usr/bin/polly-live-diagnostics \
    /usr/bin/polly-boot-hardware /usr/share/pollyui/desktop/tools/live-session-mode.sh; do
    sh -n "$file"
    if grep -q "$(printf '\r')" "$file"; then echo "CRLF script: $file" >&2; exit 1; fi
done
for binary in /usr/bin/pollyui /usr/bin/pollywm /usr/bin/polly-auth-check; do
    libraries=$(ldd "$binary")
    if printf '%s\n' "$libraries" | grep -E 'not found|lib(glib|gio|gobject)-2\.0|/opt/pollyui'; then
        echo "Invalid installed runtime dependency: $binary" >&2; exit 1
    fi
done
echo "PASS: Debian systemd/PAM Live payload, hardware drivers and isolated ordinary-user runtime"
