#!/bin/busybox sh
# Started by polly.service after systemd has mounted the basic filesystems.
/bin/modprobe evdev || true
/bin/modprobe atkbd || true
/bin/modprobe i8042 || true
/bin/modprobe virtio_pci || true
/bin/modprobe virtio_gpu || true
/bin/mdev -s
/bin/mkdir -p /run/udev /dev/shm /run/polly
/bin/mount -t tmpfs tmpfs /dev/shm 2>/dev/null || true
/usr/lib/systemd/systemd-udevd --daemon || true
/usr/bin/udevadm trigger --action=add || true
/usr/bin/udevadm settle || true
/bin/busybox chmod 700 /run/polly
export XDG_RUNTIME_DIR=/run/polly WLR_BACKENDS=drm,libinput WLR_RENDERER=pixman LIBSEAT_BACKEND=builtin
export SDL_VIDEODRIVER=wayland SDL_RENDER_DRIVER=software PU_RENDERER=raster
export LD_LIBRARY_PATH=/usr/local/lib:/opt/pollyui-input/lib:/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu
export HOME=/root PATH=/usr/local/bin:/usr/bin:/bin
cd /usr/share/pollyui
/usr/local/bin/pollywm --input-method /usr/local/bin/run-input-method.sh \
    --shell /usr/local/bin/pollyui --desktop /usr/share/pollyui/desktop/shell/live.mjs &
while :; do /bin/sleep 3600; done
