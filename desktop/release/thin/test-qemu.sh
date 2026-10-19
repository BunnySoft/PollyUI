#!/bin/sh
# Boot the Thin ISO under OVMF/KVM and require a Pixman DRM modeset.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=${THIN_WORK:-"$PWD/build/thin"}
tools=${THIN_TOOLS:-localhost/polly-sku-live-tools}

test -s "$work/thin.iso"
rm -f "$work/serial.log"
podman run --rm --pull=never --network=none --device /dev/kvm \
    -v "$work:/test" "$tools" \
    timeout 40 qemu-system-x86_64 \
      -machine q35 -bios /usr/share/ovmf/OVMF.fd -accel kvm -m 2048 -smp 2 \
      -vga none -device virtio-gpu-pci -display none \
      -serial file:/test/serial.log \
      -cdrom /test/thin.iso -boot d -no-reboot || true

grep -q "Modesetting with 1280x800" "$work/serial.log"
grep -q "Allocated 1280x800 DRM dumb buffer" "$work/serial.log"
grep -q "Running Wayland compositor" "$work/serial.log"
echo "PASS: Thin ISO reached a Pixman DRM desktop"
