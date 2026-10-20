# PollyOS SKU 技术栈与尺寸

功能与组件选择、待定能力及当前实现缺口统一见
[SKU / Feature / Component 矩阵](SKU-MATRIX.md)。本页保留技术栈概览和历史尺寸依据。

## 当前三档产品定义（2026-10-20 调整）

按底座、中文能力和驱动范围分为三档，所有档位都需要 UI Shell：

| SKU | 底座 | 桌面与中文 | 驱动范围 |
|---|---|---|---|
| **Mini** | Alpine / musl / BusyBox，沿用原 Micro | PollyWM + PollyUI Shell；CPU UI/Canvas 2D，无 3D、中文字体或输入法 | UEFI GOP/simpledrm + virtio；基础 USB/PS2 输入 |
| **Compact** | Debian / glibc 精简底座 | 同一套 UI Shell，加中文字体和输入法 | 基础通用 GOP/simpledrm 显示，不按显卡厂商分版 |
| **Standard** | Debian 通用底座 | 默认保留中文字体和输入法 | 通用驱动和固件集合 |

当前顺序为 **Mini → Compact → Standard**。Mini 就是当前 Alpine Micro；
Compact 是原 Debian 中文轻量目标（曾称 Thin），不再单独设置厂商驱动分版档；
完整驱动/固件集合放在 Standard。旧 `micro` / `thin` / `full` 名称保留为历史或兼容接口。
从 Compact 起默认支持中文，不使用 `-zh` 后缀；Full 不再单列为产品。
Mini 优先小体积，明确放弃 WebGL2/WebGPU 和软硬件 3D，不为此引入
Mesa/LLVMpipe、Softpipe 或 Lavapipe；保留 CPU UI 与 Canvas 2D。当前没有已验证、
符合该档体积目标的通用软件 3D 实现，不把“可以软件渲染”当作必须加入的功能。
其它档位的 3D 能力需独立定义和验证，不因这次决定自动记为支持。
这定义的是新目标，不能把旧演示镜像、配置文件或历史 boot 结果自动记作新 SKU
交付。统一入口为 `tools/build.sh --os mini|compact|standard`，必须显式选择
`--plan` 或 `--build`；详细命令见 [构建指南](BUILDING.md#current-product-builds)。
Mini 复用 `desktop/release/micro/build-shell.sh`，新产品输出 `mini.iso` 和 `mini.json`；
直接调用旧脚本仍默认生成 `micro-shell.*`，不影响已有命令。该配方
与原 26 MB `tinywl` 演示路径分开。新 Mini 品牌已真实重建，仍为
**65,286,144 字节（65.29 MB）**，SHA-256
`92389a08e6833c595b30fca7da2f248e905edef9d1655cc27a55558125faa899`，
交付在 `D:\temp\PollyOS\mini-92389a08e683\mini.iso`。新文件名、启动品牌及
`product=mini` 报告来自实际构建，不是旧 ISO 改名；GOP/virtio 双路径交互已复验。

此前 Micro 基本桌面版为
**65,286,144 字节（65.29 MB）**，包含 Decorator、Files、Settings、Processes、
File Text 与普通 Foot 终端入口，改用 UID 1000 + seatd；仍无中文/IME/3D。
同时包含已独立合入 main 的输入光标闪烁修复 `8a064d5a`。
QEMU 的 GOP 与 virtio 双路径均完成桌面、闪烁、窗口操作及四个基本应用启动/关闭；
用户实机需使用新镜像复验，旧桌面栏未见的反馈不能自动记为修复。上述实测值属于
按旧 Micro 名称交付的镜像，不是新 Mini 文件名的重新实测。

此前 GOP 基础显示版为
**60,866,560 字节（60.87 MB）**，同一镜像的 UEFI 标准 VGA/simpledrm + USB
键鼠，以及 virtio-gpu + virtio 键盘均已在 QEMU 跑通。2026-10-20 用户反馈
此前讨论的 Quadro P1000 实体机启动、显示和键鼠输入成功；未采集硬件/驱动日志，
只作为该机器的基础显示/输入观察，不代表广泛实机资格。
原 60.05 MB virtio-only Shell 镜像独立保留，不覆盖其历史结果。
摘要、启动证据与限制见该目录 README。Compact 的 CPU/中文/GOP 配方未接通时
统一入口明确 blocked，不回退到旧演示。Standard 的 `standard.yaml` 使用已有
`standard-effects4` + 内部 `full` 硬件集合，仍含原 Mesa/LLVM，不伪称已制作新的精简变体。
Standard 新配置及入口没有因此自动取得构建或硬件资格。

旧 `thin` / `full` / `minimal-zh` 的文件名、SHA-256、构建入口和现有命令行合同保留，
仅作兼容和历史记录，不重标原产物。下文记录调整前的原型与体积依据，
不是新三档产品的实际大小或验收状态。

## 历史原型与体积依据

| SKU | 底座/初始化 | 图形 | 中文/应用 | 目标 ISO | 状态 |
|---|---|---|---|---|---:|---|
| **micro** | Alpine 3.24 + musl + BusyBox | Pixman + `drm_dumb` + `tinywl` | 无 Rime；一个 Wayland 演示应用 | 25–50 MB | **26 MB 原型已构建/已启动** |
| **thin** | Debian 13 + BusyBox | Pixman + `drm_dumb` | WQY 字体；一个应用；无 systemd/PAM/Rime | 150–220 MB | **169 MB 原型已构建/已启动** |
| **minimal-zh** | Debian 13 + systemd/PAM | Pixman + `drm_dumb` | WQY + Rime Luna + PollyUI/PollyWM | 300–400 MB | **systemd + PAM + UID 1000 + CPU shell（236 MB 测试镜像）**；无图形登录 |
| **standard** | Debian 13 + systemd/PAM | GLES2 + Mesa | 完整应用、Noto、Rime、PollyUI | 约 577 MB | 已构建/已启动 |
| **full** | Debian 13 + systemd/PAM | GLES2 + Mesa + 厂商固件 | 完整硬件覆盖 | 约 726 MB | 已构建/已启动 |

### Micro 旧演示原型

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

### Thin 旧演示原型

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

### 原 minimal-zh 实验路径

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

## 历史尺寸数据的适用边界

- 原 26 MB 只覆盖无 Shell 的演示镜像；首份 Shell 为 60.05 MB，
  新增 GOP/simpledrm 和 USB 基础驱动后为 60.87 MB；
  新增基本桌面应用、Decorator、普通用户会话及光标修复后为 65.29 MB。
- 原 `minimal-zh` 的 300–400 MB 是特定包集合的估算，不是 Debian 或新 Mini/Compact
  的体积下限。Debian 档应按同样的内核、模块和运行依赖裁剪粒度重新实测。
- 所有小尺寸 SKU 都必须单独验证 DRM、输入、字体和恢复，不能从 `standard` 继承结论

## 相关实验

纯 CPU wlroots / QEMU virtio-gpu 验证见 [PIXMAN-CPU-DRM.md](PIXMAN-CPU-DRM.md)。
