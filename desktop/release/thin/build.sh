#!/bin/sh
# Build the Thin prototype ISO from the Debian minbase rootfs.
#
# Prerequisites:
#   - PIXMAN_DIR contains build/tinywl/tinywl and prefix/lib/libwlroots-*.so
#     (build it with desktop/tools/experiments/pixman-build.sh)
#   - local images: polly-debian-minbase, polly-debian-live-base,
#     polly-debian-sdk, polly-sku-live-tools
#
# Usage:
#   PIXMAN_DIR=$PWD/build/pixman-exp THIN_WORK=$PWD/build/thin \
#     sh desktop/release/thin/build.sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=${THIN_WORK:-"$PWD/build/thin"}
pixman=${PIXMAN_DIR:-"$PWD/build/pixman-exp"}
root=$work/root

test -x "$pixman/build/tinywl/tinywl"
test -f "$pixman/prefix/lib/libwlroots-0.19-polly-effects4.so"

rm -rf "$work"
mkdir -p "$root"
podman create --name thin-base localhost/polly-debian-minbase >/dev/null
podman export thin-base > "$work/root.tar"
podman rm thin-base >/dev/null
tar -C "$root" -xf "$work/root.tar"
rm -f "$work/root.tar"

mkdir -p "$root/lib/modules"
podman create --name thin-kernel localhost/polly-debian-live-base >/dev/null
podman cp thin-kernel:/boot/vmlinuz-6.12.113+deb13-amd64 "$work/vmlinuz"
podman cp thin-kernel:/lib/modules/6.12.113+deb13-amd64 "$root/lib/modules/"
podman rm thin-kernel >/dev/null

mkdir -p "$root/usr/local/bin" "$root/usr/local/lib"
podman run --rm --pull=never -v "$work:/thin" -v "$pixman:/pix:ro" \
    -v "$here/../../..:/src:ro" localhost/polly-debian-sdk sh -c '
set -e
cp /pix/build/tinywl/tinywl /thin/root/usr/local/bin/tinywl
cp /pix/prefix/lib/libwlroots-0.19-polly-effects4.so /thin/root/usr/local/lib/
wayland-scanner client-header /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml /thin/xdg-shell-client-protocol.h
wayland-scanner private-code /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml /thin/xdg-shell-protocol.c
gcc -O2 -I/thin -o /thin/root/usr/local/bin/color-client \
  /src/desktop/tools/experiments/pixman-client.c /thin/xdg-shell-protocol.c -lwayland-client
for binary in /pix/build/tinywl/tinywl /thin/root/usr/local/bin/color-client; do
  ldd "$binary" | sed -n "s/.*=> \(\/[^ ]*\).*/\1/p; s/^\(\/[^ ]*\) .*/\1/p" | while read -r src; do
    case "$src" in
      /pix/*) continue ;;
      /*)
        dst="/thin/root$src"
        mkdir -p "$(dirname "$dst")"
        cp -L "$src" "$dst"
        ;;
    esac
  done
done
cp -L /lib64/ld-linux-x86-64.so.2 /thin/root/lib64/
'
podman run --rm --pull=never -v "$root:/r" localhost/polly-sku-live-tools \
    sh -c 'cp /bin/busybox /r/bin/busybox; chmod 755 /r/bin/busybox'
for applet in sh mount umount mkdir mdev modprobe cat sleep ls dmesg; do
    ln -sf busybox "$root/bin/$applet"
done

cat > "$root/init" <<'EOF'
#!/bin/busybox sh
/bin/mount -t devtmpfs devtmpfs /dev
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
/bin/mdev -s
/bin/modprobe virtio_pci || true
/bin/modprobe virtio_gpu || true
/bin/mdev -s
echo "THIN: drm nodes:"; /bin/ls -l /dev/dri 2>&1 || true
export XDG_RUNTIME_DIR=/run
export WLR_BACKENDS=drm
export WLR_RENDERER=pixman
export LIBSEAT_BACKEND=builtin
export WLR_LIBINPUT_NO_DEVICES=1
export LD_LIBRARY_PATH=/usr/local/lib:/opt/pollyui-input/lib:/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu
echo "THIN: starting tinywl"
/usr/local/bin/tinywl &
sleep 2
echo "THIN: starting client"
WAYLAND_DISPLAY=wayland-0 /usr/local/bin/color-client &
while :; do /bin/sleep 3600; done
EOF
chmod 755 "$root/init"

(cd "$root" && find . -print0 | cpio --null -o --format=newc 2>/dev/null | gzip -1 > "$work/initramfs.gz")

mkdir -p "$work/iso/boot/grub"
cp "$work/vmlinuz" "$work/iso/boot/vmlinuz"
cp "$work/initramfs.gz" "$work/iso/boot/initramfs.gz"
cat > "$work/iso/boot/grub/grub.cfg" <<'EOF'
set timeout=0
set default=0
menuentry "Polly Thin" {
    linux /boot/vmlinuz console=ttyS0
    initrd /boot/initramfs.gz
}
EOF
podman run --rm --pull=never -v "$work:/t" localhost/polly-sku-live-tools \
    grub-mkrescue -o /t/thin.iso /t/iso > "$work/grub.log" 2>&1
test -s "$work/thin.iso"
ls -lh "$work/thin.iso"
