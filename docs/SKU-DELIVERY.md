# 尺寸 SKU 交付记录（2026-10-20）

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
Compact 未完成正式中文/GOP 配方，构建明确阻断；Standard 新命名配置仅完成
计划/组装通路回归，本次没有另构建 Standard 媒体。

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
