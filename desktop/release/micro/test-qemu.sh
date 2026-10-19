#!/bin/sh
# Boot the Micro ISO under OVMF/KVM and require a DRM modeset in the serial log.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=${MICRO_WORK:-"$PWD/build/micro"}
tools=${MICRO_TOOLS:-localhost/polly-sku-live-tools}

test -s "$work/micro.iso"
rm -f "$work/micro-serial.log"
podman run --rm --pull=never --network=none --device /dev/kvm \
    -v "$work:/test" "$tools" \
    timeout 30 qemu-system-x86_64 \
      -machine q35 -bios /usr/share/ovmf/OVMF.fd -accel kvm -m 2048 -smp 2 \
      -vga none -device virtio-gpu-pci -display none \
      -serial file:/test/micro-serial.log \
      -cdrom /test/micro.iso -boot d -no-reboot || true

grep -q "Modesetting with 1280x800" "$work/micro-serial.log"
grep -q "Allocated 1280x800 DRM dumb buffer" "$work/micro-serial.log"
grep -q "Running Wayland compositor" "$work/micro-serial.log"
echo "PASS: Micro ISO reached a Pixman DRM desktop"
