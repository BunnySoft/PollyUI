#!/bin/busybox sh
# Root preparation service.
/bin/modprobe evdev || true
/bin/modprobe atkbd || true
/bin/modprobe i8042 || true
/bin/modprobe virtio_pci || true
/bin/modprobe virtio_gpu || true
/bin/mdev -s
/bin/mkdir -p /run/udev /dev/shm /run/polly
/bin/busybox chown 1000:1000 /run/polly
/bin/busybox chmod 700 /run/polly
/bin/mount -t tmpfs tmpfs /dev/shm 2>/dev/null || true
/usr/lib/systemd/systemd-udevd --daemon || true
/usr/bin/udevadm trigger --action=add || true
/usr/bin/udevadm settle || true
/usr/sbin/seatd -g polly >/dev/null 2>&1 &
/bin/sleep 1
