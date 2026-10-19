# 纯 CPU wlroots（Pixman）与 QEMU DRM 验证

本文记录为 `minimal-zh-cpu` / `micro` / `thin` 做的前置实验。结论只覆盖实验路径，不是生产 RTM。

## 1. 构建

以 wlroots 0.19.3 为源，使用：

```sh
-Drenderers= -Dallocators= -Dbackends=drm
```

即：

- 不编译 GLES2 / Vulkan
- 不编译 GBM / udmabuf allocator
- 保留 Pixman renderer、shm allocator、`drm_dumb` allocator

为让 DRM backend 接受 Pixman renderer，实验中删除了
`backend/drm/renderer.c` 对 `WLR_BUFFER_CAP_DMABUF` 的硬性检查。
这是**实验补丁**，不是生产修改。

参考脚本：

- `desktop/tools/experiments/pixman-build.sh`
- `desktop/tools/experiments/pixman-client.c`

## 2. Headless 结果

`ldd` 确认 `libwlroots` 和 `tinywl` 不含：

- `libgbm`
- `libEGL`
- `libGLES`
- `libLLVM`

运行：

```sh
WLR_BACKENDS=headless WLR_RENDERER=pixman tinywl
```

日志：

```text
Loading WLR_RENDERER option: pixman
Creating pixman renderer
Created shm allocator
Created pixman buffer 1280x720
Running Wayland compositor on WAYLAND_DISPLAY=wayland-0
```

## 3. QEMU virtio-gpu DRM 结果

QEMU/KVM，`virtio-gpu-pci`，无宿主 `/dev/dri`：

```sh
qemu-system-x86_64 -machine q35 -accel kvm -m 2048 -smp 2 \
  -vga none -device virtio-gpu-pci -display none \
  -kernel vmlinuz -initrd initramfs.gz \
  -append "console=ttyS0" -qmp unix:qmp.sock,server=on,wait=off
```

Guest 内：

```sh
WLR_BACKENDS=drm WLR_RENDERER=pixman \
LIBSEAT_BACKEND=builtin WLR_LIBINPUT_NO_DEVICES=1 \
tinywl
```

日志关键行：

```text
connector Virtual-1: Modesetting with 1280x800 @ 74.994 Hz
Allocated 1280x800 DRM dumb buffer
Created pixman buffer 1280x800
Running Wayland compositor on WAYLAND_DISPLAY=wayland-0
```

实际输出截图（1280x800，SHM 客户端橙色窗口）：

`dist/pixman-experiment/drm-color.png`

构建/日志证据：

- `dist/pixman-experiment/drm-color.png`
- `dist/pixman-experiment/qemu-color-serial.log`
- `dist/pixman-experiment/report.md`
- `dist/pixman-experiment/ldd.txt`

## 4. 发现

- wlroots **可以**纯 CPU 运行：Pixman + shm/drm_dumb 已实际工作
- wlroots **可以**在 virtio-gpu 上完成真实 KMS modeset 和可见输出
- SHM 客户端不能直接 scan-out：
  ```text
  Failed to get DMA-BUF from buffer
  Failed to import buffer for scan-out
  ```
  wlroots 回退到渲染进自己的 dumb buffer，再扫描输出；截图证明回退可见
- 该回退路径性能低于 GLES 直出，且需要正式的错误处理/ABI/资格

## 5. 离生产还差

1. 把“删 DMABUF 检查”改成受支持的 `drm_dumb`/Pixman DRM 模式
2. PollyWM 完整接入，不只 `tinywl`
3. 输入、seat、libinput、多输出、模式切换、恢复
4. 字体/IME/ABI/来源收据
5. APT lock 与配置构建
6. 物理机 `simpledrm` 内核路径（stock Debian 内核当前未启用）

## 6. 复现

实验目录：

- `/root/pixman-exp`：Pixman-only wlroots + tinywl
- `/root/pixman-qemu`：kernel/initramfs/root + QEMU 启动

脚本见 `desktop/tools/experiments/`。脚本是实验参考，不是 `tools/build.sh` 的生产入口。
