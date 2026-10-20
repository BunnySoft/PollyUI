# PollyOS 尺寸 SKU 阶梯

本文定义按体积划分的产品档位。它们不是同一产品的简单压缩版，而是不同合同、不同构建链的 SKU。

| SKU | 底座/初始化 | 图形 | 中文/应用 | 目标 ISO | 状态 |
|---|---|---|---|---|---:|---|
| **micro** | Alpine 3.24 + musl + BusyBox | Pixman + `drm_dumb` + `tinywl` | 无 Rime；一个 Wayland 演示应用 | 25–50 MB | **26 MB 原型已构建/已启动** |
| **thin** | Debian 13 + BusyBox | Pixman + `drm_dumb` | WQY 字体；一个应用；无 systemd/PAM/Rime | 150–220 MB | **169 MB 原型已构建/已启动** |
| **minimal-zh** | Debian 13 + systemd/PAM | Pixman + `drm_dumb` | WQY + Rime Luna + PollyUI/PollyWM | 300–400 MB | **CPU shell + 中文输入（236 MB 测试镜像）**；缺 systemd/PAM |
| **standard** | Debian 13 + systemd/PAM | GLES2 + Mesa | 完整应用、Noto、Rime、PollyUI | 约 577 MB | 已构建/已启动 |
| **full** | Debian 13 + systemd/PAM | GLES2 + Mesa + 厂商固件 | 完整硬件覆盖 | 约 726 MB | 已构建/已启动 |

## micro

**合同**

- Alpine 3.24 / musl / BusyBox init
- Linux `linux-virt` 内核
- Pixman-only wlroots + `drm_dumb`，无 GLES/GBM/LLVM
- `tinywl` + 一个 SHM 演示客户端
- 一个中文字体子集可选；不含 Rime
- 无 Debian、systemd、PAM、多应用 Shell

**非目标**

- 不是 PollyOS 完整桌面
- 不承诺中文输入、任意用户文本、多应用、PAM 登录

**构建路径**

独立 Alpine initramfs + kernel + GRUB ISO，不复用 Debian Live 链。

**实测（2026-10-20）**

- ISO：**26 MB**
- SHA-256：`cfd9fc2d9edb5dbd77326dada0349f8af1f2d41bdc6ec75f0176301ee70c0495`
- QEMU/KVM + `virtio-gpu-pci`：1280x800 modeset、`drm_dumb` + Pixman、可见 SHM 客户端
- 构建入口：`desktop/release/micro/build.sh`
- 测试入口：`desktop/release/micro/test-qemu.sh`

## thin

**合同**

- Debian 13 用户空间
- 自定义精简内核（virtio/DRM/输入/存储）
- BusyBox init
- Pixman-only wlroots + `drm_dumb`
- WQY 字体、一个应用
- 无 systemd/PAM/Rime/多应用

**非目标**

- 不能替代 `minimal-zh` 的中文输入/会话合同

**实测（2026-10-20）**

- ISO：**169 MB**
- SHA-256：`6c1ff04041314f8265ef7f33177167cf152b933a613b71a7ff8e743565be84d1`
- QEMU/KVM + `virtio-gpu-pci`：1280x800 modeset、`drm_dumb` + Pixman、可见 SHM 客户端
- 构建入口：`desktop/release/thin/build.sh`
- 测试入口：`desktop/release/thin/test-qemu.sh`
- 说明：原型尚未装入 WQY 字体；不是最终中文 thin

## minimal-zh

**合同**

- Debian 13 + systemd/PAM/UID 1000
- WQY Micro Hei + DejaVu + fontconfig
- Rime Luna 拼音
- Pixman-only wlroots + `drm_dumb`
- PollyUI/PollyWM
- 标准音频
- 无 Mesa/LLVM/Vulkan/Noto/Emoji

**已跑通（2026-10-20）**

- PollyWM 已用 Pixman-only wlroots 编译：`ldd` 不含 GBM/EGL/GLES/LLVM
- PollyUI（layer shell）已用 `PU_WEBGL2=OFF` 构建：`ldd` 同样不含 GBM/EGL/GLES/LLVM
- Debian minbase + BusyBox + Pixman PollyWM 在 QEMU virtio-gpu 下完成
  1280x800 modeset，`PollyWM ready`，客户端成功映射
- 构建入口：`desktop/release/minimal-zh/build-pollywm.sh`、
  `desktop/release/minimal-zh/build-pollyui.sh`
- 说明：`desktop/release/minimal-zh/README.md`
- 这是 native compositor 证明，不是完整 `minimal-zh` ISO

**仍缺**

- PollyUI/Polly shell 的 CPU-only 构建
- WQY + Rime Luna 与中文输入/字体资格
- systemd/PAM/UID 1000 与 Live 集成
- 受控 APT `--lock` 和 `--config minimal-zh-vm --build`
- 受支持的 `drm_dumb` 路径（不能长期依赖删除 DMABUF 检查）
- 输入、多输出、恢复、物理机资格

## 尺寸依据（实测 vm SKU）

当前 `vm` 产物：

| 项目 | 数值 |
|---|---:|
| ISO | 577.5 MB |
| root 未压缩 | 1,168.5 MB |
| 已安装包 | 1,076.9 MiB |
| Mesa/LLVM/Vulkan/GL 组 | 336.4 MiB |
| Noto 字体 | 142.5 MiB |
| 内核/模块 | 106.8 MiB |
| `pollyui` 二进制 | 11.6 MiB |

`minimal-zh` 估算：

```text
1076.9 MiB
- 336.4 MiB  Mesa/LLVM/Vulkan/GL
- 142.5 MiB  Noto
+ ~10 MiB    WQY + DejaVu
≈ 608 MiB    包
+ ~90 MiB    生成文件/native/initramfs
≈ 700 MiB    root
× ~0.5       压缩率
≈ 350 MB     ISO
```

因此：

- `minimal-zh-vm`：**350–400 MB** 合理
- `thin`：**150–220 MB**，取决于自定义内核与去掉 systemd/Rime 的程度
- `micro`：**25–50 MB**，Alpine/musl + 单应用

## 关键限制

- 20–30 MB 只可能是 micro/kiosk，不可能是 Debian + systemd + Rime + 多应用
- `minimal-zh` 的 300 MB 地板主要来自 Debian 用户空间、内核、Rime 和字体
- 所有小尺寸 SKU 都必须单独验证 DRM、输入、字体和恢复，不能从 `standard` 继承结论

## 相关实验

纯 CPU wlroots / QEMU virtio-gpu 验证见 [PIXMAN-CPU-DRM.md](PIXMAN-CPU-DRM.md)。
