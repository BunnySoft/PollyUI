# PollyOS 技术简介与交接指南

> 状态快照：2026-10-07。当前测试镜像为 **Debian alpha.5-r2**，代码基线为
> `b68faa6566043c791b36f8b244323b08378156aa`。本文用于技术介绍、设计约束说明和开发交接；
> 后续文档提交不改变已经生成的镜像及其源码版本。

配套文档：[历史延期与剩余任务台账](POLLYOS-BACKLOG.md)逐项追踪早期 45 项路线、
主题/发行评审及第二阶段留下的任务。本文的功能矩阵和 A–G 路线不代替该清单。

## 1. 项目定位与当前结论

**PollyOS 是以最小 Linux 基础系统为底座、自研 Wayland 桌面为核心的实验性桌面系统。**
它使用 PollyWM 管理窗口与显示，使用 PollyUI 运行 PollyShell 和应用界面，
不基于 GNOME、KDE 或 labwc。它复用内核、wlroots、Mesa、系统服务和字体/输入法等基础设施，
而不是从零重写整个操作系统。

当前已交付可启动的 x86_64 UEFI Live 测试镜像。基本桌面、中文输入、应用启动、
主题/显示/音频设置、受管理应用包，以及构建与发行校验链路已经落地。
**尚未交付完整磁盘安装、跨重启数据持久化、系统升级回退或生产级受保护会话。**

| 名称 | 职责与关系 |
|---|---|
| PollyOS | 本文采用的整套桌面系统名称；不是新的内核或 Linux ABI |
| PollyDesktop / `pollydesktop-*` | 现有桌面子项目、构建产物使用的历史名称；本文不重命名代码或文件 |
| PollyWM | 自研 C11 Wayland 合成器；wlroots 是其基础库，不是另一个被套壳的桌面 |
| PollyUI | 通用跨平台原生 UI 框架；不依赖 PollyWM 或 PollyOS 才能工作 |
| PollyShell | 运行在 PollyUI 上的桌面界面，负责面板、Dock、启动器和设置等 |
| `polly-app` | 普通用户应用包管理器，负责安装、版本选择、启动及注册状态 |

当前成熟度必须分开表述：

- **已验收的历史实机基线：** 用户报告 Alpine alpha.4 在首台目标机器上通过基础验证。
- **当前开发方向：** Debian 13 trixie amd64，由 `debootstrap --variant=minbase` 建立底座。
- **当前软件证据：** 修复后的 Debian 完整 ASan/UBSan 71 项、共享核心及真实 PAM 用例通过；
  新 ISO 和虚拟 USB 均通过 4 GiB UEFI 虚拟机启动预检。
- **当前实机反馈：** 2026-10-07 14:07（UTC+08:00），用户确认 Debian alpha.5-r2
  “已经实机验证可以启动和运行”。这建立了该候选的实机启动/基本运行基线，
  不是沿用 Alpine 结论，也不代替逐项 GPU、网络、音频或长期运行记录。

## 2. 设计原则

| 原则 | 必须遵守的含义 |
|---|---|
| 独立桌面，复用基础设施 | 自己决定窗口、工作区和桌面交互；不引入整套 GNOME/KDE/labwc，也不重复实现已有内核和底层协议库 |
| 从最小系统向上装配 | 从 Debian minbase 增加明确需要的包，不从完整桌面 Live 镜像“先装再拆”；`slim` 是容器材料，不是可启动系统 SKU |
| 分层单向依赖 | PollyUI 不依赖桌面；PollyWM 不链接 QuickJS/Yoga/Skia/SDL；外部应用由 wlroots 场景树合成，不导入 PollyUI DOM |
| 程序与数据分离 | 系统代码、第三方应用代码、AppData、缓存、用户文档各有责任；替换程序不能覆盖用户数据 |
| 稳定身份，不以路径代替身份 | 正式应用使用稳定 `app-id`；应用改名、更新或移动代码位置不能自动切换数据目录 |
| 权限明确且最小化 | 桌面与应用以普通用户运行；特权协议绑定合成器创建的具体连接，不信任自报的 UID/PID/app-id 或环境变量 |
| 故障可见，事务有边界 | 失败返回明确错误；显示配置有确认/回退，应用版本先暂存校验再切换；不能把失败伪装成空数据或成功恢复 |
| 证据限定结论 | PID 存在不等于服务就绪；软件 GL 不等于物理 GPU 加速；VM 通过不等于实机通过；PAM 会话登记不等于密码认证 |
| 构建与运行分离 | 编译器、头文件、SDK 和源码缓存不进入 Live；运行时确实依赖的 LLVM 库不能按“开发工具”误删 |
| 可追踪地维护依赖 | 固定源码、补丁、包版本与哈希；优先官方包，必要的本地重建明确标识，官方修复可用且验收通过后删除补丁 |
| 不制造虚假的安全保证 | 校验和不是签名，按目录分 AppData 不是沙箱，无密码 Live 不是受保护会话；不为通过检查隐藏泄漏或关闭证书/包认证 |
| 先完成当前交付目标 | 实机测试镜像不以应用商城、完整 SDK 离线重建或高级桌面效果为前置条件；长期路线不能不断扩大近期验收范围 |

自有运行时和服务继续保持不引入 GLib/GIO/GObject 的约束。
**这不等于整张镜像不包含这些库：** 独立第三方软件及其传递依赖另行记录，不能混淆两种范围。

Debian 软件源固定使用 `trixie`、`trixie-updates`、`trixie-security`；
backports 按具体包选择，不整体切换，也不混入 testing/sid。
详细决策及维护责任见[底座与维护原则](desktop-base-maintenance.md)。

## 3. 技术架构

### 3.1 启动、进程与服务

```text
UEFI
  -> GRUB + Intel early microcode + Linux kernel
  -> initramfs: whole Live root in RAM
  -> systemd / udev / system D-Bus / logind / PAM
  -> temporary ordinary-user session (UID 1000)
       |
       +-- PollyWM (C11 + wlroots + libseat)
       |     outputs / seats / focus / geometry / composition / protocol policy
       |
       +-- PollyShell (PollyUI + JavaScript, private Wayland connection)
       |     wallpaper / panels / Dock / launcher / settings / service UI
       |
       +-- trusted input-method process (PollyUI + librime)
       +-- private session D-Bus daemon
       +-- private PipeWire core + Polly-owned audio routing policy
       +-- ordinary public Wayland applications
       |     PollyUI apps / native apps / polly-app managed bundles
       |
       +-- optional trusted lock process + ordinary-user PAM helper
             development mechanism only; disabled in passwordless Live
```

系统级服务由系统管理，PollyWM/PollyShell/输入法和应用不因此获得 root。
Debian 使用 systemd/udev/logind；保留的 Alpine 路径使用 OpenRC/eudev/elogind。
两者不能只换包名就互相替代，PAM、设备授权和启动配置需要分别集成。

PollyWM 通过 libseat/logind 获取设备访问能力，支持开发用 headless/nested 路径和直接 DRM 输入/显示路径。
Shell 崩溃默认不终止其它应用；重启次数/退避及“Shell 正常退出是否结束会话”由显式策略决定。
诊断入口可选择失败即退出，但不能借此结束受保护的锁定会话。

### 3.2 UI 与绘制链路

```text
application / shell JavaScript
  -> QuickJS-ng
  -> DOM-like retained model
  -> Yoga Flexbox layout
  -> Skia rendering
  -> SDL3 Linux host / EGL-GLES or raster presentation
  -> Wayland surface and buffers
  -> PollyWM / wlroots scene graph
  -> compositor renderer / DRM-KMS output
```

Linux 文本由 Fontconfig/FreeType 选字形，HarfBuzz 做 shaping，ICU 提供双向文字、
字素和换行边界。Rime 输入法是另一条输入服务链路，不等于文本渲染引擎。

**应用绘制器与合成器绘制器是两个选择。** PollyUI 可用 Skia GLES 或 CPU raster，
PollyWM 可走 Pixman 或 GLES。`PU_RENDERER=gl` 要求 GLES 成功；`auto` 可报告原因后回退。
SDL 可能用 GPU 呈现 CPU 绘制的像素，这也不能等同于 Skia GPU 绘制。
当前无实体 GPU 的软件测试主要使用 Mesa llvmpipe。

### 3.3 协议与信任边界

优先使用标准 Wayland 协议：xdg-shell、layer-shell、foreign-toplevel、
text-input-v3、input-method-v2、output-management、workspace 和 session-lock 等。
标准协议没有覆盖的能力才使用范围受限的私有扩展。

| 边界 | 实际约束 |
|---|---|
| 合成器到 Shell | 合成器创建私有 socketpair；只有该具体 `wl_client` 获得桌面管理 globals，断开即撤销 |
| 普通应用 | 连接公开 Wayland socket；不能因为同用户、知道 global ID 或自报 Shell app-id 就获得窗口/显示/输入管理权限 |
| 输入法与锁进程 | 各自独立的可信连接，不能把输入注入或锁权限交给普通应用或整个 Shell |
| 私有扩展 | 外观、显示确认/回退、快捷键、窗口工作区归属和服务状态；没有通用远程命令执行/管理 socket |
| 应用启动 | 直接执行明确入口/argv；不继承 Shell 私有 Wayland 身份及无关 FD |
| 应用主题订阅 | 公开只读视觉快照，应用主动 opt-in；不给主题文件访问或桌面管理权限 |

这些是协议与进程职责边界，**不是对抗同 UID 的 OS 沙箱**。
root/ptrace、被攻破的可信 Shell、应用主动修改自身数据等不在这层保证之内。

### 3.4 依赖与修复快照

本表描述当前候选，不是另一份版本锁定配置；准确值以配方、pin 文件和产物清单为准。

| 组件 | 当前用途/选择 |
|---|---|
| Debian / glibc / kernel | Debian 13 trixie amd64、glibc 2.41；当前 Live 为 `6.12.111+deb13-amd64` 内核 |
| wlroots | 固定 0.19.3；提供设备、协议、场景与合成基础设施；不使用发行版不兼容的 0.18 ABI |
| QuickJS-ng / Yoga / Skia | JS、布局、绘制；Skia 固定 m124 对应源码，Linux 构建使用匹配工具链 |
| SDL3 | 3.4.10 加 Wayland show/hide 回调生命周期修复；源码与补丁一起校验 |
| HarfBuzz / ICU / Rime | 文本 shaping/Unicode 边界/独立中文输入服务；默认 Rime schema 限定到实际安装集合 |
| libinput | 匹配 Debian 版本的私有构建，关闭可选 libwacom，避免把 GLib 依赖带入自有合成器 |
| Mesa | 指定 backports 源码 26.1.6，本地重建为 `26.1.6-1~bpo13+1+polly1`，保留 Debian 驱动集合 |
| PipeWire | 明确选择 1.6 backport，使用私有 core 和自有路由策略，不使用 WirePlumber |
| 应用包工具 | C + 嵌入的共享 QuickJS schema + libarchive/libcrypto；安装态不要求 Node/Python/root daemon |

Mesa 的本地补丁修复 CPU 拓扑缓存卸载清理，以及最后一块代码释放后的可执行内存池清理。
它解决了实际的退出堆泄漏和遗留 10 MiB 可执行虚拟内存映射，不是关闭检查或强制 CPU fallback。
原始源包、补丁、重建 DEB、包身份和哈希均留存，Live 装配不得再覆盖成未修复官方版本。
待官方包包含等效修复且回归通过后，再移除本地补丁；不自动永久分叉 Mesa。

## 4. 当前功能及准确边界

下列“已实现”指现有代码和对应软件证据，不表示生产级或广泛硬件兼容认证。

| 能力 | 当前已实现 | 尚未覆盖/不能据此声称 |
|---|---|---|
| 窗口管理 | 焦点、移动/缩放、关闭、最大化/全屏/恢复、弹出菜单约束、跨输出迁移、协商式服务端装饰 | 自动平铺、完整 overview、高级窗口规则 |
| 工作区 | 首次四个、全局同步、手动创建/删除/切换/改名/排序，窗口族迁移；名称/顺序/当前选择保存 | 自动增删的动态工作区；Live 跨重启持久化 |
| 快捷键与切换器 | 冲突检查、编辑/禁用、偏好保存；最近使用窗口切换、取消/确认 | 任意 shell 命令式全局执行系统 |
| 多显示器 | 分辨率/刷新率/缩放/旋转/位置/启停；15 秒确认与合成器侧回退 | Debian 目标多 GPU/接线组合已全部验收 |
| 显示恢复 | connector/make/model/serial 完整且无歧义匹配才自动恢复；实际变化仍确认；Shell 重连不重复套用旧状态 | 不匹配设备时强行恢复旧布局 |
| 桌面界面 | 原生多输出壁纸、面板/菜单栏、Dock、窗口按钮、Apps 搜索及设置面板 | 完整文件管理器、应用商城或图标网格 |
| 外观 | 五套原创历史风格主题；JSON 用户主题/有限覆盖、本地壁纸、显式重载/恢复、应用 opt-in 订阅 | 任意主题代码、自动文件监视、强制改造第三方 UI、完整阴影/模糊效果 |
| 中文与 Unicode | 独立 Rime 服务、候选/预编辑/提交、敏感字段隔离；复杂文字 shaping 和字素级编辑 | 全部编辑器/无障碍场景、窗口标题的完整 shaping |
| 剪贴板/拖放 | 文本/MIME 剪贴板、primary selection、合成器拖放路由、PollyUI 传入文本/文件拖放 | PollyUI 完整传出拖放/DataTransfer API |
| 应用启动 | `.desktop` 启动与 managed bundle 共存；直接 argv、错误/退出报告，公开 Wayland 身份 | 所有 Linux 程序直接可用；XWayland 或任意 `.deb` 转 `.app` |
| 应用包管理 | 目录/tar/tar.gz/zip 安装；完整内容校验；显式替换/回退；移除/恢复注册 | 签名发布者认证、应用沙箱、自动数据迁移、安全旧版本物理 GC |
| 通知/托盘 | 私有会话 D-Bus；标准通知、原生弹出/中心/动作；StatusNotifier/DBusMenu | 传统 XEmbed 托盘；icon-name-only 项目的完整主题图标解析 |
| 网络 | iwd 原生 Wi-Fi 控制和认证交互；Live 有线 DHCP、无线配置与 DNS 集成 | NetworkManager、Debian 实机射频/联网验收、完整蓝牙界面 |
| 音频 | 私有 PipeWire、默认设备和路由策略、音量/麦克风静音、已确认状态的偏好保存、虚拟播放/采集 | 全面 PulseAudio/ALSA 应用兼容、Debian 实体扬声器/麦克风验收 |
| 服务健康 | 区分 disabled/starting/ready/failed；输入法实际初始化确认；有界启动检查、运行时故障提示 | 多小时耐久和完整自动恢复 UX 已完成 |
| 锁屏/认证 | 独立 session-lock 客户端、黑屏覆盖和故障保护、普通用户 PAM helper、真实密码解锁用例 | Live 默认锁屏、完整受保护登录/TTY/锁前挂起策略 |
| 电源 | login1 能力检查与确认/取消界面 | 当前 Live 关机/重启授权；这两项保持禁用，挂起/休眠也不支持 |
| 运行时服务 | Linux HTTP/HTTPS 证书校验、应用命名空间存储、异步任务与退出清理 | 完整浏览器运行环境、secret store 或权限沙箱 |
| 发行产物 | 可重定位运行包、ISO/USB 镜像、依赖/SBOM/源输入记录、哈希、差异/候选版本工具 | 正式签名发行、自动升级服务、完整源码合规审计、位级可复现 |

外观 JSON 由 Shell 校验/消费，PollyWM 只接收有界装饰参数。
较大主题快照通过大小受限的 sealed memfd 传递，不退回塞入单个过大的 Wayland 消息。
预览页仍是模拟预览，不能拿预览效果代替原生桌面能力证明。

## 5. 应用、程序与数据契约

### 5.1 逻辑上一个应用，数据在包外

应用可以从 `Notes.app/` 目录或 tar/zip 分发包安装。
安装后，代码按内容摘要保存在管理器的对象目录中，而不是承诺文件管理器已经把它呈现为 macOS 式单一图标。

```text
system program:
  /usr/bin
  /usr/lib/pollyui
  /usr/share/pollyui

managed application store:
  $XDG_DATA_HOME/polly-apps/
    apps/<app-id>.json
    retired/<app-id>.json
    objects/<content-digest>/...

application-owned data namespaces:
  $XDG_CONFIG_HOME/pollyui/<app-id>
  $XDG_DATA_HOME/pollyui/<app-id>
  $XDG_CACHE_HOME/pollyui/<app-id>
  $XDG_STATE_HOME/pollyui/<app-id>   (native XDG adapter)

user documents:
  locations chosen by the user, outside the program package
```

XDG 未设置时使用标准 HOME 下的默认目录。原生应用适配器设置每应用 XDG 根目录，
不改 `HOME`；PollyUI 用显式 `--app-id` 复用自身数据路径，不据此新增 `application.stateDir` API。
程序目录和数据目录不能互相包含，各数据类别也不能重叠。
不遵循 XDG 的第三方应用需要单独适配，不能仅设置环境变量就宣称全部数据已隔离。

### 5.2 生命周期与限制

| 操作 | 承诺 |
|---|---|
| 安装 | 普通用户操作；不执行安装 hooks；拒绝危险归档、无效 ABI/入口、已占用/保留身份及未知既存数据的自动接管 |
| 启动 | 校验实际内容，固定具体版本路径和 argv；源码摘要不是发布者签名 |
| 替换/回退 | 要求调用者提供观察到的当前摘要；完整版本先暂存同步，再原子切换注册；旧代码和 AppData 保留 |
| 数据格式变化 | 首版拒绝 `data.schema` 或 layout 改变；应用作者仍须诚实维护兼容性，路径分离不会阻止恶意程序改数据库 |
| 移除/恢复 | 只退役/恢复注册，默认保留 AppData 和代码版本缓存；不是已经回收全部磁盘空间 |
| 中断恢复 | 只清理管理器自有的暂存内容；不能借“恢复”删除任意路径、执行应用脚本或接管用户数据 |

当前每包最多 4096 项、32 层目录、单文件 256 MiB、总展开量和归档输入各 512 MiB；
最多 256 个活动应用。首版限制不是通用大型应用兼容承诺。
旧代码可能仍被运行中的进程或脱离主进程的后代读取，因此安全 GC 不能只看主 PID 是否退出。

**路径分离已经实现，持久存储尚未实现。** 当前 Live 的 HOME/XDG 数据都在 RAM 中，
会话内保存以及临时文件系统上的升级数据连续性，均不等于重启后还能保留。
EFI/系统/应用/数据的物理分区、文件系统及是否采用 A/B 布局尚未定型。
完整命令与安全边界见[应用包说明](../desktop/APPLICATIONS.md)。

## 6. 当前交付与验收证据

### 6.1 可交接的产物

以下均为仓库根目录下的本地产物路径；`dist`/`build` 不因提交源码就自动被发布到远端。

| 产物 | 相对目录/名称 | 状态 |
|---|---|---|
| 最新运行包 | `dist\pollydesktop-0.1.0-alpha.5-debian13-r2` | 可重定位运行包，不是启动镜像 |
| 最新启动介质 | `dist\pollydesktop-0.1.0-alpha.5-debian13-r2-live` | ISO、USB `.img`、manifest、校验和及构建记录 |
| 运行依赖留存 | `dist\polly-stage2-debian-binary-inputs-mesa-r1` | 精确官方依赖和明确标识的本地 Mesa DEB |
| 自维护源码留存 | `dist\polly-stage2-custom-source-inputs-mesa-r1` | 32 个源/配方输入，含 Git bundle、真实浅克隆边界、Mesa 源包与补丁 |
| 历史实机基线 | `dist\pollydesktop-0.1.0-alpha.4-live` | Alpine；保留，不冒充仍在自动安全维护 |

最新 ISO：

```text
dist\pollydesktop-0.1.0-alpha.5-debian13-r2-live\
  pollydesktop-0.1.0-alpha.5-debian13-x86_64-uefi-live.iso

677810176 bytes (646.4 MiB)
SHA256 6e9621577a8974be0ce0748fa50915f57f945f1b6d8bce581aaaf51709c94b29
```

同目录 USB 镜像：

```text
pollydesktop-0.1.0-alpha.5-debian13-x86_64-uefi-usb.img

730857472 bytes (697.0 MiB)
SHA256 006807f3962589f40c0b7f6f53c2121e24508991739ba30b6559232bcfb3d7be
```

ISO 是光盘介质，USB `.img` 是带 GPT/FAT32 EFI 分区的独立磁盘镜像，两者不互相等价。
“USB 镜像”仍只用于启动内存型 Live，**不是完整 USB 安装，也不是 Win2Go 式持久系统**。
镜像未建立生产签名/Secure Boot 信任；不得自动改变主机固件安全设置。

### 6.2 什么已经验证

| 证据 | 结论与范围 |
|---|---|
| Mesa 源码包构建 | 原驱动集合不变；113 项上游测试通过。见 `build\mesa-rebuilt.log` |
| 原始图形失败与新生命周期用例 | 修复后 raster/GLES 及十轮双上下文绘制、存活上下文继续读回像素、可执行映射释放通过。见 `build\mesa-graphical-after.log` |
| 最终 Debian ASan/UBSan | 完整 71 项通过，启用 `halt_on_error`；共享 core 通过。见 `build\mesa-final-full-asan.log` |
| 普通构建 | 71 项全套在最终音频小修前通过；随后重跑改变的普通音频四项及 core 通过，不把它改写为“最后提交重新跑过全部普通用例” |
| PAM | 一次性容器中的真实普通用户认证/解锁通过，非宿主账号。见 `build\mesa-pam-final.log` |
| 独立运行包 | 从留存 DEB 在断网 minbase 中重建，无项目源码/SDK挂入；服务就绪、两次真实应用运行与数据连续性通过。见 `build\alpha5-r2-offline.log` |
| ISO / 虚拟 USB | OVMF/KVM、4096 MiB、2 vCPU；普通用户 PAM/logind、guest DRM、中文输入、复制粘贴、工作区切换通过 |
| Debian 实机启动/运行 | 2026-10-07 14:07（UTC+08:00）用户对当前 alpha.5-r2 反馈：“已经实机验证可以启动和运行”。这是用户实测反馈，不是工具独立测量或全部设备逐项认证 |

VM 证据在 `build\alpha5-r2-uefi-optical\result.json` 和
`build\alpha5-r2-uefi-usb\result.json`。客体未连接可写数据盘、网络、物理 GPU 或宿主音频。
4 GiB 是本次通过的 VM 配置，不是已论证的所有硬件最低配置。

### 6.3 已修问题与仍开放的问题

不要继续把已经修复的问题写成当前阻断：

- Mesa 原先存在库卸载后堆缓存/可执行映射未释放，已用最小补丁和实际回归关闭。
- 扩展的 Debian 检查发现空 SPA 字典查询的未定义行为，音频适配器已加边界处理。
- 独立音频测试进程的 libdbus 缓存清理已在完整 PipeWire 退出后用受支持 API 完成。
- 早期 Live 曾带入 APT 缓存，导致 4 GiB 解包失败；现已清理并在新介质上重新通过。

历史失败日志保留；软件修复通过不消除下一节的产品与硬件限制。

| 当前开放项 | 实际影响/处理原则 |
|---|---|
| Debian 实机逐项记录 | 启动/基本运行已获用户确认；具体 GPU/renderer、无线、有线、实体音频及耐久结果尚未单独记录，不能自动标为全部通过 |
| 无持久安装 | 重启会丢失 Live 数据；不能用此版本保管唯一数据副本 |
| 受保护会话未闭环 | 无密码自动登录；锁机制默认禁用；没有完整受保护 TTY、锁恢复与挂起联动 |
| 电源授权暂缓 | 不使用 polkit/root 代理绕过；关机/重启 UI 保持禁用，挂起/休眠不支持 |
| 应用维护尚不完整 | 旧代码缓存可增长；无物理 GC、显式数据清除、签名来源/自动迁移或通用第三方适配 |
| 会话长期可靠性 | 已有有界故障/重启用例，尚不等于多小时耐久或全硬件热插拔认证 |
| 发行信任/合规 | 本地校验不等于签名发布，SBOM 不等于完整许可证/源代码履约审计，CI 定义不等于远端已执行 |
| 离线构建范围 | 可恢复自维护源码并离线重建运行环境/部分依赖；还不能从零恢复整个编译器、SDK 与 bootstrap |

首台目标为 i7-13700K / ASUS ROG STRIX B760-G GAMING WIFI，UHD 770、
RTX 4070 Ti / RTX 4060 Ti，I226-V 与 AX211。这是一台机器的目标清单，不是兼容性承诺。
Samsung 990 PRO 4TB、SanDisk SDSSDXPS480G、WD_BLACK SN770 2TB 为**禁止自动写入的内盘**。
任何真实外置介质写入必须另行明确设备与授权。

## 7. 未来路线与完成标准

阶段字母沿用第二阶段任务树，不能把功能矩阵中的早期编号直接当作当前完成率。

| 阶段 | 当前状态 | 后续主要工作与退出标准 |
|---|---|---|
| A：Debian 基线 | 软件/镜像与交接材料已完成；实机启动/基本运行通过，逐项硬件记录待补 | 保留本次用户反馈及 Alpine 回退材料，补充已有测试的实际驱动/renderer、中文、网络和实体音频结果；不把未单独报告的项目写成通过 |
| B：会话可靠性 | 部分完成 | 补多小时运行、反复启动退出、服务丢失/恢复、显示变化与可读诊断；不得破坏 Shell 崩溃时其它应用存活的默认策略 |
| C：应用包与数据 | 核心生命周期可用，C6/C8 尚未完整 | 安全回收无使用者的旧代码；独立确认的数据清除；按真实第三方需求增加适配；最终验证跨重启的数据连续性 |
| D：完整外置 USB/SSD 安装 | 尚未实现 | 基线验收后确定 EFI/系统/应用/数据布局和稳定标识；先可丢弃虚拟盘，再明确选定外置设备；重启保留配置、应用和文档 |
| E：系统手动更新/回退 | 尚未实现 | 暂存并校验一致的系统载荷与包数据库，切换版本、保留旧启动入口、处理中断/迁移；不能只恢复二进制却留下不匹配的系统状态 |
| F：发行维护 | 工具链部分完成 | 补完整 SDK/bootstrap 输入恢复、发行所需源码/许可证审查、签名信任方案及实测体积/启动/内存基线；有计划不代表已创建自动任务 |
| G：联合验收 | 待 D/E 等完成 | 完整外置安装、重启、应用/系统独立更新、中断与回退、数据格式兼容和真实硬件联合验收 |

对 D/E 的重要约束：程序/数据逻辑分离不强制当前就选择某种分区布局；
不能把整个 `/var` 当成跨版本共享 AppData，dpkg 数据库等系统状态要跟随对应系统版本。
第一版优先手动更新和可选择旧启动项，不先建立在线自动升级服务。

### 7.1 历史阶段留下的工作

A–G 是第二阶段主线，**不代表早期推迟的任务只有这七组**。
详细状态、来源编号、开启条件和完成边界见
[历史延期与剩余任务台账](POLLYOS-BACKLOG.md)。主要遗漏类别已经补回：

| 历史阶段 | 仍需追踪的子项 | 台账 |
|---|---|---|
| 窗口/Shell/主题 | 图标/分组/固定、外部点击关闭、标题高级文字、拖动恢复、平铺/overview、模糊/阴影/动画/深色主题 | UI、TXT |
| 输入/剪贴板/拖放 | surrounding-text、视觉 bidi caret、连字光标、高级断行、其它 IME、输出拖放、自动文本插入、触摸拖放、剪贴板保留 | TXT、DATA |
| 通知/托盘/服务 | 丰富通知/历史、主题图标/tooltip/XEmbed、企业网络/静态 IP/VPN、蓝牙、Pulse/ALSA 客户端、存储设备服务 | UI、NET、AUD |
| 应用与系统集成 | 文件管理、MIME/默认应用、D-Bus-only activation、管理 UI、代码 GC/数据清除、迁移、Portal、无障碍、XWayland/沙箱 | APP、INT |
| 登录与生命周期 | 正常锁入口/恢复、受保护登录/TTY、自启动/会话恢复、服务重启；电源授权和挂起/休眠仍明确暂缓 | SES |
| 发行质量与交付 | 完整安装/持久化/系统更新、性能预算/耐久、硬件逐项证据、离线构建环境恢复、许可证/签名/远端 CI/正式发布 | SYS、QA、HW、REL |
| 跨平台和远期 | ARM64、Tiny Core、触摸、HDR、VRR、远程桌面、打印、Windows Shell；共享移动端路线另列边界 | EXT |

台账还保留“曾推迟、后来已补做”的关闭记录，以及“已明确不选用”的路线。
例如 JSON 主题、偏好保存、应用包安装、Mesa 修复和 Debian 实机基本启动不能继续记作未完成；
动态工作区、NetworkManager、WirePlumber 也不能因为别的桌面有就自动成为我们的待办。

这些历史欠项**不是当前 Live 实机测试的新增前置任务**。
完整外置安装/手动更新等按第二阶段推进；明确暂缓或待决策项不会因列入文档自动启用。

## 8. 开发与交接入口

### 8.1 代码导航

| 入口 | 主要责任 |
|---|---|
| `desktop/compositor/` | PollyWM、可信连接、输出/工作区/窗口/输入及监督策略 |
| `desktop/protocols/` | 必要协议定义，修改时同时检查 compositor、客户端桥接和权限过滤 |
| `desktop/shell/` | 原生桌面界面、外观、设置、启动器与服务状态 |
| `src/desktop/` | PollyUI 桌面扩展、D-Bus/音频/网络/输入法和 bundle 原生实现 |
| `src/host/sdl/`、`src/render/` | SDL 主机适配、输入/窗口生命周期、Skia 绘制桥接 |
| `desktop/shared/app-bundle.mjs`、`src/desktop/bundles.c` | 共享包 schema 与真实文件系统事务；不能只改一边 |
| `desktop/themes/`、`desktop/THEMES.md` | 主题数据、schema、范围与订阅契约 |
| `desktop/system/`、`desktop/session/` | 服务配置、PAM/锁进程、会话策略 |
| `desktop/release/debian/` | minbase/SDK/runtime/Live 配方，Debian 依赖及 Mesa 源码修复 |
| `desktop/tools/` | 构建、打包、校验、差异报告、依赖留存与恢复 |
| `desktop/tests/`、`tests/` | 协议/原生 UI/生命周期/包管理/启动及共享 core 回归 |

### 8.2 构建、运行、验证

开发宿主可为 Windows + WSL/Podman；实际 Linux 编译和系统装配在显式容器中进行。
以下是**Linux/WSL shell 内、仓库根目录**的入口，不是 Windows 宿主安装命令：

```sh
# New environment: build signed minbase and the current SDK recipe.
sh desktop/tools/build-debian-sdk.sh

# Keep generated Debian build files in a native Linux volume.
podman run --rm --network=none -v "$PWD:/workspace" -w /workspace \
  -v polly-debian-build:/build localhost/polly-debian-sdk \
  sh desktop/tools/check-debian-runtime.sh /build/normal

podman run --rm --network=none -v "$PWD:/workspace" -w /workspace \
  -v polly-debian-build:/build -e UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1 \
  localhost/polly-debian-sdk \
  sh desktop/tools/check-debian-runtime.sh /build/asan --sanitize
```

已有交接环境另保存了 `localhost/polly-debian-sdk-mesa:polly1`：
它是本次实际通过的修复 SDK。**不要假定旧的 `localhost/polly-debian-sdk` 标签已经同步更新**；
复用缓存时明确选择镜像并核对 `/opt/pollyui-local-debs/mesa` 的来源/哈希。
本地镜像名不是远端发布地址，也不是独立可信签名。

```sh
# Existing delivered runtime: real ordinary-user headless health check.
podman run --rm --network=none \
  localhost/polly-debian-managed-runtime:0.1.0-alpha.5-r2

# Read-only inspection of the delivered images.
podman run --rm --network=none -v "$PWD:/workspace:ro" -w /workspace \
  localhost/polly-debian-sdk-mesa:polly1 node desktop/tools/release-report.mjs \
  dist/pollydesktop-0.1.0-alpha.5-debian13-r2-live
```

完整打包顺序是：
**冻结源码 → 普通/内存检查 → 运行包及依赖校验 → 独立运行环境 →
Live ISO/USB → 校验和与只读 VM 启动 → 用户实机验收。**
命令、参数与更换输出目录的做法以[Debian 构建说明](../desktop/release/debian/README.md)为准。
本文不提供对真实磁盘执行写入的自动命令。

### 8.3 容易踩到的边界

- Windows 挂载目录曾造成 Ninja 生成文件 I/O 错误：源码可挂载，Debian build 目录使用 Linux volume。
- Windows 文件权限/CRLF 不能直接当 Linux 安装权限；运行 tar 和 Live overlay 必须显式处理模式、所有者和换行。
- WSL 容器未必能解析 Windows worktree 的 Git 元数据；打包时从宿主提供真实
  `POLLY_SOURCE_REVISION` 与 `POLLY_SOURCE_DIRTY=0|1`，不能猜测 clean。
- core 用例需要写截图/测试结果；不能误用只读输出环境，也不能在全套测试期间编辑其正在读取的源码。
- 新输出/证据目录不得覆盖旧产物；保持镜像、包、源码提交、补丁和测试结果一一对应。
- 不把本地提交、CI 文件或本地镜像当作已经合并远端 main、执行远端 CI 或正式发布的证据。
- `polly-live-diagnostics` 只做本地收集；报告可能含设备标识、IP/MAC 和应用日志，分享前检查，不自动上传。

## 9. 维护这份交接文档

每次可交付候选至少更新：快照日期、代码提交、产物目录/大小/哈希、实际依赖变化、
通过用例的范围、仍开放的限制和下一道验收门槛。旧候选的失败与硬件反馈保留在原版本记录中，
不要用新的结论覆盖旧证据。

阅读顺序建议：

1. 本文：系统定位、当前状态、分层和交接路径。
2. [PollyUI 引擎设计](../DESIGN.md)与[桌面开发指南](../desktop/README.md)：代码层细节。
3. [底座与维护原则](desktop-base-maintenance.md)：发行责任和更新边界。
4. [应用包](../desktop/APPLICATIONS.md)、[会话/认证](../desktop/SESSION.md)、
   [主题](../desktop/THEMES.md)：各子系统契约。
5. [Debian 构建](../desktop/release/debian/README.md)与[Live 介质](../desktop/LIVE.md)：生成和验收。
6. [历史延期与剩余任务台账](POLLYOS-BACKLOG.md)：原 45 项、T/R 与 A–G 的剩余子项、明确暂缓和关闭记录。

**Debian 实机启动/基本运行已通过，下一阶段的重点是完整外置安装、数据持久化和更新恢复，
从可丢弃虚拟磁盘开始。继续补充实机逐项记录并保留 Mesa 回归门槛；
不能把本次反馈解释为真实写盘授权，也不能提前宣称数据已经持久化。**
