#!/bin/sh
# Runs inside the Alpine builder. The working directory is /work.
set -eu

variant=${MICRO_VARIANT:-demo}
case "$variant" in demo|shell) ;; *) echo "Unknown Micro variant: $variant" >&2; exit 2 ;; esac
product=${MICRO_PRODUCT:-micro}
case "$product" in mini|micro) ;; *) echo "Unknown Alpine Shell product: $product" >&2; exit 2 ;; esac
KREL=$(basename /lib/modules/*)
ROOT=/work/initroot
rm -rf /work/build /work/prefix "$ROOT" /work/iso

backends=drm
if [ "$variant" = shell ]; then
    backends=drm,libinput
    if ! grep -q polly-effects-sha256 /work/src/meson.options; then
        python3 /repo/desktop/release/debian/apply-wlroots-effects.py /work/src
    fi
fi

python3 - <<'PY'
from pathlib import Path
p = Path("/work/src/backend/drm/renderer.c")
t = p.read_text()
old = """\tif (wlr_renderer_get_texture_formats(renderer->wlr_rend, WLR_BUFFER_CAP_DMABUF) == NULL) {
\t\twlr_log(WLR_ERROR, \"Renderer did not support importing DMA-BUFs\");
\t\twlr_renderer_destroy(renderer->wlr_rend);
\t\trenderer->wlr_rend = NULL;
\t\treturn false;
\t}
"""
if old not in t:
    raise SystemExit("DMABUF guard not found")
p.write_text(t.replace(old, "", 1))
PY

meson setup /work/build /work/src --prefix=/work/prefix --libdir=lib --buildtype=release \
    --wrap-mode=nofallback -Dexamples=true -Dxwayland=disabled \
    -Dbackends="$backends" -Drenderers= -Dallocators= \
    -Dpolly-effects-sha256=7b58c4a0c4c8a0cfac4ab8016f1f3590b463d961405102fbe133e0054fcebf0e \
    >/work/wlroots-setup.log 2>&1
ninja -C /work/build -j "${PU_BUILD_JOBS:-2}" >/work/wlroots-build.log 2>&1
ninja -C /work/build install >/work/wlroots-install.log 2>&1

if [ "$variant" = shell ]; then
    sh /src/build-shell-inside.sh
fi

wayland-scanner client-header /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml /work/xdg-shell-client-protocol.h
wayland-scanner private-code /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml /work/xdg-shell-protocol.c
gcc -O2 -I/work -o /work/color-client /src/color-client.c /work/xdg-shell-protocol.c -lwayland-client

mkdir -p "$ROOT/bin" "$ROOT/dev" "$ROOT/proc" "$ROOT/sys" "$ROOT/run" "$ROOT/tmp" "$ROOT/lib" "$ROOT/lib64" "$ROOT/etc"
cp /bin/busybox "$ROOT/bin/busybox"
chmod 755 "$ROOT/bin/busybox"
for applet in sh mount umount mkdir mdev modprobe cat sleep ls dmesg; do
    ln -sf busybox "$ROOT/bin/$applet"
done
cp /work/build/tinywl/tinywl "$ROOT/bin/tinywl"
cp /work/color-client "$ROOT/bin/color-client"
cp /work/prefix/lib/libwlroots-0.19-polly-effects4.so "$ROOT/lib/"

MODDIR="$ROOT/lib/modules/$KREL"
mkdir -p "$MODDIR"
for rel in \
  kernel/drivers/gpu/drm/clients/drm_client_lib.ko.gz \
  kernel/drivers/gpu/drm/drm.ko.gz \
  kernel/drivers/gpu/drm/drm_kms_helper.ko.gz \
  kernel/drivers/gpu/drm/drm_panel_orientation_quirks.ko.gz \
  kernel/drivers/gpu/drm/drm_shmem_helper.ko.gz \
  kernel/drivers/gpu/drm/virtio/virtio-gpu.ko.gz \
  kernel/drivers/i2c/i2c-core.ko.gz \
  kernel/drivers/video/fbdev/core/fb.ko.gz \
  kernel/drivers/video/fbdev/core/fb_sys_fops.ko.gz \
  kernel/drivers/video/fbdev/core/syscopyarea.ko.gz \
  kernel/drivers/video/fbdev/core/sysfillrect.ko.gz \
  kernel/drivers/video/fbdev/core/sysimgblt.ko.gz \
  kernel/drivers/virtio/virtio_dma_buf.ko.gz \
  kernel/drivers/virtio/virtio_input.ko.gz; do
    mkdir -p "$MODDIR/$(dirname "$rel")"
    cp "/lib/modules/$KREL/$rel" "$MODDIR/$rel"
done
for meta in modules.builtin modules.builtin.modinfo modules.order; do
    cp "/lib/modules/$KREL/$meta" "$MODDIR/$meta"
done
depmod -b "$ROOT" "$KREL"

for binary in /work/build/tinywl/tinywl /work/color-client /bin/busybox; do
    ldd "$binary" | sed -n "s/.*=> \(\/[^ ]*\).*/\1/p; s/^\(\/[^ ]*\) .*/\1/p" | while read -r src; do
        case "$src" in
            /work/*) continue ;;
            /*)
                dst="$ROOT$src"
                mkdir -p "$(dirname "$dst")"
                cp -L "$src" "$dst"
                ;;
        esac
    done
done
cp -L /lib/ld-musl-x86_64.so.1 "$ROOT/lib/" 2>/dev/null || true

if [ "$variant" = shell ]; then
    LD_LIBRARY_PATH=/work/prefix/lib python3 /src/install-shell.py "$ROOT" "$KREL"
fi

cat > "$ROOT/init" <<'EOF'
#!/bin/sh
/bin/mount -t devtmpfs devtmpfs /dev
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
/bin/mdev -s
/bin/modprobe virtio_pci || true
/bin/modprobe virtio_gpu || true
/bin/mdev -s
echo "MICRO: drm nodes:"; /bin/ls -l /dev/dri 2>&1 || true
export XDG_RUNTIME_DIR=/run
export WLR_BACKENDS=drm
export WLR_RENDERER=pixman
export LIBSEAT_BACKEND=noop
export WLR_LIBINPUT_NO_DEVICES=1
export LD_LIBRARY_PATH=/lib:/usr/lib
echo "MICRO: starting tinywl"
/bin/tinywl &
sleep 2
echo "MICRO: starting client"
WAYLAND_DISPLAY=wayland-0 /bin/color-client &
while :; do /bin/sleep 3600; done
EOF
if [ "$variant" = shell ]; then
    cp /src/shell-init "$ROOT/init"
fi
chmod 755 "$ROOT/init"

(cd "$ROOT" && find . -print0 | cpio --null -o --format=newc 2>/dev/null | gzip -1 > /work/initramfs.gz)

mkdir -p /work/iso/boot/grub
cp "/boot/vmlinuz-${KREL%%-*}-virt" /work/vmlinuz 2>/dev/null || cp /boot/vmlinuz-virt /work/vmlinuz
cp /work/initramfs.gz /work/iso/boot/initramfs.gz
cp /work/vmlinuz /work/iso/boot/vmlinuz
cat > /work/iso/boot/grub/grub.cfg <<'EOF'
set timeout=0
set default=0
menuentry "Polly Micro" {
    linux /boot/vmlinuz console=ttyS0
    initrd /boot/initramfs.gz
}
EOF
image=micro.iso
if [ "$variant" = shell ]; then
    image=micro-shell.iso
    cp /src/shell-grub.cfg /work/iso/boot/grub/grub.cfg
    if [ "$product" = mini ]; then
        image=mini.iso
        sed 's/Polly Micro Shell/Polly Mini Shell/' /src/shell-grub.cfg > /work/iso/boot/grub/grub.cfg
    fi
    cp /usr/share/grub/ascii.pf2 /work/iso/boot/grub/ascii.pf2
    grub-script-check /work/iso/boot/grub/grub.cfg
fi
grub-mkrescue -o "/work/$image" /work/iso >/work/grub.log 2>&1
if [ "$variant" = shell ]; then
    python3 /src/install-shell.py --report "/work/$image" "$KREL"
fi
