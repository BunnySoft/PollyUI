#!/bin/sh
set -eu
kernel=$(cat /usr/share/kernel/lts/kernel.release)
printf 'Kernel: %s\n' "$kernel"
for module in i915 nouveau igc iwlwifi snd_hda_intel xhci_pci usb_storage virtio_gpu; do
    modinfo -k "$kernel" -n "$module"
done
for package in linux-firmware-i915 linux-firmware-intel linux-firmware-nvidia sof-firmware \
    intel-ucode mesa-dri-gallium mesa-vulkan-nouveau iwd wireless-regdb dhcpcd openresolv; do
    apk info -e "$package"
done
test -r /boot/intel-ucode.img
test -r /boot/vmlinuz-lts
test -r /lib/firmware/regulatory.db
test -n "$(find /lib/firmware/nvidia -iname '*gsp*' -print -quit)"
test -n "$(find /lib/firmware -name 'iwlwifi-so-a0-gf-a0*' -print -quit)"
id -Gn polly | grep -qw audio
id -Gn polly | grep -qw netdev
grep -q '<policy group="netdev">' /usr/share/dbus-1/system.d/iwd-dbus.conf
grep -q '^allowinterfaces eth\* en\*$' /etc/dhcpcd.conf
grep -q '^EnableNetworkConfiguration=true$' /etc/iwd/main.conf
test -e /etc/runlevels/default/iwd
test -e /etc/runlevels/default/dhcpcd
test -e /etc/runlevels/default/polly-hardware-log
test -z "$(grep -v '^#' /etc/fstab | tr -d '[:space:]')"
for file in /init /usr/bin/polly-live-session /usr/bin/polly-live-diagnostics \
    /usr/share/pollyui/desktop/tools/live-session-mode.sh /etc/init.d/polly-hardware-log; do
    sh -n "$file"
    if grep -q "$(printf '\r')" "$file"; then echo "CRLF script: $file" >&2; exit 1; fi
done
for file in /etc/pam.d/login /etc/pam.d/polly-lock /etc/iwd/main.conf /etc/dhcpcd.conf \
    /usr/share/pollyui/desktop/tools/live-session-mode.sh; do
    test "$(stat -c '%a:%u:%g' "$file")" = 644:0:0
done
echo "PASS: physical-target Live modules, firmware, permissions and guest-only network policy"
