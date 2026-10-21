#!/bin/sh
set -eu
profile=${1:-live}
case "$profile" in live|template) ;; *) echo "Invalid payload profile" >&2; exit 2 ;; esac
test "$#" -le 2
if [ "$#" -eq 2 ]; then
    hardware_sku=$2
    python3 -I -B /workspace/desktop/release/debian/live-profile.py verify --sku "$hardware_sku"
else
    hardware_sku=full
    python3 -I -B /workspace/desktop/release/debian/live-profile.py verify
fi
test -f /etc/polly-account-profile
test ! -L /etc/polly-account-profile
test "$(cat /etc/polly-account-profile)" = "$profile"
test "$(stat -c '%a:%u:%g:%h' /etc/polly-account-profile)" = 644:0:0:1
. /etc/os-release
test "$ID" = debian
test "$VERSION_CODENAME" = trixie
set -- /lib/modules/*
test "$#" -eq 1
kernel=${1##*/}
if [ "$hardware_sku" = basic ]; then
    python3 -I -B /workspace/desktop/release/debian/live-profile.py kernel --sku basic --config "/boot/config-$kernel"
fi
modules=$(python3 -I -B /workspace/desktop/release/debian/live-profile.py modules --sku "$hardware_sku")
for module in $modules; do
    modinfo -k "$kernel" -n "$module"
    modprobe --set-version "$kernel" --show-depends --ignore-install "$module" >/dev/null
done
if [ "$hardware_sku" = full ]; then
    python3 -I -B /workspace/desktop/release/debian/standard-hardware.py
fi
if [ -e /etc/polly-hardware-profile.json ]; then
    for source in live-profile.py live-profiles.json basic-kernel.py live-display.py standard-hardware.py network-sysctl.conf; do
        cmp "/workspace/desktop/release/debian/$source" "/usr/lib/polly-hardware/$source"
        test "$(stat -c '%a:%u:%g:%h' "/usr/lib/polly-hardware/$source")" = 644:0:0:1
    done
    cmp /workspace/desktop/tools/live-root.py /usr/lib/polly-hardware/live-root.py
fi
if [ "$hardware_sku" = full ]; then
    cmp /usr/lib/polly-hardware/network-sysctl.conf /etc/sysctl.d/70-polly-live-network.conf
    test "$(stat -c '%a:%u:%g:%h' /etc/sysctl.d/70-polly-live-network.conf)" = 644:0:0:1
fi
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
python3 -I -B /workspace/desktop/release/debian/power-policy.py / /workspace usr/share/polly-live-packages.tsv
getty_override=/etc/systemd/system/getty@tty1.service.d/polly.conf
if [ -e /usr/share/polly-live-boot-dependencies.json ] || [ -L /usr/share/polly-live-boot-dependencies.json ]; then
    test "$profile" = live
    test -f /usr/share/polly-live-boot-dependencies.json
    test ! -L /usr/share/polly-live-boot-dependencies.json
    for old in polly.conf live-boot.conf; do
        path=/etc/systemd/system/getty@tty1.service.d/$old
        if [ -e "$path" ] || [ -L "$path" ]; then
            echo "Obsolete final Live getty override: $path" >&2
            exit 1
        fi
    done
    python3 -I -B /workspace/desktop/release/debian/boot-install.py verify /workspace
    getty_override=/etc/systemd/system/getty@tty1.service.d/zz-polly-live.conf
fi
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
    "$getty_override" /etc/systemd/system/polly-hardware-log.service; do
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
