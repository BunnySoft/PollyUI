#!/bin/busybox sh
# Runs as UID 1000 after the root preparation service.
while read key rest; do
  [ "$key" = "Uid:" ] && echo "POLLY_UID $rest"
done </proc/self/status
export XDG_RUNTIME_DIR=/run/polly WLR_BACKENDS=drm,libinput WLR_RENDERER=pixman LIBSEAT_BACKEND=seatd SEATD_SOCK=/run/seatd.sock
export SDL_VIDEODRIVER=wayland SDL_RENDER_DRIVER=software PU_RENDERER=raster
export LD_LIBRARY_PATH=/usr/local/lib:/opt/pollyui-input/lib:/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu
export HOME=/home/polly PATH=/usr/local/bin:/usr/bin:/bin USER=polly LOGNAME=polly
cd /usr/share/pollyui
/usr/local/bin/pollywm --input-method /usr/local/bin/run-input-method.sh \
    --shell /usr/local/bin/pollyui --desktop /usr/share/pollyui/desktop/shell/live.mjs &
while :; do /bin/sleep 3600; done
