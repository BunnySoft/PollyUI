# 尺寸 SKU 交付记录（2026-10-21）

本文件汇总本轮尺寸 SKU 阶梯的实测产物。所有 ISO 都是 unsigned x86_64 UEFI
开发镜像，不代表通用物理机或安全启动资格；有限实机用户反馈单独记录。

产品能力与实际交付的差异见 [SKU / Feature / Component 矩阵](SKU-MATRIX.md)。
旧 Micro 的桌面栏存在实机用户反馈未见的问题；新基本桌面已接入 Decorator
和应用入口并完成 QEMU 交互验收，但不能自动把旧实机问题标为已修复。

**本页保留构建时的历史命名。** 当前产品已收敛为 Mini / Compact / Standard。
Mini 沿用 Alpine Micro；Compact 是 Debian 中文轻量档，仅基础通用显示；
Standard 带完整驱动/固件。中文从 Compact 起默认包含，不再单列 Full 或使用 `-zh`。
旧命令和产物保持原身份，统一新入口见 `tools/build.sh --os --help`。
下面的 26/169 MB 演示镜像不含新要求的 UI Shell，不能算新 Mini/Compact
已经交付。新定义与旧记录的边界见 [SKU 技术栈与尺寸](SKU-SIZES.md)。

## Standard：完整桌面特效版（当前交付）

本次真实执行规范产品 `--os standard` 配置/锁构建，不是旧 Full 媒体改名。
内部硬件集合仍为 `full`；Mini、Compact 和全部历史镜像保持原身份。

| 项目 | 实测结果 |
|---|---|
| ISO | **882,157,568 字节，882.16 MB / 841.29 MiB** |
| ISO 文件 | `pollydesktop-0.1.0-alpha.8-debian13-full-standard-75821a5de677-x86_64-uefi-live.iso` |
| ISO SHA-256 | `902838e3004639abe82f94dd73077f950098bc4d4be428dc9ceb9ac896d80f95` |
| USB 原始镜像 | **934,281,216 字节，934.28 MB / 891.00 MiB** |
| USB 文件 | `pollydesktop-0.1.0-alpha.8-debian13-full-standard-75821a5de677-x86_64-uefi-usb.img` |
| USB SHA-256 | `9fbfc057a787b104638d2539ac293f014e8df6e58ba7e57db1d6f74b8214075d` |
| 交付目录 | `D:\temp\PollyOS\standard-effects-902838e30046\`；制作 USB 使用 `.img` |
| 原生与媒体来源 | 干净 Linux checkout：`7ac24471ce488246cafe7699308091b09e497966`；同一真实提交、LF 字节、`sourceDirty=false`，源码 Git bundle 随包保留 |
| 特效 | 全局普通窗口透明度、真实 2D 预览、Flip 3D、Canvas Aurora、原创兔子形象、本地静音视频壁纸、四工作区立方体及独立 Settings 控件 |
| 默认与 GPU 模式 | 默认 Pixman/raster；3D 特效需从 `Advanced startup` 选择 `GPU acceleration (automatic selection)`。这是启动会话选择，不是无缝热切换 |
| 解码边界 | 独立 FFmpeg 9.0.2 LGPL-only 辅助进程，H264/VP8/VP9、MOV/Matroska；无音频、网络协议、GPL/nonfree 或硬件解码；GUI/Shell 不链接 FFmpeg |
| 配对 SDK | wlroots effects ABI4，补丁 `04e9b87e8956a3eaff4feae9fb4ef06b91c2ccb871dc5e883a68a81dce2bdab6`；实际 LF 配方重建视频前缀，未改写旧 SDK |
| 依赖与构建 | 411 个最终包、129 个新增归档；固定官方 keyring、真实签名/索引/归档核验和 file-only APT 解算；配置媒体组装断网，不升级冻结原生依赖 |
| ISO UEFI | 首次通过 UID 1000 PAM/logind、真实 DRM/KMS、中文提交、剪贴板和工作区切换；4 GiB、2 vCPU、无可写客机磁盘和网络 |
| USB UEFI | 首次通过同一桌面/输入检查；模拟 e1000e 的 DHCP、网关 ping、系统 DNS，以及 HDA 播放/采集设备枚举通过 |
| GPU 模式 | 同一未修改媒体的原始 kernel/bootstrap/root，经 direct-kernel 测试传输启动正常 systemd/PAM，会话实际使用 GLES、virtio DRM/KMS；不是 headless 输出或绕过 systemd 的注入启动 |
| 特效交互证据 | 独立原生 GLES fixture 通过真实 Settings、立方体相邻面同屏、深度选择、确认/取消、锁屏、输出移除和 Shell 新 PID；Flip 3D 回归保留零 idle / 3 帧有界过渡 |
| 边界 | GPU 客机使用 llvmpipe，不是物理 P1000 加速；未实机验证 Wi-Fi、声音/录音、多屏、恢复或性能，未做全部特效在实机同时启用的验收 |

Windows 端已独立复核两份媒体 SHA256。目录内保留媒体 manifest、原始来源、
解析计划、锁、SBOM、运行包来源/版本和 ISO/USB/GLES 日志与截图。
GLES direct-kernel 场景不冒充 UEFI 验收；独立光盘/USB 场景提供 UEFI 证据。
实际安装后的解码器另外通过原始 MP4/WebM 像素、暂停、循环、时间戳、
单帧 credit、畸形/超限拒绝和非循环 EOF 检查。

实现阶段的 208 项源测试、19 项定向 Release 回归，以及构建入口/离线适配器
检查不等于整个仓库测试全绿。全量 Release 构建还暴露既有
`desktop/tests/decoration-frame.c` 在 `NDEBUG` 下的 assert 副作用警告；
未为本轮修复无关测试或放宽 `-Werror`。打包按实际启用的产品目标构建，
包含 PAM helper。

构建失败单独保留：portable Node 缺 ICU 数据、缺 `gpgv`、APT hash 文件名缓存、
Windows CRLF 导致冻结字节不匹配，以及两个旧工具镜像缺少 SquashFS/readelf。
分别补齐真实依赖/缓存、采用干净 Linux checkout 和已有完整工具镜像后通过，
未跳过签名、clean-source 或逐字节校验，未覆盖旧交付或固定 alias。
SDK、完整构建目录和带归档的离线锁仍保留在本机 Podman 环境；
Windows 目录不冒充包含所有 OCI/SDK 输入的离线重建包。本轮本地提交未推送。

## 此前 Standard/full：Wi-Fi、音频扩展版

在下节 P1000/有线/常用命令版本之上重新组装，保留 `sku=full` 内部身份。
Mini 和 Compact 不变；本轮复用同一份已冻结、配对的原生 runtime，没有重新编译应用，
也没有改换 NVIDIA 驱动路线。

| 项目 | 实测结果 |
|---|---|
| ISO | **865,880,064 字节，865.88 MB**；`pollydesktop-0.1.0-alpha.8-debian13-full-x86_64-uefi-live.iso` |
| ISO SHA-256 | `0f142c34a9488d6f770c52f30184bf6d847e011d83cdd5ac608b3fe3675dce9d` |
| USB 原始镜像 | **918,552,576 字节，918.55 MB**；`pollydesktop-0.1.0-alpha.8-debian13-full-x86_64-uefi-usb.img` |
| USB SHA-256 | `aa335a2a73fccf85758a40be2103ed3e9488f6a4688dc158590d7614e8699c29` |
| 交付目录 | `D:\temp\PollyOS\full-wifi-audio-0f142c34a948\`；制作 USB 使用 `.img` |
| Wi-Fi | 保留 Intel、Realtek，新增 Qualcomm/Atheros、Broadcom/Cypress、MediaTek 固件；核验对应 PCIe/USB 开源内核路径，iwd 已启用 |
| 音频 | HDA/Realtek/HDMI/USB、Intel SOF/SST、AMD ACP 和 Cirrus 内核路径；补入 Intel/Cirrus 固件、ALSA UCM/topology，沿用已有 PipeWire 核心 |
| 其他常用模块 | NVMe、AHCI、USB 控制器/存储、HID 键鼠；合计核验 53 个必需模块路径、63 个命令入口 |
| 新增包 | `firmware-atheros`、`firmware-brcm80211`、`firmware-mediatek`、`firmware-intel-sound`、`firmware-cirrus` 均为 `20250410-2`；`alsa-ucm-conf=1.2.14-1`、`alsa-topology-conf=1.2.5.1-3` |
| 冻结运行库 | 原生提交仍为 `798dd0cfd255fe24a15fb2e6b7710deb15dd1830`；libasound/Mesa/PipeWire 等原有版本和应用字节未升级 |
| 媒体 / 测试来源 | 干净的独立构建提交 `ddfe9ec1afb4ee6a1693d7a99ed7ad3d058edd87`，源码 Git bundle 和补丁随包保留；本轮未推送主线 |
| ISO 启动 | 首轮中文提交检查未收到回执；保留失败日志和截图。未改参数、超时或门槛的第二轮通过 UID 1000 桌面、中文提交、剪贴板和工作区检查；不宣称修复了该既有偶发问题 |
| USB 启动 | 首轮通过同一桌面检查及模拟 e1000e DHCP、网关 ping、系统 DNS |
| 模拟音频 | 同一 USB 客机中，UID 1000 的 `aplay -l` 和 `arecord -l` 均枚举到 HDA 设备；未向宿主播放或录音，不是可听播放/麦克风采集通过 |

全部 96 个交付文件在 Windows 端独立复核 SHA-256，两份通过回执分别绑定上述
ISO/USB 字节。新增七个包的 `.deb`、包版本、摘要及目录清单一并留存。
首轮 ISO 失败位于 `evidence/iso-FIRST/`，同条件复测位于 `evidence/iso-r2/`，
USB/网络/音频枚举位于 `evidence/usb-wired-audio/`；没有覆盖或隐藏失败。

**尚未实机验证 Wi-Fi 扫描/连接、扬声器播放、麦克风录音或 P1000。**
部分 Broadcom 设备需额外 STA 驱动或板级 NVRAM，部分笔记本需 OEM 音频配置、
校准数据或额外 AMD DSP 固件，不能仅凭模块和固件包齐全宣称所有电脑兼容。
未新增蓝牙栈，也未改变未签名 UEFI、内存运行和无安装器的开发版边界。
此前 `full-p1000-a734991cc8fb` 目录和固定 `PollyOS.iso` 均保留。

## 此前 Standard/full P1000 开发镜像

本轮按用户的 Full 请求重新编译配对原生 runtime，并以内部 `full` 硬件配置组装。
产品仍为 Mini / Compact / Standard；本镜像保留真实 `sku=full`，没有把历史镜像
改名成 Standard，也没有宣称执行了新 `--os standard` 的配置锁构建。

| 项目 | 实测结果 |
|---|---|
| ISO | **783,349,760 字节，783.35 MB**；`pollydesktop-0.1.0-alpha.8-debian13-full-x86_64-uefi-live.iso` |
| ISO SHA-256 | `a734991cc8fbcd5759f4934620cd5131b585a2d75acb4a0dd2fac580eed07ea1` |
| USB 原始镜像 | **835,715,072 字节，835.72 MB**；`pollydesktop-0.1.0-alpha.8-debian13-full-x86_64-uefi-usb.img` |
| USB SHA-256 | `6e8dbaddd46c20d609ea727b25d72d13a6d5a2a758256b0beadc63f738b5651c` |
| 交付目录 | `D:\temp\PollyOS\full-p1000-a734991cc8fb\`；制作 USB 使用 `.img` |
| 内核 | Debian `6.12.113+deb13-amd64`，完整 stock 模块 |
| P1000 路线 | Quadro P1000 / GP107 的 Nouveau、GP107 GR 固件、Mesa；不含 NVIDIA 闭源驱动 |
| 有线网卡载荷 | e1000e、igb、igc、r8169、r8152、asix、ax88179_178a；Realtek 固件、dhcpcd 和 openresolv |
| 常用命令 | 核验 56 个命令入口；shell/文件/压缩、进程、less/nano/vi、curl/wget、SSH 客户端、rsync、Git、IP/DNS/网卡诊断、Python 和 apt；不新增 SSH server |
| 普通用户 ping | 目标系统启动时将 ICMP 数据报 socket 限于 GID 1000；不添加 setuid 或 raw-socket 权限，不修改构建宿主 sysctl |
| ISO 启动 | 本镜像首次 UEFI/QEMU/KVM 启动通过；4 GiB、2 vCPU、只读 ISO、无客机磁盘和网络，UID 1000 PAM/logind、1280x800 DRM/Pixman、中文提交、剪贴板、工作区切换 |
| USB / 有线启动 | 本镜像首次独立 USB 场景通过，同样的桌面/输入检查；模拟 e1000e 获取 `10.0.2.15`，网关 `10.0.2.2`、系统 DNS `10.0.2.3`、普通用户 ping 和 `example.com A` 查询通过 |
| 原生来源 | 干净的独立构建提交 `798dd0cfd255fe24a15fb2e6b7710deb15dd1830`；全新 native 构建，wlroots effects ABI4 |
| 媒体 / 测试来源 | 干净的独立构建提交 `c14c02260f2a4776ef5be8c50ef8c87f21782765`；主仓库本轮 Full 改动未另行提交或推送 |
| 实机边界 | 新 Full 尚未实机验证 P1000、真实有线网卡、多屏、热插拔、恢复或性能；不继承旧 Micro 的有限实机反馈 |

目录包含媒体 manifest/origin、实际硬件和命令载荷报告、原生来源/包版本/SBOM、
源码 Git bundle、构建镜像身份、完整校验和、串口日志、截图和首次失败记录。
原生 runtime 与媒体 producer 来源分别标记，未用媒体提交冒充原生编译提交。
构建工作区及完整输入仍保留在 Podman Linux 的
`/home/user/polly-full-p1000-f687df90`；Windows 包不冒充包含全部 OCI/SDK 输入的离线重建包。

此前尝试的失败也保留：工具/硬件分类、DNS 虚拟包名以及 curl/liblzma 版本漂移均已修正，
冻结原生版本检查未放宽。此前 `r5` 媒体的 USB 并发首轮未收到中文提交回执，
单独复测通过输入后暴露测试器稀疏地址解析问题，再暴露普通用户 ping 权限问题。
这些记录位于 `evidence/pre-icmp/`，不是本次最终媒体的首轮结果；
最终 `r6` 重新生成媒体，分别绑定上述 ISO/USB 摘要通过。

这是 unsigned x86_64 UEFI 内存运行开发镜像，没有磁盘安装器；重启丢失修改，
公开 Live 凭据不提供个人数据保护。stock Debian 内核未启用 simpledrm，
不能继承 Mini 的 GOP 桌面保底；P1000 仍依赖其原生 Nouveau DRM/KMS 路径。
旧镜像和 `PollyOS.iso` 固定入口未改动。

## 新 Mini 基本桌面（沿用 Micro 配方）

| 项目 | 实测结果 |
|---|---|
| ISO | **65,286,144 字节，65.29 MB** |
| SHA-256 | `92389a08e6833c595b30fca7da2f248e905edef9d1655cc27a55558125faa899` |
| 交付目录 | `D:\temp\PollyOS\mini-92389a08e683\mini.iso` |
| 产品身份 | 新构建 `sku=mini`、`product=mini`、Mini GRUB/欢迎页，不是旧 Micro 镜像改名 |
| 构建入口 | `tools/build.sh --os mini`；本次因宿主无 Node，直接调用同一 `MICRO_PRODUCT=mini` 配方，未安装宿主包 |
| 来源 | `8a064d5a` 加本次未提交改动，`sourceDirty: true` |
| 双路径 | simpledrm/USB 与 virtio；Decorator、底栏、hello、光标闪烁、窗口操作、四个 App 启动关闭和欢迎关闭后桌面存活均通过 |
| 实机边界 | 新 Mini 尚未复验，不继承旧 Micro 实机反馈；旧镜像和入口保留 |

`mini.json`、两份 `mini-*-boot.json`、串口日志、桌面/应用截图与完整摘要同目录交付。
Compact 未完成正式中文/GOP 配方，构建明确阻断；Mini 交付时 Standard 新命名配置
仅完成计划/组装通路回归，本轮独立 Full 媒体见上节。

## 历史 Micro Shell

### 此前基本桌面版

| 项目 | 实测结果 |
|---|---|
| ISO | **65,286,144 字节，65.29 MB** |
| SHA-256 | `3e2090a252234ab7cb85d03a4fff295710d875fdcb3c6c9ec8861a2548b03eb2` |
| 交付目录 | `D:\temp\PollyOS\micro-desktop-3e2090a25223\` |
| 会话 | BusyBox → seatd → UID 1000 PollyWM + PollyUI；无登录认证/PAM/logind |
| 桌面 | 壁纸、底栏、应用菜单和独立 Decorator；关闭欢迎窗口后继续运行 |
| 应用 | Files、Settings、Processes、File Text、普通 Foot；未运行 foot server |
| 图标/入口 | Processes 与 Foot 使用不同原创图标；隐藏 Foot Server/Client 菜单；去重 Settings |
| 光标修复 | `8a064d5a` 已独立提交并推送 main；新 ISO 包含该修复，运行中确认显隐两相位 |
| QEMU 验收 | 同一 ISO 的 GOP/simpledrm + USB 和 virtio 双路径；hello 输入、窗口最大化/恢复/最小化/切换/关闭、Foot/Processes/Settings/Files 启动关闭 |
| 实际内容 | Files 可列出 home，Processes 显示真实进程，Settings 完成私有总线握手，Foot 可输入并正常 exit；截图随包保留 |
| 边界 | 无中文/IME/3D；无完整音频/网络/安装器；新镜像尚未实机复验，旧缺栏反馈保留 |

本轮复用共用安装清单、窗口装饰和应用，不放宽 Files 对 UID0/setid 的拒绝。
普通用户切换与 seatd 是启动集成，不是新增图形登录器或认证承诺。
来源为 `8a064d5a` 加未提交桌面修改（`sourceDirty: true`），旧 ISO 和固定入口保留。
光标提交只包含 SDK 输入控件、直接文档及测试/CTest 注册，没有混入桌面或 SKU 改动。
脚本验证使用 `test-shell.sh --desktop`，交付包含双路径 JSON、截图、串口记录与摘要。

### 此前 GOP 显示/输入原型

保留此前的 root 会话 GOP 原型与 virtio-only 交付：

| 项目 | 实测结果 |
|---|---|
| ISO | **60,866,560 字节，60.87 MB** |
| SHA-256 | `48b03625e42344ff708e19cfe36104863581379e9049ae219ca3e11c12da3d17` |
| 图形 | PollyWM + Pixman + PollyUI Shell，1280x800 |
| 3D 边界 | Micro 优先小体积，保留 CPU UI/Canvas 2D；不提供 WebGL2/WebGPU，不加入软件 3D 运行库 |
| 通用基础显示 | UEFI GOP → simpledrm → DRM/KMS → Pixman，非 virtio 显卡场景已跑通 |
| 输入 | GOP 路径实际 USB 键盘输入 `hello` 和 USB 鼠标点击；virtio 键盘也通过 |
| 中文／IME | 不包含 |
| 交付目录 | `D:\temp\PollyOS\micro-shell-gop-48b03625e423\` |
| 来源 | `3a9a2762` 加本次未提交修改，`sourceDirty: true` |
| 实机用户反馈 | 2026-10-20：此前讨论的 Quadro P1000 机器启动、显示、鼠标键盘输入成功；未采集硬件/驱动日志 |
| 限制 | root 会话、无 decorator/登录/安装器；QEMU 自动验收 + 上述有限实机用户反馈，非普遍硬件资格；不处理 Secure Boot |

构建入口 `desktop/release/micro/build-shell.sh`，原生验证入口
`desktop/release/micro/test-shell.sh`。ISO、build/boot JSON、串口日志和 PNG
同目录交付；旧 `PollyOS.iso` 不变。旧命名原型如下，不重写历史结果。

`MICRO_DISPLAY=simpledrm` 运行标准 VGA + USB 测试，默认运行 virtio；
双路径报告均绑定同一 ISO SHA 才记 `qemu-pass`。新图形路径复用现有 Alpine
内核，只增加模块闭包和 GOP 启动配置；相对首份 Shell ISO 增加 815,104 字节。
之前的 60.05 MB Shell 仍在 `D:\temp\PollyOS\micro-shell-98448b2c199d\`，
SHA-256 `98448b2c199dacc7f8a07d5f55b9c787de1aea9f98f1090650b2dbdc105c6b21`。

## 历史原型

| SKU | 实测 ISO | SHA-256 | 构建入口 | 状态 |
|---|---:|---|---|---|
| micro | 26 MB | `cfd9fc2d9edb5dbd77326dada0349f8af1f2d41bdc6ec75f0176301ee70c0495` | `desktop/release/micro/build.sh` | 已构建、QEMU 启动 |
| thin | 169 MB | `6c1ff04041314f8265ef7f33177167cf152b933a613b71a7ff8e743565be84d1` | `desktop/release/thin/build.sh` | 已构建、QEMU 启动 |
| minimal-zh | 236 MB | `441855acb8ad06177c06c52ef4c69088bd77ad430c8558b8cd7232cee907be63` | `desktop/release/minimal-zh/` | systemd + PAM + UID 1000 + CPU shell + 中文输入 |
| standard | 577 MB | 见 `dist/` 现有 standard 交付 | 现有 Debian Live 链 | 已构建、启动 |
| full | 726 MB | 见 `dist/` 现有 full 交付 | 现有 Debian Live 链 | 已构建、启动 |

## micro

- Alpine 3.24 / musl / BusyBox
- Pixman + `drm_dumb` + `tinywl`
- 单应用，无 Debian/systemd/PAM/Rime
- 测试：`desktop/release/micro/test-qemu.sh`

## thin

- Debian 13 minbase + glibc + BusyBox PID 1
- Pixman + `drm_dumb` + `tinywl`
- 无 systemd/PAM/Rime/WQY
- 测试：`desktop/release/thin/test-qemu.sh`

## minimal-zh

- Debian minbase + systemd 257 + PAM (`runuser`) + UID 1000
- Pixman-only PollyWM + PollyUI shell（SDL Wayland SHM framebuffer 补丁）
- WQY Micro Hei + Rime Luna 数据 + IME 服务
- 已验证 `nihao` 候选与“你好”上屏
- 单元/脚本：`desktop/release/minimal-zh/systemd/`
- 尺寸低于名义 300–400 MB；尚无图形登录/greeter、decorator、
  `systemd-tmpfiles`/`/sbin/modprobe` 辅助程序

## 测试入口

```sh
MICRO_WORK=$PWD/build/micro sh desktop/release/micro/test-qemu.sh
THIN_WORK=$PWD/build/thin sh desktop/release/thin/test-qemu.sh
```

minimal-zh 的 QEMU 验证通过 `/root/mini-run.sh`/QMP 进行；单元文件与启动脚本
已签入仓库。

## 限制

- 所有尺寸档都是开发原型，不是可发布候选。
- `minimal-zh` 的 SDL SHM framebuffer 补丁仍是实验路径。
- `standard/full` 保留原有 Debian Live GLES/Mesa 构建，不继承本页小尺寸结论。
