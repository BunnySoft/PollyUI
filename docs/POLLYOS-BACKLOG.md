# PollyOS 执行台账

> 台账更新：2026-10-08。历史实机基线为 alpha.5-r2（镜像源码 `b68faa6`），
> 已包含用户 14:07（UTC+08:00）的 Debian 实机启动/基本运行通过反馈。
> 本文补齐早期 45 项路线、主题 T1–T5/发行 R1–R6 和第二阶段 A–G 中留下的工作；
> 与 [PollyOS 技术简介](POLLYOS.md)配套，不把所有欠项重新变成下一张 ISO 的前置条件。
>
> 当前最高优先级：完成功能闭环，再生成统一 Alpha 候选并集中手测。
> 版本范围与实际剩余收尾直接看 [Alpha 路线](POLLYOS-ALPHA.md)；
> 文件 App 强化、完整断网构建及专项优化已延期，不再与 Alpha 基础功能排在同一个必须完成队列。
> **日常追踪直接看[第 16 节](#16-完整执行清单与依赖)**：可验收交付目标 → 实现任务 → 子任务。
> 产品默认值见第 15 节；第 2–13 节只保留历史来源，不作为另一套待办。
> `POLLYOS-PLAN.json` 是唯一计划数据源；本文第 16 节和应用 Plan 是生成视图，不各自维护状态。
> 设计确认和文档对齐不等于功能实现，不改变已有产物。

后续完整系统/存储改进依照[目录、存储与 Linux 兼容设计](POLLYOS-STORAGE-DESIGN.md)。
新目标为可写单系统、独立持久状态、全机共享 App 和独立救援，不再要求固定 A/B。
既有 D1 及 A/A/B/A 证据保持原义；下列已完成项不因此重写，新布局仍需独立验收。

## 1. 如何阅读

此前的缺漏是：总览列出了 A–G，但把更早阶段的剩余子项压缩成“高级效果”“其它平台”等几句话。
一个里程碑通过，并不表示该领域的每个子能力都已完成。例如原生输入法已经可用，
不代表 surrounding-text、其它引擎和所有复杂文字编辑细节也都完成。

本台账按历史记录与现有实现文档对照整理，区分以下状态：

| 状态 | 含义 |
| --- | --- |
| 进行中 | 已开始该项实现；注明当前子项，不把整组计划视为已经开工 |
| 待实现 | 已记录的后续工作，尚无完整实现；不是自动承诺下一版交付 |
| 部分完成 | 前置或核心机制已实现，条目中列出的剩余部分仍未闭环 |
| 明确暂缓 | 用户已选择当前不做/不启用；不得因清理 backlog 自动改变决定 |
| 待决策 | 历史候选方向或产品/安全策略尚未选定，不能擅自把建议变成需求 |
| 待验收 | 实现或软件证据已存在，但该项独立的硬件/耐久/发布证据未齐 |
| 已补做 | 曾经推迟，后来已经完成；放入关闭记录，不重复开发 |

**来源编号**沿用原 45 项路线，不是 GitHub issue 编号；A–G 是第二阶段，T/R 是历史主题评审。
每个台账 ID 保持稳定，实施后更新状态、提交和证据，不通过删除条目遗忘历史。
第 16 节以 R1–R6 表示首个可用开发系统的可验收交付目标，T 表示实现任务；
E 是独立增强交付物，C 是未选方向登记，H 是历史证据。旧 141 个 M 子项全部
保留来源映射，但不再用原编号决定归属或沿用错误的整组依赖。
优先级、运行模式、归属、前置、状态和证据分别记录；新安装不会等待旧数据迁移，
普通音频不等待蓝牙，原生文件操作不等待 Portal 或完整管理员 UI。
父项关闭需要所属子项通过；子项按具体前置开工，不反向等待父项完成。
2026-10-08 用户明确区分 Live 与完整安装账户，并再次确认安装首启设置两套独立密码。
第 2–13 节是历史需求/能力来源快照；最新拆分、状态与依赖只看生成的第 16 节。
已勾选项保留其原布局/用例范围；新布局迁移另列子项，不能继承旧布局验收结论。
仅有本台账不等于授权真实磁盘写入、生产密钥操作、外部发布或定时自动化。

## 2. 早期 45 项路线到当前工作的对应

| 原编号 | 原范围 | 当前准确结论 / 剩余去向 |
| --- | --- | --- |
| 1–7 | 首版范围、Alpine 构建、字体、raster/GLES、基础输入、HTTP/XDG | 核心 Linux 路径已实现；具体硬件、文本深度和性能另见本台账，不重做基础引擎 |
| 8 | CI 基线 | 配方/工作流和本地检查已有；远端执行/发布不是已完成事实，见 REL-01 |
| 9–12 | Shell 连接边界、layer-shell、特殊 surface、开发会话 | 基础机制完成；生产会话与恢复见 SES 组 |
| 13–14 | 原生壁纸/面板/Dock、主题应用与保存 | 基础界面及 T1–T5 已完成；外观深化见 UI 组 |
| 15–17 | 最小化、应用启动器、运行窗口按钮 | 基础链路完成；分组/固定/图标、D-Bus-only 激活见 UI/APP 组 |
| 18 | TTY/libseat/DRM 实机环境 | 设备访问和启动链路已有；Debian 实机启动通过，VT/热插拔等细项见 HW 组 |
| 19 | 窗口装饰 | 协商式原生装饰完成；标题复杂文字、内容裁剪和拖动恢复见 TXT/UI 组 |
| 20–23 | 工作区策略/操作、切换器/快捷键、显示设置 | 已选定并实现手动全局工作区和显示回退；动态工作区不是“遗漏待做项” |
| 24 | 剪贴板与拖放 | 输入方向和合成器传输已有；输出拖放、完整语义及剪贴板管理见 DATA 组 |
| 25 | IME/复杂文本 | Rime、HarfBuzz/ICU 核心闭环完成；剩余高级编辑/输入法见 TXT 组 |
| 26 | 通知与托盘 | 标准基础能力完成；历史、丰富内容和兼容细节见 UI 组 |
| 27 | 网络/音频/蓝牙/电源/存储服务 | iwd、私有 PipeWire 已有；服务扩展、授权和外设见 NET/AUD/SES/HW 组 |
| 28 | 设置与持久化 | 主题、快捷键、工作区、显示、音频偏好保存/恢复已有；内存型 Live 不提供跨重启持久卷 |
| 29 | 应用、文件、MIME、默认应用 | `.desktop` 与 managed bundle 已有；文件使用闭环、管理界面和兼容见 APP 组 |
| 30 | 截图/录屏/Portal | 未形成面向用户及第三方应用的完整能力，见 INT-01/02 |
| 31 | 锁屏与认证 | PAM/独立锁机制已实现；完整受保护会话明确没有交付，见 SES 组 |
| 32 | 无障碍 | 未完成，见 INT-03 |
| 33 | 会话生命周期 | 开发启动/退出/有限监督及健康状态已有；登录、注销、恢复、自启动等见 SES 组 |
| 34–35 | 性能预算、异常/耐久 | 已有部分指标和大量有界测试；长期预算/耐久不能据此标完成，见 QA 组 |
| 36 | 包、许可证、SBOM | MIT、依赖清单、校验、源/二进制留存已有；完整履约、构建恢复与发布见 REL 组 |
| 37 | 可启动开发镜像 | 已交付 Alpine 与 Debian ISO/USB；不再是未完成项 |
| 38–39 | 安装/持久化、签名更新/回滚 | 逻辑数据分离和应用替换已有；完整磁盘安装/系统更新/信任见 SYS/REL 组 |
| 40 | 硬件矩阵与发布 | 首台基本运行已有反馈；更广硬件、逐项记录与对外发布见 HW/REL 组 |
| 41–42 | 透明/模糊/动画、主题深化/深色 | 原生 alpha、配置主题已完成；模糊、动画、形状输入、深色等见 UI 组 |
| 43 | 高级窗口体验 | 平铺、overview、多指手势等未选定或未实现，见 UI-08 |
| 44 | XWayland 与沙箱兼容 | 未实现，不是当前原生 Wayland 会话的依赖，见 INT-04/05 |
| 45 | ARM64/Tiny Core/触摸/HDR/VRR/远程桌面/打印等 | 都保留为独立扩展方向，见 EXT 组；不能用“外设以后再说”概括后遗忘 |

## 3. 会话、锁屏与授权：SES

依据：[会话机制](../desktop/SESSION.md)、[桌面监督策略](../desktop/README.md#trusted-shell-connection)。

| ID / 历史来源 | 状态 | 剩余工作 | 重新启动/完成边界 |
| --- | --- | --- | --- |
| SES-01 / 27、R4、本轮安装版策略 | 待实现 | 安装版本地活动用户的关机/重启授权、保存提示及多会话/更新警告；当前界面只有确认和 capability 检查 | 安装版行为已确认，受限授权后端仍需设计；不能只放宽 D-Bus 规则或将 Shell 改为 root。现有 Live 动作保持禁用 |
| SES-02 / 31、R2/R4 | 部分完成 | 普通 Shell 锁屏入口、可信锁进程重新启动/恢复入口、login1 Lock/Unlock 信号联动 | 已有 session-lock/PAM 机制不能替代集成；黑屏覆盖、崩溃恢复和输入隔离必须继续通过 |
| SES-03 / 31/33、R2、本轮安装版策略 | 部分完成 | 图形登录、注销保存流程、受保护 TTY 与恢复路径 | 控制台 setup/PAM 密码登录已接通，桌面退出不再留下 shell；图形界面、锁定与实际注销组合验收未完成。现有无密码 Live 保持原策略 |
| SES-04 / 27/31/33、R4、本轮安装版策略 | 待实现 | 安装版挂起、休眠、锁前挂起、唤醒恢复，盖子/电源键/空闲动作 | 先完成真实认证和锁定/恢复验证，通过后才开放；不能以无密码 Live 直接开启，也不能把休眠默认引入为 swap 或内盘写入 |
| SES-05 / 33、B | 部分完成 | 正式注销/保存提示、应用自启动、窗口/应用会话恢复与必要的进程监督策略 | 与已实现的正常退出/有限 Shell 重启区别开；不得默认杀死普通应用或误恢复旧会话 |
| SES-06 / 25/33/35、B | 部分完成 | IME 自动重启、其它服务的恢复入口、完整恢复/诊断 UX | 当前服务失效会提示、IME 失效恢复普通打字；恢复策略、次数和持有状态需明确，不添加无限重试 |
| SES-07 / 2026-10-07 本轮新需求 | 部分完成 | 图形 setup 及完整取消/中断恢复验收 | 控制台本地设置两套独立密码、普通用户日常 `su -` 和标准改密已实现；root 登录环境与退出后 UID/GID 1000 已核实。无默认密码、无无密码 su，桌面仍非 root |
| SES-08 / 2026-10-07 本轮确认 | 部分完成 | 图形登录/设置认证入口，登录失败、注销、取消和锁屏的完整组合 | 正常安装镜像已要求 `polly` 密码；root 控制的自动登录默认关闭、下一次开机生效、每次启动最多一次。未储存明文密码；锁屏和图形管理员认证仍未接通 |
| SES-09 / 2026-10-07 本轮确认 | 待实现 | `polly` 管理员角色、系统管理认证 UI、受限管理操作及失败/取消反馈 | 普通偏好不提权；账户、安全和系统组件管理需要管理员认证。真实会话身份/角色和特权后端授权必须闭环，不向普通应用开放通用 root 执行入口 |
| SES-10 / 2026-10-07 本轮要求细化 | 部分完成 | P0：迁移 `SystemData/Accounts`、稳定 UID 的 HOME/XDG；补角色、主机/网络状态和维护/救援保留 | 旧 DATA/schema v2 认证及跨槽证据有效；新布局必须联合适配控制器、passwd proxy、NSS/PAM，不整体共享账户表，不重开 setup。见 M01/M06 |

## 4. 桌面交互与外观：UI

依据：[原生装饰和 Shell 限制](../desktop/README.md)、[主题契约](../desktop/THEMES.md)、
[通知/托盘](../README.md#native-status-tray-and-application-menus)。

| ID / 历史来源 | 状态 | 剩余工作 | 完成/决策边界 |
| --- | --- | --- | --- |
| UI-01 / 17、29 | 部分完成 | 任务栏/Dock 的应用图标、应用分组、固定应用；Apps 图标网格 | 当前窗口按钮/启动器是可用文本列表；不能把 managed bundle 的 icon 元数据当成这些 UI 已完成 |
| UI-02 / 13/17 | 待实现 | 菜单/浮层的点击外部关闭等交互收尾 | 当前 Close/Escape 已有；补齐跨 surface 的焦点、事件投递和误关闭回归 |
| UI-03 / 26 | 部分完成 | 托盘主题图标名查找、overlay/动画图标、丰富 tooltip | 当前有 ARGB 内存图标和文字回退；路径/解码/更新仍须有界且校验所有者 |
| UI-04 / 26、44 | 待实现 | 传统 XEmbed 托盘兼容 | 与 XWayland/X11 路径一起评估；不是 StatusNotifier 已实现就自然获得 |
| UI-05 / 26 | 部分完成 | 通知持久历史、markup、外部图片、声音等丰富内容 | 当前是纯文本通知和动作；保存历史/外部资源需明确隐私、容量与资源加载策略 |
| UI-06 / 19/41 | 部分完成 | 客户内容圆角裁剪、桌面背景实时模糊、合成器阴影、精细动画、形状化点击穿透区域 | Dock/菜单已有真实 alpha，不重新列为“完全不支持透明”；预览渐变不算实时模糊 |
| UI-07 / 42、T1–T5 | 部分完成 | Big Sur 等主题的深色变体/深化、任意布局模板、自动文件监听、任意字体文件加载等扩展 | JSON/覆盖/位图/显式重载已完成；模板/监听和字体加载需重新定义受限配置契约，不引入任意主题代码 |
| UI-08 / 19/43 | 待决策 | 拖动最大化窗口恢复、贴靠/平铺、overview、手势及高级窗口规则 | 保留现有浮动、手动全局工作区政策；先选择具体行为，不把其它桌面的交互全部照搬 |
| UI-09 / 25/42 | 待实现 | 输入法候选 UI 的主题跟随 | 当前候选窗口是独立中性样式；不能因 Shell 与应用主题订阅完成就声称 IME 已跟随 |

## 5. 文本、输入法、剪贴板与拖放：TXT / DATA

依据：[文字、Composition、Clipboard API](../README.md#composition-events)、
[原生 IME](../desktop/README.md#native-input-method-service)和原路线 24/25 的保留项。

| ID / 历史来源 | 状态 | 剩余工作 | 当前不应被覆盖的已实现部分 |
| --- | --- | --- | --- |
| TXT-01 / 19/25 | 部分完成 | 合成器窗口标题的 shaping、bidi、字素安全省略及无障碍语义 | 当前独立 Fontconfig/FreeType 标题路径只有基础 Unicode fallback；应用正文已有更完整 shaping |
| TXT-02 / 25 | 部分完成 | 显式段落方向/locale、完整段落 bidi、视觉方向光标 affinity | 当前按字素的逻辑导航和按行推断方向可用；不能把二者说成完全没有 bidi |
| TXT-03 / 25 | 部分完成 | 字体专用连字 caret 表、高级断行/断字 | 当前连字宽度均分用于 caret，已有 Unicode/CJK 换行机会 |
| TXT-04 / 25 | 部分完成 | PollyUI 的 surrounding-text 设置及 delete-surrounding 编辑，Rime 客户端的上下文消费 | SDL 3.4 主机 API 缺相应 setter；合成器对其它 text-input-v3 客户端已有中继支持；要改实际主机/输入链路而非伪造上下文 |
| TXT-05 / 25 | 待实现 | Rime 之外的输入引擎适配 | 依据真实语言/输入需求选择，保持独立可信 IME 进程和敏感字段隔离 |
| TXT-06 / 24/25 | 部分完成 | 无稳定 ID 的 `NInput` 完整选择/剪贴板编辑路径 | 匿名控件目前保留基本追加/退格；稳定 ID 的 `NInput` 与 `createTextInput` 已有完整已声明功能 |
| DATA-01 / 24 | 部分完成 | PollyUI 向外发起拖放、数据 offer 和动作协商、完整 DataTransfer 语义 | 当前合成器指针拖放和 PollyUI 传入文件/文本已实现；`preventDefault()` 目前不协商原生动作 |
| DATA-02 / 24 | 待实现 | 文本输入框接收 drop 后的自动插入与编辑规则 | 现有 drop 只是事件数据；不要默认打开/移动/执行收到的路径 |
| DATA-03 / 24/45 | 待实现 | 触摸拖放 | 现有拖放路径基于指针 grab serial；需真实触摸事件/协议及取消语义 |
| DATA-04 / 24 | 待决策 | 源应用退出后仍保留剪贴板、剪贴板历史/后台管理器 | 当前不持久保留；若新增须明确敏感数据、保留期限和清除策略 |
| DATA-05 / 24/35 | 部分完成 | 接收传输期间的内存上限与大载荷处理 | 现有限额有些在 SDL 收完后检查，不是传输级上限；后续必须验证峰值内存而非只检查最终长度 |

## 6. 网络、音频与外设服务：NET / AUD

依据：[iwd](../desktop/README.md#iwd-network-backend)、
[PipeWire](../desktop/README.md#pipewire-audio-backend)及原路线 27。
以下与“已有 iwd Wi-Fi UI、有线 DHCP、私有 PipeWire 路由”是不同层次的任务。

| ID / 历史来源 | 状态 | 剩余工作 | 完成/决策边界 |
| --- | --- | --- | --- |
| NET-01 / 27 | 部分完成 | 隐藏 SSID、静态 IP、企业网络证书配置的完整管理体验 | 当前有 Wi-Fi 基础连接和预配置 EAP 提示；不得借新 UI 绕过证书校验 |
| NET-02 / 27 | 部分完成 | 有线网络设置/状态管理、VPN | Live 有线 DHCP/DNS 已有，不再记成“以太网完全没实现”；VPN 后端与权限尚需选择 |
| NET-03 / 27/45 | 待实现 | 蓝牙设备发现、配对、连接与管理 | 需要后端、可信交互及真实设备验证，不因音频已用 PipeWire 就自动成立 |
| AUD-01 / 27/44 | 待实现 | PulseAudio 客户端兼容、ALSA 应用重定向 | 不等于替换已有 PipeWire core/自有路由；需验证第三方客户端实际出声和隔离边界 |
| AUD-02 / 27/45 | 待实现 | 蓝牙音频与配置切换 | 依赖蓝牙设备链路和音频 profile/路由政策 |
| AUD-03 / 27/30 | 待决策 | 录音/屏幕采集的 Portal 权限集成 | 当前私有服务/socket 不是每应用权限沙箱；需与 INT-02/05 协同 |
| AUD-04 / 27、A/G | 待验收 | 实体声卡、插拔、profile/端口切换及实时延迟 | 虚拟播放/非零采集通过不是实体扬声器/麦克风的完整结果，详见 HW-01/02 |
| NET-04 / 27/38 | 待决策 | 存储设备的挂载/卸载/安全移除等桌面服务 | 原“存储服务”尚无完整实现；与文件管理及磁盘安装分开，不能自动挂载或写入用户内盘 |
| NET-05 / 2026-10-07 本轮确认 | 待实现 | 安装版连接成功后记住 Wi-Fi、自动重连、忘记网络及跨系统维护/恢复的网络配置保留 | 使用 root 管理的私有系统存储，不放普通 AppData、镜像或日志；权限限制不冒充加密保险库。现有 D1/Live 的 iwd tmpfs 不因文档更新而改变 |

## 7. 应用、文件与兼容层：APP / INT

依据：[应用包契约](../desktop/APPLICATIONS.md)、原路线 16/29/30/32/44 及第二阶段 C。

| ID / 历史来源 | 状态 | 剩余工作 | 完成/决策边界 |
| --- | --- | --- | --- |
| APP-01 / 29 | 待实现 | 文件管理器、文件打开/MIME 关联、默认应用选择与使用闭环 | 能启动 `.desktop`/bundle 不等于能从文档打开正确应用；选择器与 Portal 协调 |
| APP-02 / 16/29 | 部分完成 | `.desktop` 的 D-Bus-only activation | 当前此类入口明确不可用；不得用任意 shell 字符串或伪装普通 Exec 绕过 |
| APP-03 / 29、C | 部分完成 | P0：共享代码、全局注册及来源区分；随后管理 UI 和逻辑 `.app` 呈现 | 当前仍为普通用户私有 CLI/对象库；共享方案需受限授权后端，不能直接 sudo 运行旧管理器。见 M04/M15 |
| APP-04 / C6 | 部分完成 | 安全回收旧版本/孤立代码对象，真正回收卸载空间 | `remove` 只退役注册；脱离主进程的后代可能继续读旧资源，不能只看主 PID 是否退出 |
| APP-05 / C6 | 待实现 | 独立确认后的 AppData 清除 | 默认卸载保留数据；只允许管理器明确拥有的路径，不能和代码回收合并为隐式动作 |
| APP-06 / C1/C5/C8 | 待决策 | 发布者/来源绑定、签名验证、既存未注册数据的接管 | 当前是显式本地安装/替换、未知数据拒绝接管；同名 ID/内容哈希不是可信身份 |
| APP-07 / C5/C8、E | 待实现 | P0：旧用户对象/注册迁移与多用户版本冲突；应用数据 schema/layout 迁移及不兼容回退 | 稳定 app-id 不变，未知数据不收养，冲突未解决不切换；备份、校验、提交和中断恢复不能用清空替代。见 M15 |
| APP-08 / C7/C8 | 部分完成 | 更多真实第三方应用、非 XDG 程序适配、实际上游升级兼容 | 现有代表是同发行版 foot 的重新打包版本，不等于任意应用/数据库版本兼容 |
| APP-09 / C8、D/G | 待验收 | 实际外置持久卷上的安装/更新/回退/卸载跨重启数据连续性 | D1 已验证虚拟盘跨重启/选槽后的安装注册和 AppData 保留；尚未覆盖本项的真实介质及完整更新/回退/卸载组合，依赖 SYS-01/02 |
| INT-01 / 30 | 待实现 | 用户可用的截图、录屏与屏幕/窗口捕获接口 | 测试 harness 的 PNG 截图、QEMU screendump 不算已交付截图/录屏产品 |
| INT-02 / 30/44 | 待实现 | 桌面 Portal，包括应用需要的文件选择/屏幕共享等接口与授权界面 | 先选首批协议范围；接口存在不代表权限/撤销/应用隔离已完成 |
| INT-03 / 19/32 | 待实现 | 语义树、焦点/动作/文本可访问性、屏幕阅读器和 Linux 辅助技术集成 | 可键盘操作不等于完整无障碍；依赖方案须遵守或重新明确自有代码依赖约束 |
| INT-04 / 44 | 待实现 | XWayland/X11 应用兼容 | 当前是原生 Wayland；SDL 有 X11 构建依赖不表示会话已运行 XWayland |
| INT-05 / 44、C | 待决策 | 应用沙箱、兼容打包/权限模型以及与 Portal 的联动 | 不自动选择某个沙箱平台；应用目录只读、同 UID 私有目录、协议过滤都不是 OS 沙箱 |

## 8. 安装、更新、构建与发布：SYS / REL

依据：[底座维护](desktop-base-maintenance.md)、[Debian 构建与恢复](../desktop/release/debian/README.md)、
原路线 8/36–40、R3/R5 和第二阶段 D/E/F/G。

| ID / 历史来源 | 状态 | 剩余工作 | 完成/决策边界 |
| --- | --- | --- | --- |
| SYS-01 / 38、D | 部分完成 | P0：单系统/持久存储/救援虚拟布局与安装器；真实外置目标随后授权 | D1/A/B 证据保留；新布局契约及早期/必需映射后端已实现，完整新镜像未验收。容量实测，不继承固定双槽布局。见 M06/M07 |
| SYS-02 / 28/38、D/G | 部分完成 | P0：分类状态映射、稳定 UID 用户数据迁移、多用户隔离及故障验收 | D1 的 `/home` 与各槽包状态证据不变；新 `SystemData/Apps/Users` 必需挂载，不整体共享 `/etc`、`/var/lib`，不落入空目录。见 M01/M06/M08 |
| SYS-03 / R3/38 | 待实现 | 独立救援已确认并转入 M10；仅持久化 Live 仍待决策 | 救援须有自有内核/initramfs/rootfs，不能留作远期候选；Live 不因此成为第二套安装器。见 M10/M22.1 |
| SYS-04 / 39、E | 待实现 | P0：apt/内核维护、包状态一致性、完整载荷及更新事务 | `Dpkg/Apt` 与软件/启动文件/版本配置同组恢复，最新账户和用户内容另保留；不承诺自动旧版本回退。见 M09 |
| SYS-05 / 38/39、G | 待实现 | P0：独立救援、匹配恢复材料、安装/维护/应用事务中断联合验收 | 主系统资源或包状态损坏后仍可启动救援；无材料明确失败，不能重刷数据或破坏唯一救援入口。见 M06/M09/M10 |
| SYS-06 / 2026-10-07 本轮确认 | 待实现 | 安装版可选用户数据加密、启动解锁、恢复材料及更新/回退兼容 | 首个外置开发版本不自动开启；选择开启时需保存恢复材料，自动登录不能绕过解锁或保存明文密钥。机制未实现时不能显示成功或宣传加密保护 |
| REL-01 / 8、F | 部分完成 | 远端 CI 实际运行记录与构建/发布联动 | 工作流和本地回归已有；历史凭据无法推送，当前权限需实际确认，不把写了 YAML 当作运行成功 |
| REL-02 / 36、F2 | 部分完成 | 不依赖现有缓存，在干净开发环境中断网恢复整个构建工具镜像和最小基础系统 | 已留存关键源码/补丁/运行 DEB；仍需编译工具、开发依赖、bootstrap 与 Live 专属输入及端到端恢复验证 |
| REL-03 / 36、F | 部分完成 | 全部发行材料的许可证、必要源代码及补丁提供义务审查 | MIT 已选，SPDX/许可证文本和自维护源包已有；清单/哈希不是合规审计结论 |
| REL-04 / 36/39/40、R5/F、本轮策略 | 待决策 | 正式系统更新包必须签名/验签的策略已确认；发布渠道、具体签名身份/信任根、密钥生命周期及提升流程待定 | 开发产物明确标为未签名，校验和不是验签；生产私钥由维护者保管，具体生产密钥操作需授权。本地 Mesa 重建包必须与 Debian 官方包身份区分 |
| REL-05 / 39、F | 明确暂缓 | 在线自动更新、定时上游同步和自动发布 | 当前先做手动候选检查/更新；维护节奏文档不等于已授权创建定时任务或无人值守更新 |
| REL-06 / 36、F | 部分完成 | 位级可复现构建的验证和差异归因 | 当前只承诺输入可追踪及已验证的恢复范围，不承诺两次镜像字节完全相同 |
| REL-07 / 40、F/G | 待决策 | 正式对外发布、支持范围、渠道提升与旧版本维护标识 | 本地生成 ISO/用户基本运行通过，不自动构成正式发布或对所有硬件的支持承诺 |

## 9. 硬件、性能与长期可靠性：HW / QA

依据：原路线 18/23/27/34/35/40、[Live 验收范围](../desktop/LIVE.md)和第二阶段 A/B/F/G。

| ID / 历史来源 | 状态 | 剩余工作 | 证据边界 |
| --- | --- | --- | --- |
| HW-01 / A7/18/27/40 | 待验收 | 当前 Debian 实际 GPU/renderer、联网、实体音频等逐项记录 | 启动/基本运行已由用户确认，不再问“是否启动过”；也不据此自动补齐每项结果 |
| HW-02 / 18/23/27/40 | 待验收 | VT 切换/seat 恢复、物理热插拔、多显示器/混合缩放、音频插拔等 | 现有模拟/协议/VM 覆盖独立保存；不强制把所有三 GPU 接线组合变成首发门槛 |
| HW-03 / 40 | 待验收 | 扩大硬件矩阵和驱动回归 | 首台 Intel/NVIDIA 目标不是广泛兼容认证；依据新增设备明确测试范围 |
| QA-01 / 34、F | 待实现 | 启动时间、空闲/峰值内存、帧耗时/延迟、安装占用的可复测预算及优化 | 当前已有镜像大小等指标，但没有完整预算；先测量再定阈值，不凭空承诺体积/帧率 |
| QA-02 / 35、B/G | 部分完成 | 多小时耐久、反复启动退出、设备/服务丢失后的恢复验证 | 已有 10 轮生命周期和大量有界故障测试，不等于长期耐久已完成 |
| QA-03 / 34 | 待决策 | 更深入的增量布局、dirty-region/display-list、动画调度等共享引擎优化 | 来自引擎长期路线；是否投入由实际测量决定，不因桌面采用 PollyUI 就全部成为发行阻断 |

## 10. 跨平台与较远期扩展：EXT

依据：原路线 45、Windows Shell 替换的历史讨论，以及[跨平台说明](PORTING.md)。
这里记录候选范围，不给未经批准的交付日期或默认技术方案。

| ID / 历史来源 | 状态 | 保留的任务 | 重新启动条件 |
| --- | --- | --- | --- |
| EXT-01 / 45 | 待决策 | ARM64 构建、依赖、镜像与设备支持 | 指定设备并完成独立 ABI/驱动/启动验收，不复用 x86_64 二进制 |
| EXT-02 / 初始底座讨论、45 | 待决策 | Tiny Core 可行性/移植 | 当前选择 Debian；不是默认长期同时维护 Debian/Alpine/Tiny Core |
| EXT-03 / 45 | 待实现 | 多点触摸、触摸设备与系统手势 | 确定设备及与窗口策略的关系；与 DATA-03 协同 |
| EXT-04 / 45 | 待决策 | HDR 显示链路 | 明确目标设备/色彩输出/客户端能力后独立实现和测量，装了 Mesa 不等于已有 HDR 桌面 |
| EXT-05 / 45 | 待决策 | VRR 可变刷新率 | 明确驱动、输出与呈现策略后验证；与已有固定刷新率设置区分 |
| EXT-06 / 45 | 待决策 | 远程桌面 | 会话、采集、输入授权和传输后端需设计；截图测试/嵌套 WSLg 不是远程桌面产品 |
| EXT-07 / 45 | 待决策 | 打印支持 | 后端、发现、配置/权限和真实设备验证 |
| EXT-08 / Windows 讨论 | 明确暂缓 | Windows Explorer/Shell 替换 | 用户要求先完成 Linux；需独立 Win32 桌面集成、测试账号/VM 与恢复方案，不替换 Windows DWM |
| EXT-09 / 共享运行时路线 | 待决策 | macOS HTTP/应用数据目录完善、iOS/Android 触摸/生命周期/打包、bare Wayland/DRM 主机等 | 属于 PollyUI 跨平台路线，不因列入本台账就排进 PollyOS 第二阶段 |

## 11. 不应继续算“延期”的已补做项

| 曾经留下的事项 | 当前结论 / 证据 | 仍须区分的余项 |
| --- | --- | --- |
| 主题完全依赖编译期固定 ID/硬编码 | T1–T5 已补：JSON/覆盖、位图、同 ID 更新、原生快照与应用 opt-in，`1ccc4bf` | UI-06/07/09，不重新宣称配置化还没实现 |
| 只有 Shell 重启保留工作区 | 名称/顺序/当前工作区跨会话恢复已补，`d6d6452` | SYS-02 物理持久卷和 SES-05 全应用恢复 |
| 显示配置、音频偏好不保存 | 显示 `72b2f8f`、音频 `d0e38a0` 已补 | Live 重启数据丢失不是保存 API 没实现 |
| 原生输入法、复杂文本、通知/托盘、Wi-Fi/音频主链路 | 分阶段已实现并验证；参见当前总览功能矩阵 | TXT/UI/NET/AUD 中明确的高级子项 |
| 缺项目许可证、运行包和 Live | MIT、可重定位运行包、UEFI ISO/USB 已补 | REL-03/04/07，不把依赖合规/签名混为一谈 |
| 没有 PAM/真正锁协议 | PAM 和独立 fail-closed session-lock 机制已补 | SES-02/03/04，不能启用密码空缺的 Live 锁 |
| 应用包只有 schema/计划，无安装执行 | 实际 `polly-app` 安装/Apps 启动/替换/回退/退役恢复已补，`9894810` 等 | APP-03–09；`foot` 代表适配不是全部第三方兼容 |
| 自维护源码仅能导出、不能恢复 Git | bundle + 原始浅克隆边界恢复已补，`4bdccdd` | REL-02，不能由此声称完整 SDK 已能从空环境断网重建 |
| Debian 图形内存检查未通过 | Mesa 生命周期修复及最终 71 项 ASan/UBSan 已通过，`b68faa6` | 保留回归与未来补丁删除条件，不继续当现有 blocker |
| Debian 尚未实机启动 | 用户 2026-10-07 确认可启动运行，文档记录 `bea2ace` | HW-01/02/03 逐项、耐久和扩展设备证据 |

## 12. 已选择不做的路线，不是自动待办

| 已确定的约束 | 不应误列成“以后必须补齐” |
| --- | --- |
| 手动、全局工作区，保留空工作区，全屏不创建独立 Space | GNOME 式动态工作区、每显示器独立工作区、全屏自动建 Space 未获选择 |
| 自研 PollyWM + wlroots | 改成 labwc/GNOME/KDE 不是为了完成功能而默认采用的后备方案 |
| 自有代码不引入 GLib/GIO/GObject | 不默认改用 GIO 启动器、依赖这些库的完整输入法 UI 或其它现成桌面组件 |
| iwd + 自有网络 UI；PipeWire core + 自有策略 | NetworkManager、WirePlumber 不是“尚未安装的必需依赖” |
| Shell 读取受限主题数据，应用自愿订阅 | 可执行主题插件、合成器解析任意主题脚本、强制重绘第三方内部控件不属于已批准任务 |
| 先完成 Linux | Windows 共享 UI/主机已存在，不等于授权修改宿主 Explorer/Shell 配置 |

## 13. 本轮新观察，不伪装成历史延期：OBS

| ID | 状态 | 观察与待决策内容 |
| --- | --- | --- |
| OBS-01 | 待决策 | Foot/Server/Client 三个入口均显示；Debian dash + GNU ls 与 Alpine ash + BusyBox ls 的颜色/提示符默认不同。是否只保留普通“终端”入口、选哪种交互 shell、统一哪些 alias/配色，尚未决定，不能擅自改成 bash/zsh 或启用服务 |

该观察来自 2026-10-07 本轮终端讨论，不是早期已承诺但漏做的功能。

## 14. 实施顺序与维护规则

**当前先执行 P0 存储迁移，具体顺序与状态见第 16 节执行入口。**
它贯穿 C/D/E，不等待完整图形 Setup、锁屏或高级桌面功能才开始虚拟布局和维护验证。
新布局软件闭环后继续 B 可靠性、完整受保护会话、真实外置安装及 F/G 发行/联合验收。
A 的基本实机启动已通过；历史 ID 不因优先级调整重编号。

- D/E 从可丢弃虚拟盘开始；真实磁盘目标、写入授权、签名密钥及对外发布另行确认。
- 已生成无密码 Live 的限制保留为历史范围；后续 Live 按第 15 节公开默认凭据实施，但不会因设置密码自动开放未验收的锁定/挂起。INT/EXT 只有在选定或成为已批准功能的真实依赖时才实施。
- 待实现项不自动互为前置条件，例如截图/无障碍/深色主题不是持久安装的当然前置条件。
- 完成一个条目时，附准确提交、用例/产物、验证范围和剩余限制；必要时拆出新的子项，保留原 ID。
- 每轮更新计划数据中的具体子项、状态和准确证据，再生成本文并同步应用 Plan；未提交明确写未提交，失败/中断记录保留。其它文档只链接入口，不复制动态清单。
- 应用 Plan 显示 R/T/执行子项以及独立 E/C/H 和授权门槛。模型显式记录归属和具体前置，旧组件不重复计数；界面具体展开/布局不作为模型正确性的替代证明。
- 主会话优先实现并自动本地提交固定快照，继续下一项；编译/验证交给临时 worktree 分支子会话异步进行。实现已提交但验证未返回保持进行中，按固定快照结果关闭；验证修复经主会话审阅合并。不给主会话安排阻塞等待，不自动 push/PR；真实授权仍单独确认。
- 2026-10-07 用户要求缩短验证反馈：默认使用 `desktop\tools\check-storage.ps1` 的语法、针对性单测及 C 严格编译，不每次修改重建/启动镜像。映射改动加 `-Mode mounts`；已打包 initramfs 检查用 `-Mode initramfs`，缓存不匹配明确失败。启动链/分区/内核变更及阶段交付仍需实际启动验收，快速检查不冒充系统可启动。
- 新发现的需求记录来源，区分“历史欠项”“新观察”“已否决/被替代方案”，不从“目前不支持”推导出必须实现。
- 这里只覆盖 PollyOS 相关历史任务及明确的跨平台边界；PollyUI 所有控件/渲染 API 的长期功能矩阵仍见 [ROADMAP.md](../ROADMAP.md)，不整体搬成操作系统需求。

## 15. Live 与完整安装的已确认策略：2026-10-08

用户明确选择“输入 polly 密码，但可设置自动登录”，随后确认其余采用下面的
macOS/Windows 风格交互约定。2026-10-08 又明确要求 Live 有默认账户/密码和
root 密码，并选择安装首启仍必须设置用户与独立 root 密码。这些是目标策略，
不改变已经生成的镜像，不声称 macOS/Windows 具有相同配置或默认 root 账户。

U 盘既可承载 Live，也可承载完整安装；策略由运行模式决定，不能按介质类型推断。
Live 开发默认账户为 `polly`，公开初始密码为 `polly`，root 公开维护密码也为 `polly`；
默认普通用户自动进入桌面，改密只在当前临时会话保留，SSH 等远程登录不默认开启。
公共底座保持锁定模板，公开密码只进最终 Live 配置层，不进入安装或独立救援。
公开密码仅便利体验，不保护个人数据；旧无密码 Live 产物仍按原范围解释，
密码设置不自动放行锁屏/挂起。持久化 Live 是未选方向，另行决定。

| 范围 | 已确认的目标行为 |
| --- | --- |
| Setup | 完整安装首次必须本地设置 `polly` 与独立 root 密码，无安装默认密码；成功后写初始化权威。新安装不等于迁移，不能复制 Live shadow 或覆盖旧账户 |
| 日常身份 | `polly` 为管理员账户，但桌面和应用仍以普通用户运行；`su -` 用 root 密码临时提权，不被 sudo-only 替代 |
| 登录 | 默认密码登录；自动登录显式开启，修改需管理员认证，不保存明文密码 |
| 系统管理 | 账户、系统组件及安全设置需管理员认证；主题、音量等普通偏好无需提权 |
| 锁定 | `polly` 密码解锁；默认无操作 10 分钟锁屏，可配置；唤醒后认证，注销不遗留已登录 shell，TTY 不得绕过锁定保护 |
| 电源 | 本地活动用户关机/重启不每次要求 root 密码；应用有保存机会，多用户会话/正在更新时警告，不静默强杀 |
| 挂起/休眠 | 先锁定，唤醒后认证；通过锁定/恢复和指定硬件验证后才开放，普通关机不等待它们完成 |
| Wi-Fi | 成功连接后默认记住并自动重连，支持忘记网络；凭据归 root 私有系统存储，权限保护不宣传为加密 |
| 加密 | 首个外置开发版本不自动开启，保留可选加密实施任务；开启需保存恢复材料，自动登录不得绕过磁盘解锁 |
| 更新 | 可写单系统使用 apt 维护；完整载荷更新/恢复走受控维护或救援流程，匹配包数据库并保留身份与用户数据；不默认开启在线自动更新或上游定时同步 |
| 签名 | 正式系统更新包签名并验签，失败则拒绝；维护者保管私钥，客户端仅持公钥，开发产物明确未签名 |
| 授权边界 | 普通实现按已确认策略推进；真实介质写入/清除、生产密钥和对外发布需具体授权；不自动修改 Secure Boot 配置 |

账户、密码哈希、管理员策略、主机身份与网络凭据属于需明确保留的系统状态，
不是普通 AppData；系统安装/恢复材料不能覆盖最新记录，也不能由普通应用任意改写。
登录密码不提供离线磁盘加密，`su -` 不把普通应用目录隔离升级为 OS 沙箱。

## 16. 完整执行清单与依赖

计划数据唯一源为 `docs/POLLYOS-PLAN.json`；本节与应用 Plan 均从它生成，不分别维护状态。
A0 是当前 Alpha 门槛；A1 是系统自带 App，B1 是系统构建，O1 是后期系统优化。R/T/E 的原任务 ID 和旧来源保留，归属调整不等于任务已经完成；C 是未选方向，H 是历史证据。
旧 M 编号仅作来源索引，不再决定归属、顺序或依赖。拆分后的完成只承认对应组件证据，不继承整组验收。

### 当前执行顺序与首个可用版本边界

| 队列 | 当前交付 | 放行与并行边界 |
| --- | --- | --- |
| P1 / 当前 | A0 Alpha 可手测系统 | 先完成功能闭环，再统一产出一个新候选，集中手测；旧候选已可用不代表最新源码和首次图形入口已完整验收 |
| 已具底座 / 保留 | R1 Live 模式；R2 启动账户；R5 基础桌面 | 原组件、来源和限制保留；Alpha 只依赖 A0 明列的具体子项，不把全系统里程碑的所有未完成项目叠成门槛 |
| P2 / 自带 App | A1 系统自带 App | 基础 Files 先冻结，复制/跨目录移动/回收站与还原等强化推迟；未完成草稿不合入候选 |
| P2 / 系统构建 | B1 系统构建 | 完整断网构建、CI、位级复现、渠道和正式签名身份后期单独安排；保留必要许可证和当前物料来源，不宣传已经全部履约 |
| P2 / 后期项目 | O1 系统优化 | XP 精修、复测、视觉效果、XWayland、采集、硬件热插拔、有线、锁屏、共享包、多用户及授权外置安装不阻挡 Alpha；仍保持未完成/未授权状态 |
| 长期完整系统 / 保留 | R3 维护与救援；R4 迁移；R6 安装写入 | 完整系统要求不删除；Alpha 虚拟候选不等于实盘安装器、独立救援、生产安全或硬件认证 |
| P2 / 其它独立增强 | E 系列 | 其余增强按原具体前置独立推进，不自动成为 Alpha 门槛；休眠、加密和生产密钥保留授权边界 |
| P3 / 未选方向 | C1 | 只登记方向，选择目标/范围后另立执行任务；不把全部候选变成一个必须完成的里程碑 |

**依赖语义：** `归属`是完成汇总；`前置`是实际实现/验收所需的具体子项。父节点关闭依赖子节点，不反向阻塞子项开工。
同一技术后端可以支撑不同交付物；跨组前置不改变归属。里程碑的进行中可以表示部分子项完成，不代表全组已开工。
保持普通用户桌面、标准 PAM/passwd/su、版本配套服务账户、源/备份保留和故障显式拒绝；不整体共享 /etc 或 /var/lib。
执行方式：功能代码优先，只保留必要编译/类型检查及直接小回归；功能闭环后统一候选、集中手动测试，不再为每项功能扩测试夹具/矩阵、反复构建 VM。
实现、源码资格、原生组件、媒体启动和用户手测分证；完成声明只覆盖对应范围，不能把旧媒体重标为新修复或把延期标成已完成。
每批更新 JSON 的状态/证据，运行 `desktop/tools/polly-plan.py --write` 生成文档并同步 Plan；仅一个重型构建/VM lane。不自动操作用户正在使用的 VM、磁盘或密码。

### Alpha 剩余工作

以下是当前 Alpha 的唯一门槛，不以全表任务完成比例估算版本距离。

| 收尾包 | 状态 | 具体边界 |
| --- | --- | --- |
| A0.1 基础功能代码集成 | 已完成 | 将已具备的模式/账户/普通桌面/系统设置/基础 Files/原生打开保存与当前功能修复汇入同一主分支，不携未完成强化草稿。 |
| A0.2 必要功能闭环 | 进行中/部分完成 | 剩余近程功能：首次启动图形入口稳定、密码登录/失败重试、普通注销与保存、普通关机重启；不以重启可进桌面当首次图形问题已修。 |
| A0.3 统一 Alpha 候选介质 | 进行中/部分完成 | 从功能闭环后的同一固定 main 生成一次新 ISO/VHDX、必要运行库与模式正确的发行说明，准确列出已知限制。 |
| A0.4 集中手动验收 | 进行中/部分完成 | 按一份简短清单集中手测冷启动/首设/登录、再启动与基本持久性、窗口交互/设置/基础文件与打开保存、注销与正常关机，修复阻塞后冻结 Alpha。 |

版本范围、已交付介质和最短手测清单见 [Alpha 路线](POLLYOS-ALPHA.md)。


### A0 Alpha 可手测系统 — 进行中/部分完成

**交付/边界：** 首个面向普通用户的开发版：可启动的 Live ISO 与单 SYSTEM 安装版虚拟磁盘、稳定首次设置/密码登录、基础 Shell/设置/应用和打开保存。不是空白磁盘安装器、受保护生产桌面或硬件认证版本；后期项目不作为 Alpha 前置。

- [x] **A0.1 基础功能代码集成** · 已完成 · P1 · candidate：将已具备的模式/账户/普通桌面/系统设置/基础 Files/原生打开保存与当前功能修复汇入同一主分支，不携未完成强化草稿。 证据：历史 ce73a3c 已集成基础 Files、中央接线、控制台服务闭包和闲置窗口修复，未收养旧 Files 419 行未验证草稿。2026-10-15 最新功能组合 6298ff3e57c687a21fd6e9f8edce0b3803c7f3f9 已正常推送 origin/main 并独立核 remote SHA：六页独立 Settings、Apps、小范围图形能力、主题/常规指针、GUI 窗饰分层、固定 ISO 硬链接发布及菜单定位/外点输入修复均在主线。Mac source 同批推送，但 Darwin 默认 OFF、仍未原生编译/测试；推送不授权新 CI/生产发布。集成完成不等完整 Alpha/实机/安装版验收。
- [ ] **A0.2 必要功能闭环** · 进行中/部分完成 · P1 · installed：剩余近程功能：首次启动图形入口稳定、密码登录/失败重试、普通注销与保存、普通关机重启；不以重启可进桌面当首次图形问题已修。 前置：T14.1、T14.2、T14.3、T15.4、T22.2。 证据：2026-10-09 4e6b004 受限候选已实际交付：生产默认新 guest 图形首设、标准 PAM 错误拒绝/正确重试、普通登录、正常 Logout回greetd、真实 managedApp close-veto/Cancel/nativeSave、标准Reboot、原密码再登录及Classic/26字节用户文档普通读回均确证。首启排序修复与busy UI-only修复已父审合，61项最终证据全hash核。Shutdown GUI仍ready/NoSend，当前没有实际关机证明；长批量QMP输入Wayland4KiB/Foot断管未修且普通持续输入范围未资格。保持功能闭环/完整Alpha未完成，不把诊断host-qmp-quit当PowerOff；旧Hyper-V未改、现场由用户测。
- [ ] **A0.3 统一 Alpha 候选介质** · 进行中/部分完成 · P1 · live/installed/candidate：从功能闭环后的同一固定 main 生成一次新 ISO/VHDX、必要运行库与模式正确的发行说明，准确列出已知限制。 前置：A0.1、A0.2。 证据：历史 4e6b004 的未初始化 VHDX 与原 Live、其原始日志/资格保持不变。2026-10-15 新 Live 为实际 clean b7e7a700563b4b1763f305da6a9946f08df20660，tree 9c129e296b4dc970065c61a9e5e00627dd29203e 等于已推送 main 6298ff3；源/runtime/overlay/producer同版本真实重编。D:\temp\PollyOS\PollyOS.iso 是版本目录内 ISO 的真 NTFS 硬链接，711092224 字节，SHA256 54c4cde209fe98cb92aa9cb7e07872530693109b57b96267ce819364289e046c。新 63 项/旧 72 项 checksum、ISO 297 路径/17 overlay、实际 EFI/GRUB 及 UID1000 打包 WM/Shell Wayland raster 首帧通过。新 ISO 的 UEFI/Hyper-V/实体资格未自动取得，也没有更新 installed VHDX；因此统一 Live/installed Alpha 仍部分完成，旧 Shutdown/长输入失败不被本次构建抹除。
- [ ] **A0.4 集中手动验收** · 进行中/部分完成 · P1 · candidate：按一份简短清单集中手测冷启动/首设/登录、再启动与基本持久性、窗口交互/设置/基础文件与打开保存、注销与正常关机，修复阻塞后冻结 Alpha。 前置：A0.3。 证据：本轮集中有界真实QEMU/TCG短测已完成结果评估并交付4e受限预览：首设/PAM拒绝重试/登录/注销/应用SaveCancel/标准Reboot/偏好与文档持久性/LIVE普通桌面能力状态已核；Shutdown GUI未产生动作，Foot长批量输入断管范围未修，不能完整验收。用户Hyper-V现场测试及阻塞修复后冻结仍待完成；不自动操作其VM/密码/磁盘，不把诊断清理或源Mock计绿。

### A1 系统自带 App — 已延期 / 进行中/部分完成

**交付/边界：** 当前基础自带 App 够用即冻结；文件管理器的复制、跨目录移动、回收站/还原及其它强化单独安排，不阻挡 Alpha。


#### App1 文件管理器

真实文件浏览/修改的用户操作闭环；设备挂载与文件 Portal 是其它任务，不要求它们全完成才浏览现有 HOME。

- [x] **T19.1 文件浏览与属性** · 已完成 · P2 · installed：当前基础 Files：普通用户真实目录浏览、导航、类型/属性、MIME 打开、新目录与同目录不覆盖重命名；高级图标、搜索与文件操作另列后期。 来源：M16.1。 证据：用户要求增加功能并行，固定0f86311，子会话4b0f28e2-6cc2-48f5-b900-3d9b04d7ab8c实现普通用户原生目录导航/属性/真实MIME打开、新目录/重命名；唯一共享FS后端供选择器使用，不重复root broker。以真实浏览/操作为交付，原生功能验收待返回。 第四批实现与中央接线已快进到本地主分支 ce73a3c；新引擎中实际指针/滚轮/Backspace/创建/重命名/MIME helper 读文件/WM 关闭与六张原生 app-buffer 图通过。完整 ISO/VHDX 手测与高级 App 强化不在此基础项完成声明内。
- [ ] **T19.2 文件操作与覆盖** · 已延期 / 进行中/部分完成 · P2 · installed：后期文件 App 强化：二进制/目录树复制、跨目录移动、删除到回收站和还原；默认保留已有目标，不隐式合并或永久删除。当前创建目录、同目录重命名和文本强观察覆盖保留。 前置：T19.1。 来源：M16.2。 证据：历史第四批完成新目录、同目录无覆盖重命名和文本强观察覆盖；旧 bunnysoft-files-operations 的 419 行未验证草稿仍保留、不因此收养。后续 3919661 随 da59cc0 集成并已进入当前 Live：Cut/Paste 仅移动一个用户拥有、非 set-ID 的普通文件（可为二进制），同文件系统、跨目录、显式确认、renameat2 NOREPLACE 和源/目录身份验证，提交后错误单独报告。复制、目录树操作、跨文件系统移动、回收站及还原仍未实现，不能关闭整项；未来删除默认回收站/支持还原的已选需求保留，不自动授权操作用户文件。

#### App2 任务管理器响应与采样性能

修复只读Processes列表全量重建和连续同步采样造成的主线程卡顿/CPU开销。保留全部最多4096观察、两秒采样、排序、真实CPU/PID身份与错误/关闭语义，不增加终止进程等管理权限，不通过缩样本或延长周期假优化。


### B1 系统构建 — 已延期 / 待实现

**交付/边界：** 保存现有可重建配方与物料来源；完整断网构建、CI、位级复现、渠道/签名身份和正式分发后续单独完成，不把当前缓存复用叫断网复建成功。


#### T27 开发候选物料与分发

来源/许可材料和下载/raw/占用实测对应当前候选；正式身份和线上自动发布不混入开发分发。

- [ ] **T27.1 许可证与发行物料** · 已延期 / 待实现 · P2 · release：许可证、必要源码/补丁、SPDX/SBOM 和发行履约审查，清单/哈希不冒充合规结论。 来源：M21.3。
- [ ] **T27.2 压缩分发与容量** · 已延期 / 待实现 · P2 · release：提供压缩分发包及解压内容/容量校验，分别记录下载大小、raw 逻辑容量和实际占用；不能承诺未经测量的 600 MB。 前置：T27.1、T03.8。 来源：M21.4。
- [ ] **T27.3 手动候选与已知限制** · 已延期 / 待实现 · P2 · release：手动候选/安全包检查、新布局迁移/救援说明及已知限制；在线自动更新、定时同步/自动发布继续暂缓。 前置：T07.1、T09.3、T27.1。 来源：M21.7。

#### E17 远端 CI 可运行

在授权仓库/权限范围真实运行 CI，来源/依赖/失败可追溯；不自动 push 或取得权限。

- [ ] **E17.1 远端 CI 与固定输入** · 已延期 / 待授权/待决策 · P2 · installed：实际运行远端 CI，记录来源/脏状态、固定输入、依赖/补丁/包版本和失败信息；推送/权限按实际状态处理。 前置：授权。 来源：M21.1。

#### E18 干净环境离线复建

从留存源/包/补丁恢复 SDK 与基础系统，断网复建；缓存可用不冒充恢复成功。

- [ ] **E18.1 断网构建环境恢复** · 已延期 / 待实现 · P2 · installed：在干净环境从留存材料断网恢复 SDK/基础系统，补全开发依赖、bootstrap/Live 输入及源包。 来源：M21.2。

#### E19 位级复现与归因

对具体产物比较位级结果并归因；固定输入不自动意味着字节相同。

- [ ] **E19.1 位级可复现与归因** · 已延期 / 待实现 · P2 · installed：验证位级可复现性与差异归因；当前可追踪输入不自动宣称字节相同。 前置：E18.1。 来源：M21.6。

#### E20 正式信任与发行准备

确定支持/渠道、系统与应用来源/签名、未知数据接管及密钥轮换策略；生产密钥/发布另授权，未决前只显式本地安装且拒绝未知接管。

- [ ] **E20.1 支持范围渠道与身份** · 已延期 / 待实现 · P2 · installed：确定正式支持范围、渠道、发布提升/旧版维护标识和签名身份/公钥、密钥轮换/撤销流程。 来源：M21.5。
- [ ] **E20.2 发布者与数据接管** · 已延期 / 待实现 · P2 · installed：设计发布者/来源、签名和未知既存数据接管机制；未决定前维持显式本地安装和拒绝未知接管。 来源：M15.5。
- [ ] **E20.3 生产材料与发布** · 已延期 / 待授权/待决策 · P2 · release：在身份/渠道选择后，按具体授权处理生产密钥、公钥部署与发布提升；规划和测试材料不需要生产权限，实际动作不以此前本地提交为授权。 前置：E20.1、授权。 来源：M21.5。

### O1 系统优化 — 已延期 / 进行中/部分完成

**交付/边界：** 后期按独立项目完善复测、视觉精修、XWayland、屏幕采集、目标硬件热插拔、有线网络、锁屏认证、共享包、多用户隔离和授权外置安装；延期不等于完成，授权边界不解除。


#### E22 Windows/Mac 六主题对齐

按 XP SP3 Luna、Server 2003 SP2 Classic、Windows 11 24H2 light、OS X 10.4 Tiger/10.7 Lion、macOS 11 Big Sur 六个既定目标，逐项跟踪标题栏/按钮、任务栏/Start、菜单栏/Dock、控件/字体/图标及真实材质差异。共享机制与主题局部数据分层；已修复项保留完成记录，参考不足与未实现功能分别说明，不以预览或局部像素吻合宣称整系统1:1，不强制第三方 CSD/控件改样式。

- [ ] **E22.1 XP 固定参考与测量** · 已延期 / 待授权/待决策 · P2 · installed/live：建立 XP SP3 Luna 来源可追溯的版本、DPI、窗口/标题按钮/任务栏/菜单代表状态截图，测几何、字体度量、颜色和边缘；权利不明材料只参考分析，不打包。 证据：GUIdebook原系统参考URL/SHA/明确crop已入xp-reference.json，但原截图SP3/精确96DPI未认证，字体与品牌资源不打包。历史用户将全量参考/DPI/状态测量列为系统优化并延后；新要求完成全部E22后已重新核现有材料，仍缺可验证版本/缩放/交互状态的原尺寸包。明确询问素材路径时用户不可用，不能从自主工作指示推定来源、授权或精确DPI；等待合格输入，不以公开阅读图或组件预览补造验收。
- [x] **E22.2 控件与装饰绘制** · 已完成 · P1 · installed/live：历史已完成 XP 小批：30px 任务栏、21px 标题按钮、多段绘制/bevel、原创通用图形及基础控件状态，绘制/命中尺寸一致；保留其它主题及数据安全契约。后续 GUI 窗饰迁移不撤销该已完成基础项；完整颜色/状态/Start 差异另列具体任务。 来源：M17.4、M17.5。 证据：1176066与startup修复1d5254a纳入固定最终组合a5e176a；完整新native build、13selectors、3真实PollyUI/实际四scale组成截图通过。source-reviewed startup typed拒绝/generic schema1真实回退通过；非整桌面1:1/官方字体或品牌资源认证。 Alpha 的当前 XP 基础窗口装饰绘制保持已完成：标题栏、按钮、任务栏与 bevel 已有固定原生四倍率证据；未完成的完整 Start、disabled/focus、外部托盘图标和参考认证仅属后期精修。主题刷新后的闲置窗口拖缩是独立交互缺陷，ce73a3c 已修功能源码，旧 e879 媒体没有该修复。
- [ ] **E22.3 XP 真实截图差异验收** · 已延期 / 待授权/待决策 · P2 · installed/live：固定实现提交在独立验证lane真实绘制截图，对照裁剪部件的几何/颜色/状态与已定义图像差异；说明字体/授权资产/抗锯齿和未实现效果，迭代，不以mock或预览替代native。 前置：E22.2、E22.1。 证据：历史临时集成c49真实1/1.25/1.5/2组成36截图，a5重验13native与3pixelfixtures；30px无文本caption strip原对照MAE1.0222不是桌面分数，SP/DPI认证、完整reference/disabled/focus/SNI外部图标未覆盖。新全E22目标下仍受xp-reference-baseline缺合格原图及当前paired compositor环境所阻；旧证据保留，不拿新软件fixture或旧ISO冒同版本完整桌面验收。
- [ ] **E22.4 六主题参考与状态来源** · 已延期 / 待授权/待决策 · P2 · installed/live：补齐 Classic SP2/96DPI、Win11 build/100% 与三套 Mac 的 display scale、Dock 图标尺寸/放大开关、light/tint 等参考元数据及 active/inactive/hover/press 状态。逐条关联原始图/hash/crop；证据不足只标待测，不猜颜色或把 JPEG 转 PNG 当无损原图，不阻塞已能独立证明的局部修复。 证据：alignment-reference.json已有六目标/公开阅读来源；用户Win2K3 VM截图a92ec32d...与e333e3f9...提供真实状态但为JPEG，SP/DPI/显示深度未认证。Mac无完整原尺寸合规raw pack，Win11无build-tagged全状态原图。全E22推进时已明确询问本地路径/来源但用户不可用，现无可据其补齐的元数据；不得猜测、把JPEG转PNG冒原图或将未测项写成确定像素bug。
- [ ] **E22.5 字体与文字基线** · 已延期 / 进行中/部分完成 · P2 · installed/live：逐主题列出 Tahoma/Trebuchet、Segoe UI、Lucida Grande、San Francisco 与当前通用 fallback 的字宽、字号、粗细、标题基线及抗锯齿差异；用合法可用字体和真实度量决定可配置替代方案。保留 Unicode shaping，不打包未授权字体、不强制全局别名或固定分辨率；影响主题通用性的选择先确认。 证据：六主题原系统字体未分发，Classic GDI基线/栅格资格仍不齐。2026-10-16 用户要求共通先行，876d126（源e549b336）统一六主题caption fitter：复用现SDK/LinuxICU完整字素，512codepoint预算向下贴cluster，省略测完整prefix+ellipsis；baseline/clip/shadow原坐标不动。window.fontFamily兼容三generic并接受128UTF16上限单个literal已装family名，严格拒路径/URL/control/格式控制/列表/资源，不load字体、不改builtin/fallback/JSON1。父Node5/5与真实5906LinuxCanvas/ICU验证capRepairs3（combining/ZWJ/flag）、ellipsisRepairs0如实，六主题ASCII/empty/narrowellipsis四strip bytes不变且clip外像素/侧条保持；已装DejaVuSerif/Sans实际字宽130.078125/122.421875。后续294677a合16d8898让Files普通name接fontSize、三metadata接statusFontSize，Classic/XP11/11、Mac13/13、Modern14/12，保42px/列/selectionink/input/panel/bar/controller。1d27b5e让Processes正文/状态/标题及留白接同现theme token，不改虚拟化/采样/只读行为。应用样式直接修、复用既有检查，无新测试或字体/排版架构。非Linux仍既有codepointfallback，不假称全平台grapheme、原OS字体或像素一致；E22.5保持partial。
- [ ] **E22.6 图标与品牌资源差异** · 已延期 / 进行中/部分完成 · P2 · installed/live：分别记录 Windows Start/应用/任务/托盘图标、Mac Dock 应用图标与桌面标签的形状、尺寸、对齐和当前 Polly 原创图形差异；优先接真实应用已有合法 artwork，缺失时明确 fallback。系统品牌图标、壁纸和字体只在授权明确时考虑；参考图不能直接变成 runtime 资源，原创图形不宣称官方像素复刻。 证据：现用 Polly 原创图标；Classic 参考曾无可同内容比对的普通任务图标，Mac authentic icons 明确未实现。2026-10-16 合入并推送 b7f2916（源 e3d7201）：新增严格可选 icons.desktopLabelStyle=capsule|shadow，缺省及显式 capsule 保持 schema1 原样，仅有桌面原图参考的 Tiger/BigSur 主动启用 shadow，Lion/XP 不变。原 native 主文本布局、86宽/44高裁剪、36图标及持久位置不变；阴影是同宽、向下1logicalpx、aria-hidden/pointer-none的原生文本层，selected 保旧色和结构。父 Node12/0 与真实GUI四主题的 wrap/Unicode/bitmap/fallback/选中/双击/Enter/拖放/框选通过；Lion/XP全图bytes不变，Tiger/BigSur变化限定原标签框。另真实私有Wayland六场1/1.5/2使用已冻结WM/GUI和当前JS通过，不是物理HiDPI、Darwin或完整main-native认证；平台A11y provider不可用，不宣称screenreader实测。后续1df7866合8fd7af8复用原safe bitmap loader/cache，将实际注册PNG/JPEG接Windows taskbar与三MacDock任务/分组slot；retain是桌面shortcut与当前任务所需资源并集，异步ready重画实际panel/Dock，保原16/24/内图盒、原色、count/marker/guards/几何。exact catalog或受校验bundle身份，不按title/PID/basename猜；missing/命名/SVG/非法资源走明确report与原fallback，不新增resolver/C/schema/cache架构或应用测试。本host无实际注册PNG/JPEG，故未冒系统catalog端到端图标实证，不为查看启动VM/环境支线。合法系统品牌资源、精确字体/阴影raw、Lion桌面图标参考及全图标资格仍待完成，不以此子集关闭E22.6。
- [ ] **E22.7 按钮边线与交互状态** · 已延期 / 进行中/部分完成 · P2 · installed/live：逐主题核按钮/command 的背景、边框色与厚度、内外高光、圆角/光泽及 normal/hover/held/disabled/default/keyboard-focus 状态；保留已修 Classic raised/sunken 和 dotted focus，不以基础按钮覆盖声称全 SDK 一致。每次只选有参考的局部与实际输入回归，不统一套现代渐变或改点击区。 证据：ce21f540/2ec2e2e/5bb181c 已交付 shared button、command、Classic 边线和 Aqua gloss 子集。3760f36 公共 disabled checkpoint：修 shared surface/Luna 对既有 aria-disabled=true 和 disabled option 的视觉状态同步，paint 不覆盖 caller opacity；真实 Settings Audio view 的禁用 Classic held 290px、Luna hover276px/held1300px 变化修为0，held→disabled/retheme/reenable保留DOM和focus、selected truth、一次enabled action实测通过；额外caller disabledOpacity0.37保持，不改默认值1或palette。第二批 actual GUI 原证据：120x22四边完整，420x80缺47/47/5/5点，500x96缺87/87/13/13点；当时因缺owner关联而延期，未交不完整Canvas，该历史proof保留。后续父按已授权端到端任务自主选择最小generic document.defaultView+window.observeState（不冒称用户点击API选项），重编真实C runner并完成只读/foreign-context反查/关闭null/GC及业务callback重赋、隔离snapshot、dispatch中增删/close/异常report兼容。现Classic普通focus以JS Canvas复用2x2 repeat、每边独立相位，任务focus相位未改；800x600/scale1实际420x80、500x96四完整边missing均0，120x22原整块2640px crop差0，无resize/mask。真实Win32 child纯hostresize 420x180→640x290，无VNode更新/forced render，两次有界rAF跨layout后backing634x284及presented PNG四边on/off错误全0，后写业务onstatechange仍工作；disable/reenable/retheme、calleropacity0.37、selection/focus与单次activation保持。1.25仅私有WM_DPICHANGED adapter/backing边界，不是monitor DPI认证。Linux exact cached SDK共享C增量编译+SDL-dummy生命周期通过，不当作compositor/GPU证据。tests/classic-focus-render.mjs与gui/tests/window-owner-state*覆盖此缺口。后续830256f合64efd18增加独立opt-in defaultAction：button保原6参+第7严格options，desktopCommand原命名参数同boolean；Classic外outline与原bevel绘制内移、其它现accent边，disabled抑cue，default不污染selected/aria-pressed。不换face/label、不动box/padding/原Canvas祖先与phase、calleropacity或输入/权限/routing，仅现display Keep和Files-confirm两flag。按用户减测规则不增App样式fixture/矩阵/receipt，只复用theme-alignment小shared类型/真假态契约与common-button既有入口；父原100项及该入口opt-out/opt-in均通过，原DOM/selected/caller0.73和0.61/primary/repeat/held/retheme/cancel/focus保持。不是全OS default-key/focus迁移/pulse行为或完整SDK/原图资格，E22.7仍partial；其它选择控件/输入滚动条/面板的已交付进展见E22.8-.10，不再列为全未实现。
- [ ] **E22.8 选择控件与页签覆盖** · 已延期 / 进行中/部分完成 · P2 · installed/live：逐项核 checkbox、radio、switch、select、tab 和列表 selection 的主题外观及 disabled/focus/checked 状态，先区分现有共享控件与 App 自定义控件。没有真实控件/reference 的项标未覆盖，不从 button painter 推断已经一致；不强制第三方 App/CSD 跟随。 证据：2026-10-16 合入99ab885（源91b53df/aec417f7/ff1b295e）：SDK switch/checkbox/radio/tabs/select/menu六类实接role/checked/disabled、paint-only可见focus、primary pointer、受控值及roving键盘；Select沿既有NOverlayHost/openPopup，动态options/value/disabled/latestcallback、关闭/替换/焦点恢复和长列表实际可用。父review另实证mapped四类按住A后删除/重排会在同NativeNode误emit B，现SDK局部gesture identity令八case均无误触；不改globalreconciler/key。另一真实host-only640x500→640x80原popup仍240高越界，现open期间用既有owner.observeState，收为18高/bottom76，grow恢复，每次四个有界rAF、close订阅1→0/后续frames0。父实际basic30、controls49、gesture组及既有naive四组54项通过，真Win32子窗口resize/cleanup通过；原light/dark静态全图bytes/七box保持。仅SDK light/dark功能合同，不是六OS精确glyph/art、所有App bespoke选择控件或native accessibility provider资格，E22.8保持partial。后续a09fe602/88b78aee/e68d964合dd0f873/919e48c/1fabe25，补齐六factory严格per-instance appearance和唯一desktop六theme adapter；真palette/metrics/hover/press/cancel/disabled/focus/checked/selected、sameDOM局部retheme与其他instance/global隔离，旧无appearance light/dark全PNG byte-exact。Classic被动part bevel独占外边、radio圆框保留、default metrics冻结。Displays真checkbox Space只改draft，busy禁用，one Apply保serial7及15秒确认；Audio真switch保generation/revision/instance，未ack不改checked/持久化，ack一次save；共用panel card。父actual六theme sheet/边/focus/Settings、host500→80 Select240→22/grow及八GC均通过。64fea7e合319a315补quiet commands和桌面selected caption/原单色glyph的selectionText，保缺token旧行为、bitmap和普通nonquiet face；父Node49及actual六theme/custom/missing/state通过。ffd3801合899a7fe再接真实Files row，同一个inkOnly painter按semantic part消费name/三metadata/原创glyph并在textbox停止；hover/selected白字、custom同DOM/focus、missing各原text/muted/目录色、leave整row逐pixel恢复及原rename/create各一次父actual通过，Node80；columns/42px/selection generation/原action guards/所有已冻panel不变，Source tree713ca42f与子final精确相同。其它bespoke/原图资格继续；software GUI/有界domain fixture不冒硬件变化、native accessibility或六OS原图认证。
- [ ] **E22.9 输入框光标与滚动条** · 已延期 / 进行中/部分完成 · P2 · installed/live：逐主题登记文本框内凹/边框、padding、caret、selection 色和默认滚动条/滑块/箭头的可见差异；Files、Processes及长Shell菜单已消费同一SDK scrollbar controller和主题adapter，未覆盖consumer与原OS精确资格仍分别核。保留输入内容、selection、IME、捕获和键盘焦点；未测默认和bespoke路线不能合并标绿。 证据：历史displayField新建/复用已统一setAppearance，Classic/Modern首帧与repaint原238/236px差修0，value1920/selection[0,4]/caret/focus、编辑2560与一次Apply保持；该历史批次未改SDK默认。2026-10-16 4281df3再统一Settings显示/凭据、Files、chooser及workspace完整inputAppearance，补漏focusColor/字号/radius；Files fallback NInput新fontSize8..64与测量/caret/IME同源，不仅改文字CSS。31044cd新增可选SDK selectionTextColor与schema1 optional RGB colors.selectionText（missing映射原text），仅Classic/Tiger/Lion数据白字，其他原text，highlight背景不改。共享35行DOM full-string clip painter取真实textGeometry ranges，先覆盖原AA再同nativeDOM完整串着色；不slice/不Canvasoutline，所以真实colorbitmapemoji不丢，decorations aria-hidden/pointer-none、API.value/原textNode仍权威，password仅mask、preedit抑制副本。父实际Latin/combining/emoji188彩色像素/mixedtext full/partial选区误差0、blur0差、sameDOM/selection/IME及真实consumeredit/rename/choose/auth各一次通过；Winrunner无layoutText，mixed只同renderer一致，不冒ICU/bidi认证。选区Node/file/catalog/override及combined127/127通过；深色token白glyph0→187，XP187保持，旧未optin默认wholePNG bytes原样。后续c2bc506/fc8fcc7/ebcabe9/2b079c7合a01c202/daa0eec/635cb64，补唯一SDK vertical scrollbar实例appearance+desktop adapter，并真实接Files overlay10，不改list/42px rows/columns/selected ink。full默认四代表skin轨道15/15/18/17，overlay显式10、unknown variant拒绝；arrows/page/42step/wheel/keys/drag/capture/cancel均同controller，无App箭头事件或新timer/RAF/订阅。父review真实red→green：lane origin无动drag/up及captured retheme/resize保value，中段delta/travel严格映射；拒绝初始化schema/paint/decorate回滚listeners/parts/style/ARIA、原错重抛/坏cleanup明确log、同track重建一步一次；surfaceOpacity.37/.6与fit0分离；内部bounds变化刷新原Classic/Luna focus，20次不变update无callback/style/attrs写。父Node44及实际800×600/640×480四skin Files通过，12.1KiB Size crop显隐0差且与unclipped完整native DOM串逐像素同，retained sort/refresh同DOM/hover/focus、原generation取消held。旧SDKnormal/end/drag全PNG父核fullSHA精确3019aa645cba78b2daf9c75e35cd1ee1911b0ecc6b049b9d93feb192719c47dc/561e586ed3a3e4ac46366175abaebd21c874ee69fca6889a56e4efa8de9490ef/3af1e97b87edd196c5e79783a59f2b08fd683984a422121c156333379e7322f6；子八帧rail外RGBA全0差。仅软件GUI/event/capture配memory FS，native scrollTop按既有六有效位表示严格比较、Node数学exact，无C改动；其它Apps/global默认推广、精确历史arrow布局、物理/WM输入和OS原图资格仍独立未完成，E22.9保持partial。
- [ ] **E22.10 对话框与面板一致性** · 已延期 / 进行中/部分完成 · P2 · installed/live：分别核 Settings 六页、打开/保存、确认/错误/认证小面板的背景、边线、留白、标题和按钮布局，标明窗口内部模板与系统窗饰边界。仅处理已存在的界面，不制造 Windows/Mac 未实现业务入口；保留密码遮罩、值/selection/focus 及 trusted confirmation 权限。 证据：用户原问题包括控件背景/边框/字体；独立Settings功能已完成。后续f09d49f/9300761冻结唯一被动panelAppearance/panelDetail，父合abe1304；card/dialog/menu/inset取原theme token，无presetID/RGB启发式或controller/订阅。Classic border0、原border inset转padding，默认1/custom2实际四边均正确。e68d964合1fabe25令settingsCard和Audio/Displays card消费；b22ae560合62a2413接Files modal/context/breadcrumb、opt-in chooser及Settings Appearance/Keyboard；b9b2bc5合2b17a28令新application-window chooser也消费同menu策略。父Node73及Win800×600/640×480四代表theme真实Files create各一次、context stale callback拒绝、move/link取消、MIME literal长path一次、chooser一次result/旧callback拒绝、输入同DOM/focus/selection及Settings卡片/Tab通过；neutral整PNG精确SHA8928e179f46fc61c97ae490b65a195589656643fd55afe6ab00161e66d832f85保持。长token不伪称wrap：只读rawchild配既有横轴scrollDesktop，wheel/Left/Right/Home/End和实际focus-border像素确认完整可达，普通文案仍wrap；不改API值或JS分字。仅紧耦合actionrow回收时显式归零scrollLeft。子同版Linux complex-text runtime SHA41ebe883实际markers/边/消费者通过。后续1bc2683/0a32154合35391f0/71a4a96，将既有Wi-Fi credential/confirmation/network cards、display confirmation和logout view接同helper/shared button/typography；embedded Settings根不套第二frame。Network真实窄420字段right428越界，现100%/max420及bounded root使fieldright403，保原promptID/kind contentMode清secret/重建、sameNative username/password mask/caret/selection/focus与live status稳定slots，旧callback不能送新prompt。Display token/15秒/revert及logoutinventory/wait/seal/显式finalcommit/cancel均未改，repeat Enter不再重复action。父新增真实260×90 scroll14带走Classic底边red后，唯一弱panel-viewport保outer不滚/inner滚，wheel前后四边精确body/#404；300×180网络Tab密码及directFocus取消可见、300×130退出同样固定四边。focus/Tab共享最多2one-shot跨layout读取当前实际activeElement、leave取消帧和弱listeners、不夺旧target或undo手动scroll、无poll/idle循环。父combined Node120与原业务/新固定frame actual全部通过；不会发送真实凭据/改变网络、显示或终止会话。autoheight networkentry bottom part相对声明bounds既有1px舍入独立披露，不改冻结helper/C或假称pixelperfect。617c0e4合6c19891再将group menu被动detail置末，修实际Classic↔Modern丢close11 DOM/focus，原window action仍一次。c73ddf1合b63ae05复用同viewport的content sizing/horizontal axis修真实Files长OpenWith/低高context/横向breadcrumb：800×600 outer均0而inner380/55/434、四边wheel前后精确不变；640×480同样无scroll新增丢边。短create天然118/119与原exact，保caller top18%/max78%，不塌到padding或填满max；最后真实MIMEhandler Enter1launch、旧generation拒绝、path不导航、原input DOM/parent/value/caret/selection/focus、inlineRename无frame及所有protected rows/42px/cols/newbar/appbind/controller原样。父新Node39/cleanup后35与两尺寸四theme原consumerworkflow、fixed3root defaults及neutral wholeSHA再次通过。640百分比max374.4测375时初始insidebottom为body，精确71a4旧view实证本已如此；只修scroll导致右边也丢的回归，不掩static rounding、不改C。证据仍是production views/controllers和software GUI dispatcher配memory FS/domain fixture，不是用户真实FS、物理输入、所有Apps或原OS像素认证；E22.10保持partial。
- [ ] **Bug：小数布局边线偏移（非阻塞）** · 已延期 / 待实现 · P2 · installed/live：独立处理泛型布局的fractional/autoheight边界：absolute底/右边线与父声明bounds相差1px或被clip。低频、不影响当前常用UI主流程；修复耗时不阻塞其它E22交付，不靠App补像素、改reportedbbox或禁cache掩盖。 证据：integer几何正常，640×480 maxHeight78%=374.4报告375时insidebottom为body，autoheight bottom part亦可落在parent.bottom。原始baseline已独立复现，非JS viewport修复新增。Yoga局部round与absolute尺寸基准、深层cached rounded被当raw是已定位边界；本地38b9a01+a0c7585及独立Win/Linux输出已保留，但父最终review/主线集成暂停，均未合入或发布。依用户要求作为非阻塞Bug停放，主线继续可见图标/字号等修复；后续须同时保证paint/clip、fresh/cache和旧整数语义，不单收38b。
- [ ] **原生预设效果复验（环境受阻）** · 已延期 / 待授权/待决策 · P2 · installed/live：在已有匹配effects ABI2/private6运行栈恢复可用后，复验当前预设圆角/阴影采用及生产GUI-strip到合成器接缝。与已冻结共享机制资格、纯JS数据/数值编译/producer检查分开；不以入口exit0或Windows软件GUI替代wlroots/物理GPU。 证据：本次只读main0c39dca的WSL enterns尝试退出0但未出现容器首marker，scene/caption命令未实际执行，也未续核runtime hash。限定只读诊断确认WSL直接cat可用、enterns只有检测到特定systemd PID且非1才转发argv，无else可空成功；条件核验/proc/1/comm实为init(podman-mac，guard给NAMESPACE_NOT_READY/exit86，未执行podman或两验证命令。已停止后续路线/构建/安装/机器或服务修改。历史62a9545-runtime Pixman/一次coverage及软件GLSL资格保持原范围。当前38fca16/29a338f的明确预设数据和Node数值编译、既有生产caption producer/缺字段none字节检查通过，不冒称新的live WM/GPU/default-preset全景验收；日志在f864 session effects-limited-validation-20261016-1740、enterns-readonly-diagnostic-20261016-1814.log、effects-namespace-final-20261016-1817.log。
- [ ] **E22.11 原生状态与缩放对照** · 已延期 / 待授权/待决策 · P2 · installed/live：按选中主题/部件而非默认全矩阵，验证真实 compositor 下 active/inactive、hover/press/cancel、maximize/restore、低高/窄屏、受支持 DPI 的几何/颜色和命中；同版同状态比较，未支持 native disabled/focus 明列。组件离屏图、默认主题预览和旧 ISO 不作新完整桌面等价证明。 证据：既有组件及native四strip/真实pointer回归覆盖有限状态，Classic菜单DOMfixture与真实layer的28px差异已修。当前paired compositor运行入口最后只读条件核验为PID1 init(podman-mac/guard86，未执行新验证；恢复machine/service已明确询问但无具体授权，故不重启、不换路线或重建SDK。另缺同版本/缩放的原OS状态包；软件透明frame、组件预览、GLSL原语及旧ISO不能回填六主题/DPI/fullscene资格。
- [ ] **E22.12 XP 标题栏材质与状态** · 已延期 / 进行中/部分完成 · P2 · installed/live：核 XP caption 多段蓝色渐变、边缘/高光、文字阴影及三键/还原图形在激活/非激活/hover/press 的原生结果；30px/21px 基础几何保留，未实现的 disabled caption/键盘语义先记录机制边界。迁至公共 JS painter 后须比实际输出，不恢复 C Luna 专用绘制。 证据：XP-LUNA.md 的 multi-band/outline/text-shadow 为历史基础批。2026-10-15 恢复迁至 GUI 时遗漏的 active Luna caption text-shadow：沿用 5bb181c^ 已删除 C draw_text 的当前文字色混黑70%，以现 Canvas scale 绘制1 logical px右下偏移，共用ellipsis/metrics/baseline/text clip；不复刻旧C fractional ceil或inactive shadow。真实GUI raster before/after：active 348px、long ellipsis 57px、1.25x 456px改变，inactive/空标题/无文字空间及非Luna五preset hash保持；像素与独立两遍文字合成相同，侧strip不变。caption三键/命中/几何及palette未改。证据为actual GUI component而非native compositor输入或XP SP3 raw oracle，字体/全状态/reference crops仍缺，E22.12保持partial；历史C strip分数不是当前完整标题栏认证。
- [ ] **E22.13 XP 任务栏与 Start** · 已延期 / 进行中/部分完成 · P2 · installed/live：分项核30px bar、绿色Start/Polly launcher、任务按钮与托盘/clock；XP显式windows-launchers已交真实Quick Launch，saved catalog pins独立启动且原Window.id任务不分组，Start复用真实Programs/metadata Categories。profile/header、分隔线/字体/外部SNI与原图状态仍待资格，不加假账号/历史或声称导入外部XP目录。 证据：2026-10-15 XP现有taskbar/Start表面批：修Luna launcher硬码97未消费现layout.launcherWidth，合法123 override实际布局/命中生效而默认不变；XP双列右links复用scrollDesktop/minHeight0与局部chain onFocus、verticalScrollMetrics clamp，低高Settings/Refresh/Close不再裁失，不扩SDK机制或改Classic。实际GUI800x600量测bar30/launcher97/tasks26、tray30/menu380x480/header64/footer42，default before/after PNG SHA相同；360x260局部布局menu206/links100，Close原bottom208越过footer188，修后wheel/focus scroll20完整显示，末项pointer/Enter各单次，重复focus不抖、反向wheel归零。左右列独立scroll且header/footer不动；Search/Pin/disabled app/launcher hover-held-cancel/任务focus及窄条滚动激活保留。THEMES有界表区分现有合同/已修缺陷/待参考/缺业务；源色/字体/其它五preset路径未改。原XP字体/认证SP3-DPI raw、Start account/profile/Programs级联、完整QuickLaunch与tray外部状态仍缺；更低于固定header/footer/Search总高的布局策略未选。本证据为actual GUI component，不冒充native resize/OS精确误差，E22.13保持partial。
- [ ] **E22.14 Classic 残余颜色差** · 已延期 / 进行中/部分完成 · P2 · installed/live：继续追踪 Classic frame/menu/taskbar 仍非零的原尺寸 raw RGB 差异，区分真正 paint 差异、JPEG 链路与疑似 RGB565 量化，不把标准 24bit palette 整体改成参考截图色。只对可证实的局部原因修正；正文/图标/字体差异分别归共享任务。 证据：2ec 边框 raw 误差明显降低但非零；后续实际 native controls 700px 对 JPEG 的 MAE 5.119047619/RMSE 7.576593028，仅 3px exact，不是全 OS 分数。原 88px plain frame crop=0 不能覆盖其它边框/文字。
- [ ] **E22.15 Classic 菜单与级联** · 已延期 / 进行中/部分完成 · P2 · installed/live：区分已完成灰色双列 chrome、默认 flat All Programs 及真实metadata辅助分类，与仍缺的安装目录多级菜单、profile/account 区、分组/列表内容密度及原OS图标资格；保留单列 override、现有可用搜索/Pin/日志入口。内容和布局使用真实后端，不为了像素接近删除功能或添加假的系统管理/打印/Run/Shutdown。 证据：真实 Win2K3 Start-open JPEG 与实际 Polly 菜单的完整profile/内容行差异仍未认证。2026-10-16 合入f20c38b（源73f5ce24）：Classic现有RootMenu内增加真实desktopCatalog的flat All Programs，保默认双列/legacy单列及原Search/Pin/Files/Settings/Refresh/Close/logout；右贴或同client覆盖，Back/Left/Escape恢复trigger，键盘/wheel/focus可达长列表。每次open稳定行槽避免positional reconciler把held行变另一app，epoch/currentMenu/livecatalog拒绝旧launch/Pin/延迟focus，clock/retheme保状态。父Node35/35、真实GUI384x480/260x180/legacy180x140通过；真nativechild submenu分别[197,3,184,474]与[3,29,174,108]完全在client输入document内，末行focus完整可见。没有增加surface/native权限或放松RootMenu outside/lock合同，但此Win32client边界不是Linuxcompositor outside-dismiss认证。categories非目录path，不造多级目录/Accounts/Recent后端；极小viewport只最大可见，不冒完整fit。E22.15保持partial。
- [x] **E22.16 已修 Classic 边线** · 已完成 · P2 · installed/live：保留已完成 Classic raised/sunken 分层、menu 三层外框/双线 separator，以及移除覆盖 bevel 的通用 outline；这是明确缺陷修复记录，不宣称全部 RGB 或文本一致。 证据：0838bee 集成 2ec2e2e：外四边同灰的 root cause 为重复 borderWidth 覆盖，已移除；正常边序 FFF/D4/808/404、按下404/808/D4/FFF 实测，menu frame/separator 与 raw crop 记录保留。
- [x] **E22.17 已修 Classic 任务质感** · 已完成 · P2 · installed/live：保留 flat hover/press 基底、选中 2x2 body/light stipple、1px dotted focus、22px task/16px icon、内留白和按下1px偏移的已完成修正；纹理不拥有输入，不回退到大量 DOM 点阵。 证据：0838bee 修交互重加 gradient；5bb181c 实际 GUI 验棋盘8白/8body、hover/press、selected->inactive、palette/retheme、同button/focus/单次click。Task28bar/22slot 上4下2含2px chrome，对应内部2/2；不再当未实现重复派发。
- [x] **E22.18 已修 Classic 标题三键** · 已完成 · P2 · installed/live：保留 Win2K3 测量所得三键 glyph 尺寸/偏移与按可用文字区域绘制渐变的完成记录；窗框4px/caption23px/box16x14不变，外观在 JS 绘制、WM保留命中和操作。 证据：5bb181c/776d868：实际 GUI min bbox[4,9,6,2]/12点、max[3,2,9,9]/39点、close[4,3,8,7]/26点及press偏移1通过；原 JPEG 跨阈值测量与 native 四strip证据保留，不覆盖所有字体/restore状态认证。
- [x] **E22.19 已修菜单任务栏间隙** · 已完成 · P2 · installed/live：保留真实 layer 菜单错误多扣28px任务栏的完成修正；openMenu明确full-output坐标，保持preferred尺寸、left2和4px边框衔接，不改全局layer默认/其它预设。 证据：6618394 的 zone-1 已经真实 native committed menu[2,252,380,444]/bar[0,692,1280,28]断言4px overlap、search/focus/Escape与top-Dock helper；修正版b7e7a700 ISO已包含，不再把组件图位置当原生布局证明。
- [x] **E22.20 已修菜单外标题操作** · 已完成 · P2 · installed/live：将开始菜单展开后标题三键不响应的已修复交互与视觉差异分开；跟踪既有可信菜单外点关闭任务，不另起一套native input策略。 前置：T21.5。 证据：6298ff3 实测菜单关闭时三键原本正常；菜单开启时exclusive焦点拦截已由受限Shell-menu生命周期修复。真实max/min/close、单次route、drag-off取消、non-menu exclusive保护通过。权威功能任务为menu-native-dismiss，此处仅历史差异索引。
- [ ] **E22.21 Win11 标题栏状态** · 已延期 / 进行中/部分完成 · P2 · installed/live：按 Windows11 24H2 light 核 32px caption内容/33px外框、46x32三键、close红色hover/press与其它backplate/图形、active/inactive及文字基线；当前矩形paint/hitbox已实现但build-tagged raw状态对照不足。Snap flyout尚未实现，作为功能差异说明，不伪装成已有标题按钮效果。 证据：ce21f540/882f9182与公共GUI窗饰已交付rect controls。2026-10-15 恢复GUI迁移遗漏的Fluent inactive glyph着色：沿用5bb181c^旧C语义消费现window.inactiveText（catalog #999999，而非active controlText #1a1a1a），close hover/held白色优先级保留。真实GUI组件before/after：inactive normal/max/min hover或held各90px改变、close hover/held仅另两键70px、restore121px、1.25x200px；close hover本键、其它区域/侧strip、8个active状态、窄窗和非Fluent五preset hash不变；custom inactive色也实际生效。未改backplate/palette/font/三键geometry/native input，保留Luna shadow/Classic已验路径。E22.21仍partial；alignment-reference.json数值是重建目标而非build-tagged24H2 raw测量，本组件证据不认证OS-exact/Snap或native输入，Modern目标不是Win10。
- [ ] **E22.22 Win11 任务栏与 Start** · 已延期 / 进行中/部分完成 · P2 · installed/live：分别核居中48px任务栏、44pxslot/24pxicon、运行/激活标记与tray/clock间距；Start的640x660搜索/网格/footer、圆角和内容留白按真实可用App核对。确切appId分组与独立持久固定已交付；推荐历史/account完整业务等剩余差异关联既有T21任务，不造假推荐/不可用入口。 证据：2026-10-15 Fluent task首次与事件共用局部task variant，active沿button.from/inactive透明、hover沿selection/held沿button.to，恢复paint-only focus并保留16/6标记、aria及pointer/Enter/context单次；retained clock保hover/held/focus。800默认group x280/240不变；360/260为x12/226与x12/126，实测tray x242/142无重叠，双层wheel/focus使fixed入口和末task可点，实有tray及launcher60/task52亦通过。后续fa3316f修首次未attach时漏订owner：真实host-only240→680→240→680恰3帧重排，业务onstatechange后写仍有效，leave取消1帧，closed panel/doc/window八轮GC均释放。初批发现180menu body0/list16/footer越界，a2b496c独立修为整menu纵向滚动：保80app/20Pin/fonts/Search/footer与preferredheight，body/list118、outermax146，app/Pin与Search/Refresh/Close/logout真实pointer/Enter、Tab跳disabled、内外wheel/clamp及retained grow/filter通过；小于80的root仅最大可见，不缩控件。首次layout前search.focus的40px root也正确scroll16完整露32px。正常640x580整图bytes不变，无不变clock抢回手动scroll；两帧布局同步/leave取消，无新observer或poll。tests/fluent-shell-surface-render.mjs为有界组件与独立native owner证据，不作24H2 OSexact/完整原生popup认证；palette/font/caption和其它preset保留，recommendation/account/Appgroup、Mica/corner/shadow仍缺，保持partial。后续c98628d/f57d958合31b7236已补Appgroup：exact nonempty appId共通windowTasks、Modern taskbar与真实RootMenu chooser，同缓存count供render/width，空appId保Window.id、legacy原序。stable slots/gesture/action identity及live workspace/member/output guards拒绝held错义与未通知变化，bounded2frame/leavecancel不抢手动scroll。父Node50及actual Modern/BigSur、XPnegative、6window→4task、pointer/keys/held/retheme和真实native client bounds通过；b9b2bc5合2b17a28接同被动menu policy，44px短list中24px末command可达。非空appId fixture snapshots配真GUI/child几何，不冒全WM枚举/MRU/native popup/outside-dismiss/物理DPI或24H2原图；固定、recommendation/account仍缺，原生效果后续见E13/E22.23，保持partial。
- [ ] **E22.23 Win11 内容圆角阴影** · 已延期 / 进行中/部分完成 · P2 · installed/live：登记真实Win11整窗内容圆角裁剪、外阴影和输入边界差异；复用E13共享原生clip/shadow机制，不在themeJS伪造透明遮角或复制另一渲染器。共享能力交付与Win11实际样式启用/原图资格分开，视觉变化须验证内容和命中合同。 证据：此前只有标题顶角，preview shadow不是原生能力。2026-10-16 共享E13已合6b9f0e9/4603005/1f670dd（源0393719/b531ff6/62a9545）：显式window.nativeEffects=rounded或rounded-shadow，真实client+frame/subsurface先离屏复合再一次AAcoverage，GUI opt-in标题不重复预裁外角；默认missing/none不变，max/full/CSD不启用，输入保矩形。外shadow为非input/非opaque兄弟节点，JS决定RGB/百分比alpha/sigma/offset，C只generic数值合成、不读themeJSON。固定wlroots0.19.3-polly-effects2/ABI2/patch9395ed69及private6/schema6成套严格校验，旧库/旧wire明确拒绝。父实际Pixmanchecker/重叠alpha/crop/buffer与outputrotation/四scale、phase move/occlusion-reveal/cache/budget、真实GUI topcorner单coverage54/60/max方角0/defaultnone bytes保持、生产v6daemon无Shell冷启动/正常退出恢复及Node38/144通过。软件llvmpipe真实GLSL 2048/4096/8192原语像素通过，但不是完整WM GLES/DRM/硬件资格。能力不自动改变Modern默认主题，也不声称Win11原图阴影/圆角像素一致；默认样式采用、原图/物理设备/输入形状资格仍待完成，本项保持partial，不重复另起Win11原生writer。
- [ ] **E22.24 Win11 背景材质** · 已延期 / 进行中/部分完成 · P2 · installed/live：登记Win11 Mica-like壁纸基色与Start/taskbar Acrylic背景采样的质感差异；当前opaque/gradient不能代替真实backdrop。分别关联已存在MT-02/MT-03候选，先选具体效果/机制再实现，保留solid/reduced-transparency方案；本次登记不自动授权blur/GPU新功能。 证据：普通窗口alpha已交付但不是backgroundblur。2026-10-16 用户要求自主完成剩余后，合入d94a94a（源f1085d9b）的有界MT02子集：通用Canvas filter none/singleblur(px)，JS-owned真实wallpaper/theme派生opaque客户端base，source/blur/tint缓存、padding预算、activation/size/scale/sourceRevision失效、错误显式并可主动恢复solid。仅opt-in desktop/examples/material.mjs，不强改Settings/Files/主题或nativecaption；纹理跨client映射而非desktop-position对齐。父Node8/8和精确新C runner实际raster+真实GUI owner cleanup通过；中点[226,199,228,255]证实真Gaussian，全部alpha255，八次无变重绘work counters不变，前景sharp。SDK/native脚本同CMake内嵌构建，旧C runner不用于新filter资格。不是Windows DWM Mica、liveAcrylic或MT03；默认App/Start/taskbar材质、retainedDOM背景采样、跨App合成与OS像素资格仍未完成，E22.24保持partial。
- [ ] **E22.25 Tiger 窗框与菜单栏** · 已延期 / 进行中/部分完成 · P2 · installed/live：按OSX10.4核标题光泽/pinstripe、traffic-light三键顺序/间距/hoverglyph、active/inactive及22px菜单栏字体/背景/项目间距。记录当前绘制近似与尚无完整raw状态对照的区别；无真App菜单时不伪造OS功能，Lucida字体差异归共享任务。 证据：现有Aqua/genericcaption与菜单栏路线已具；2026-10-15第二批actual Windows raster GUI证实默认Tiger菜单项显式radius0被输入state painter改为普通按钮radius8；局部menuTheme radius0供factory/events一致消费，hover/leave/focus/press/click/reconcile/blur保留直角，普通按钮仍8，菜单单击一次激活。独立followup实证每次重建clone派生theme使hover/held后focus/release丢高亮（Tiger/customLion846、customBigSur936像素）；按原immutabletheme用局部WeakMap复用派生对象修复，重建保留DOM和hover/held，真正换theme自然重置状态并用新palette。默认Lion/BigSur为generic路径无此默认bug；合法Aqua painter override在3/5半径复现并修复。仅currentdesign override一致性，不称OS rawhighlight或Darwin/nativeMac认证；字体/标题/真实参考及其它差异仍partial。
- [ ] **E22.26 Tiger Dock 边缘指示** · 已延期 / 进行中/部分完成 · P2 · installed/live：按明确48px图标/关闭magnification的参考设置核Tiger二维rim、54pxslot/62px高度、底部贴合、separator与7x4黑三角运行指示；不得误套Leopard/Lion3D shelf。溢出滚动已修不重开，未测几何先取得同配置原尺寸参考。 证据：已有tiger painter和triangle指标、固定三action/窗口scroll；2026-10-15首增量修复合法dockIndicatorSize=2..12时固定7px行造成的偏心/越界，四行采用对称整数inset，默认7px全图before/after像素hash均3475878074。actual Windows raster GUI另实证第四行被底部rim裁掉；独立followup仅Tiger indicator bottom=0→1，默认完整显示1/3/5/7四行、两窗口400x100图有意增加14个黑色像素，不改rim/高度/slot。7/2/12可见像素/边界/中心、active/minimized running与窄Dock scroll/click/focus保持验证；非Tiger结构未变。仅currentgeometry/configuration contract修正，不是OS rawfidelity或Darwin/nativeMac验收。alignment-reference明确Dock尺寸可配，当前数值不是任意Tiger用户默认保证；E22.26仍partial。
- [ ] **E22.27 Tiger Dock 透明质感** · 已延期 / 进行中/部分完成 · P2 · installed/live：Tiger Dock已通过既有透明layer采用真实底材alpha，前景和几何不变；继续核二维玻璃rim的原OS样式与真实合成输出，不把alpha混合称为背景blur。维持图标/文字对比度，缺可靠参考不补造倒影，也不从Lion效果套用Tiger。 证据：历史aqua gaps中的opaque近似缺口已推进：da63fdd隔离挑入fff78bf，三Mac原透明layer只passive材质RGBA，materialOpacityPercent可0..100/缺100，builtin88非OS实测值。现软件透明frame测100/88/0 interior alpha255/224/0，旧100与新100PNG全同，所有原opaque前景ARGB及实际boxes不变；原Dock输入入口通过。原OS玻璃rim/参考与当前Wayland输出资格仍缺，alpha不称blur/倒影/物理DPI。
- [ ] **E22.28 Lion 窗框与菜单栏** · 已延期 / 进行中/部分完成 · P2 · installed/live：按OSX10.7核灰色窗框材质、traffic-light外形/间距/状态、标题文字与22px菜单栏的颜色/边线/内距；区分genericcaption已有子集与真实Lion对照缺失。窗口内部unifiedtoolbar为preview含义，不当作已统一所有App toolbar。 证据：现有Lion preset/genericcaption和menu-bar已具；无完整授权rawpixeloracle，THEMES明确unifiedToolbar不代表nativeclient内容改造。
- [ ] **E22.29 Lion Dock 透视与光点** · 已延期 / 进行中/部分完成 · P2 · installed/live：核Lion perspective shelf轮廓、56pxslot/66px高度、底部位置、separator与8x3luminous运行指示的几何/颜色；固定48pxicon与关闭放大作为本地比较条件，不硬编码为不可配置系统默认。恢复/最小化仍是running，indicator不能消失。 证据：2026-10-15 Lion Dock有界surface核验：actual Windows raster GUI证明既有panel.from/to合法override前整图0变化，原因shelf主面/front硬码；将两层接既有字段，默认值恰等旧色，default400x120 PNG逐字节不变；custom#804020/#204080仅主面与front所在行4334px变化（含灯边缘与front正常alpha混合），中性#EEE/#999层不染色。24透视row+4pxfront、默认317x66/56pxslot及一组合法289x74/48pxslot/12x3灯几何验证；active/minimized仍running、实际hover/held/focus/sameDOM/singleclick、fixed3actions、窄stripscroll1059/最后minimizedclick与focusreveal均保持。仅currentdesign字段消费，不称OSraw或Darwin/nativeMac验收。相同设置授权rawreference/真实玻璃阴影反射/Appgroup等仍缺，E22.29保持partial。
- [ ] **E22.30 Lion 玻璃与倒影** · 已延期 / 进行中/部分完成 · P2 · installed/live：Lion Dock已采用真实底材alpha；背景玻璃blur、Dock外阴影及真实icon/windowreflection仍缺，当前透视色带不是reflection。复用共享E13/材质机制，不能靠复制图标倒影贴图或虚构窗口图像冒充实时效果；普通浮窗shadow不代替Dock效果。 证据：历史Lion gaps记录actualicon/windowreflection、glass/shadow缺失。da63fdd隔离合fff78bf现让24行shelf及4pxfront/border真实材质alpha，不淡化前景/registeredbitmap，配置缺100逐byte兼容；软件transparentframe alpha/ARGB/boxes及旧GUI入口通过。没有behind-scene blur、真实reflection或Dock外shadow，普通浮窗rounded-shadow不能代替这些；参考/当前Wayland资格仍保留。
- [ ] **E22.31 Big Sur 窗框菜单栏** · 已延期 / 进行中/部分完成 · P2 · installed/live：按macOS11light核28pxcaption、traffic-light12px控件/间距/hoverglyph、active/inactive、统一工具栏视觉边界及24px菜单栏。SanFrancisco度量归共享字体项，真实App内容与纯窗饰分开，不用标题圆角代替全窗裁剪。 证据：BigSur light preset/公共GUIcaption已具；2026-10-15有界caption actual Windows raster GUI核验未发现确定产品缺陷，未改painter/preset。默认12px圆control及close/min/max左序、active/inactive/三hover/validheld+hover、现有整组glyphhover与inactiveOpacity/ink消费通过；合法16pxcontrol/34pxtitle、宽1/20/44/64/300、empty/long textclip、1.25backingceil、5otherpreset前后strip bytes guards通过。元数据fixture镜像现geometry合同，不冒nativehit/input或OSraw验收。旧C5bb181c^逐键glyphhover与现JS整组存在priorart分歧，保留现行为待同版本授权rawstate参考/决定；exactcolors/font/art/nativeMac/Metal、vibrancy/shadow和统一clienttoolbar仍未认证/缺机制，E22.31保持partial。
- [ ] **E22.32 Big Sur 浮动 Dock** · 已延期 / 进行中/部分完成 · P2 · installed/live：核浮动圆角Dock的rim/radius、58pxslot/70px高度、9px底距、内容分隔线和4x4深色运行点；对照固定48pxicon/magnificationoff参考，保留缩放与窄屏可达性。仅原生菜单已修的top28margin不能当整Dock位置/材质已验收。 证据：BigSur float/runningdots/scrollablewindowstrip已实现，原始用户意见为Dock整体仍不准；前批修正通用styledDock非空自然宽少算1个gap：三fixed+separator+windowstrip需root4gaps与inner(count-1)gaps。actual400x140中Tiger/Lion/BigSur两窗默认303/317/329→305/319/331，BigSur合法gap12的369→381、末icon裁7px→0且无多余scroll；empty/gap0/已clamp与默认320窄条的末窗click/focus、fixed3及sameDOMheldrelease保持。后续独立iconfitA按现消费者slot高panel-4/paddingBottom8/markerBottom1添加schema组合约束，保留显式16-96尺寸及touch边界，不silent缩放；20case经file/catalog/overrides为13接受7明确RangeError，含height40/icon48、96/defaultslots和marker12半像素相交拒绝。actual560x160核default与48/64/96合法custom及最小16、normal/focus boxes/markerink/held输入，default与窄条相对gapfixed基线bytes不变。再独立修极窄fallback：稳定viewport滚动完整material/controls surface，最小宽取既有helper(count?1:0,Infinity)，不压显式尺寸；actual560x180的304client/gap32/20窗下三Mac内strip由0变54/56/58，surface369/381/391，fixed3及首末窗真click、inner/outerwheel/focus、Lion末端shelf和held均通过。BigSurinner1710/outer87；grow544及empty缩内容清outer0并保活focus，empty80/unequal64与80slots于100/96slot于40为最大可见实测。default320/gap0/gap12/合法icon共31对原图bytes0差异；clamp-1区分client与完整surface。相关三个MacDockfixtures与Node为本地几何/输入合同，不是OSraw误差认证；仍缺完整licensedrawdisplaymetadata、真实材质及nativeMac资格，desktop/menubar参考差异未夹带，保持partial。
- [ ] **E22.33 Big Sur 壁纸染色模糊** · 已延期 / 进行中/部分完成 · P2 · installed/live：BigSur Dock与菜单栏已分别采用真实底材alpha且可各自override100还原solid；wallpaper-tintedvibrancy、区域blur和Dock外阴影仍缺，RGBA混合不是按桌面坐标采样。与MT-02/MT-03/E13关联真实共享机制，不造Mac主题专用renderer；当前目标light，dark不默认为额外前置。 证据：BigSur阅读源启用wallpapertint。da63fdd隔离合fff78bf交Dock底材alpha；9f04f6d隔离合5f17666再交独立menuBarOpacityPercent/默认88与现transparent surface option，缺100逐byte旧spec，0清底不清前景/clock/edge，实际软件透明PNG alpha255/224/0及boxes同原、抽取共用color helper后三Dock全PNG同。面板透明/opaque替换还实证旧子callback可执行，现局部surfaceAction检查running/closed/expectedClose/currentbundle/surface/liveoutput，保失败断言转绿而非删测。未收任何暂停vendor祖先。仍缺按桌面坐标壁纸染色、跨App blur/vibrancy及Dock外shadow；软件alpha不冒当前Wayland、原OS或物理资格，darkvariant非light自动前置。
- [ ] **E22.34 Mac Dock 分组与放大** · 已延期 / 进行中/部分完成 · P2 · installed/live：三MacDock已支持确切appId分组、独立持久固定、菜单Earlier/Later一步排序和固定槽内的有界悬停强调；继续核启动/running标记、最小化窗口、原生/参考资格及完整相邻联动动画。保空appId独立Window.id语义，不把未知身份窗口伪装成应用，不在视觉任务中悄加包管理。 证据：历史882f9182已修窗口区溢出可达性，不重新标Dock所有功能未实现。后续c98628d/f57d958合31b7236：builtin/fallback仅Modern及aqua/lion/bigsur显式optional panel.taskGrouping=applications，strict schema1；共享windowTasks按非空exact native appId分组、准确running/active/minimized/count，空或缺失appId保Window.id，catalog仅exact名称否则真实appId，无PID/title/basename猜测。Dock render/width同缓存task count，原gap/fit/三固定入口/inner-outer scroll保留。Mac单窗activate/restore不minimize，所有多窗primary/context进既有RootMenu真实chooser，逐窗activate/minimize/restore/close，无close-all/launch伪行为。父Node50及真Modern/BigSur GUI、XPnegative、held/workspace/member/operation guards和真实native child bounds通过；子原gap/fit16–96/extreme定向回归green。b9b2bc5合2b17a28使chooser共用panel menu policy，短list/focus/原actions父actual再次通过。只是fixture snapshots配真实软件GUI/child几何，不冒全WM枚举、native MRU、真实macOS/Metal/物理DPI或OS原图；pinning/magnification及其它参考资格仍待做，E22.34保持partial。
- [x] **E22.35 已修 Classic 基础布局** · 已完成 · P2 · installed/live：保留已完成4px frame/23px caption/16x14 button盒、标准蓝色纯桌面及灰色双列Start基础布局；双列是Server2003默认且单列可配置，不能再把Classic配色等同legacy单列。 证据：4bcddf2 集成670491e，用户明确选择双列默认/单列override；actual468px外窗min/max/close盒分别x412/428/446、y6/16x14，标准desktop#3A6EA5。灰双列/blueheader/低高度scroll可达性已实测，当前380x444后续边框修正保留。完整Programs级联/profile/字体/图标仍由独立未完成项跟踪。

#### T11 额外用户生命周期

把数据 UID 夹具提升为真实额外账户/NSS/PAM 生命周期；不误称第二个数值 UID 已能登录。

- [ ] **T11.1 用户创建改密与停用** · 已延期 / 待实现 · P2 · installed：定义并实现额外普通用户的稳定 UID/GID、passwd/shadow/NSS/PAM 与安全停用，服务身份不当用户；账户操作原子且保持独立 HOME。 前置：T04.1、T04.2、T05.1。 来源：M01.3、M01.7。
- [ ] **T11.2 两账户真实认证隔离** · 已延期 / 待实现 · P2 · installed：至少两账户真实认证、创建/改密/会话与 Settings/AppData/Cache/文档/root HOME 隔离，维护后 UID 不漂移。 前置：T11.1、T06.3。 来源：M01.7、M15.10。

#### T12 共享包与全局注册

全机活动版本和普通用户数据隔离；新共享运行不等待整机旧数据迁移或管理员 GUI。

- [ ] **T12.1 共享操作窄授权** · 已延期 / 待实现 · P2 · installed：P0 实现共享 App 安装/替换/全局卸载的窄授权接口，验证真实调用者和操作范围；拒绝任意路径/命令/hooks，不将旧 `polly-app` 整体提权。 前置：T14.6、T04.5。 来源：M04.6。
- [ ] **T12.2 共享包与权威注册** · 已延期 / 待实现 · P2 · installed：将共享代码/资源置于 `Apps/Packages/<PackageHash>`，权威注册/策略置于 `SystemData/Apps`；复用校验/限额/暂存/摘要和版本约束，普通 App 不可写，个人数据身份不变。 前置：T03.3、T05.1、T12.1。 来源：M15.8。
- [ ] **T12.3 共享版本冲突迁移** · 已延期 / 待实现 · P2 · installed：迁移为每 app-id 一个全机活动版本；冲突由管理员显式选择，保留各用户数据/旧版本；暂存/校验/提交/中断恢复，未解决不切换、未知数据不接管，确认前保留旧源。 前置：T10.1、T10.2、T12.2、T12.1。 来源：M15.9。
- [ ] **T12.4 双用户共享隔离** · 已延期 / 待实现 · P2 · installed：至少两用户运行同一共享包且数据隔离；启动器区分 apt/Polly 来源，apt 无第二套安装数据库；全局卸载不等于隐藏个人入口，GC 检查跨用户引用/资源使用，策略检查不冒充执行隔离或沙箱。 前置：T12.2、T11.2。 来源：M15.10。

#### O1 锁屏认证与 TTY

失败保持覆盖；锁定、注销与普通登录分别验收，挂起属于独立 E03。

- [ ] **T14.4 登录策略联合验收** · 已延期 / 待实现 · P2 · installed：验证密码登录和自动登录模式跨重启/维护/恢复保留；注销与锁屏仍有认证，自动登录不冒充加密解锁。 前置：T14.2、T14.8、T15.1、T15.4。 来源：M03.5。 证据：用户将锁屏认证和复测移后期；登录/锁定/迁移/恢复联合复测不阻挡 Alpha 的基本密码登录。
- [ ] **T15.1 锁屏入口与认证** · 已延期 / 待实现 · P2 · installed：接通 Shell 锁屏入口、快捷键及 login1 Lock/Unlock 信号，解锁仅接受有效的 `polly` 认证。 前置：T06.3。 来源：M05.1。
- [ ] **T15.2 空闲锁屏与抑制** · 已延期 / 待实现 · P2 · installed：默认 10 分钟无操作锁屏，提供配置；定义正常输入、活动/抑制请求和失效状态的边界。 前置：T15.1。 来源：M05.2。
- [ ] **T15.3 锁进程恢复** · 已延期 / 待实现 · P2 · installed：接通可信锁进程恢复，验证崩溃、超时、多显示器/热插拔、黑屏覆盖和普通输入隔离。 前置：T15.1。 来源：M05.3。
- [ ] **T15.5 受保护 TTY** · 已延期 / 待实现 · P2 · installed：验证 VT 切换、已存在 TTY 会话和恢复入口，不能经 TTY 绕过锁屏；安全性结论不扩展到有 root 权限的攻击者。 前置：T06.3、T15.1。 来源：M05.5。
- [ ] **T15.6 锁定会话组合** · 已延期 / 待实现 · P2 · installed：确认自动登录、密码修改、锁进程失败及注销重进组合；未闭环前不启用自动挂起。 前置：T15.3、T15.4、T14.8。 来源：M05.6。

#### T23 可移动设备安全操作

独立的设备/会话授权后端和安全移除；不因挂载需求强制先实现全部管理员 UI。

- [ ] **T23.1 设备与会话权限契约** · 已延期 / 待实现 · P2 · installed：选择受限挂载后端并定义真实本地会话、设备来源、排除内盘、挂载/卸载与敏感动作认证边界；不能从 UI 自报身份授权。 前置：T06.3、T24.2。 来源：M16.5。
- [ ] **T23.2 挂载与安全移除** · 已延期 / 待实现 · P2 · installed：按权限契约实现挂载、卸载、安全移除和使用中/拔出/失联反馈；不自动挂载或写入排除内盘。 前置：T23.1。 来源：M16.5。

#### T25 外置安装逐项验收

写入前检查明确候选/安全条件；日常、维护、救援和拔出耐久分别验收，不机械等待原 M01–M07 全部条目。

- [ ] **T25.1 授权外置安装** · 已延期 / 待授权/待决策 · P2 · hardware：在指定外置 USB/SSD 安装并记录硬件、固件、布局、版本及授权范围，不修改排除内盘。 前置：授权、T03.8、T24.5、T24.4。 来源：M08.1。
- [ ] **T25.2 外置认证与冷启动** · 已延期 / 待实现 · P2 · hardware：验证首次 setup、默认密码登录、可选自动登录、日常 su、锁屏/注销和重复冷启动。 前置：T25.1、T14.2、T15.6。 来源：M08.2。
- [ ] **T25.3 外置数据连续性** · 已延期 / 待实现 · P2 · hardware：验证设置、文档、应用注册/AppData、认证状态和已实现网络凭据跨重启/维护/救援连续性。 前置：T25.1、T07.3、T09.3、T12.4、T17.2。 来源：M08.3。
- [ ] **T25.4 外置故障耐久** · 已延期 / 待授权/待决策 · P2 · hardware：在可丢弃测试数据/授权介质上验证拔出、掉电及满盘后的可恢复性，不能用 VM 结果代替。 前置：授权、授权、T25.1、T26.4。 来源：M08.4。

#### T26 硬件与联合故障验收

限定当前候选/硬件范围，普通启动、测试授权、持久提交与实际断电分别记录；更多硬件不是统一门槛。

- [ ] **T26.1 目标硬件逐项记录** · 已延期 / 待实现 · P2 · hardware/installed：补齐当前 Debian 的实际 GPU/renderer、网络、音频、VT/seat 和目标设备逐项结果。 来源：M20.1。
- [ ] **T26.2 热插拔与设备恢复** · 已延期 / 待实现 · P2 · hardware/installed：验证物理热插拔、多显示器/混合缩放、音频插拔和所选设备恢复，按具体接线范围记录。 前置：T26.1。 来源：M20.2。
- [ ] **T26.3 长期耐久与联合故障** · 已延期 / 待实现 · P2 · hardware/installed：多小时运行、反复启动退出和登录/锁定、应用/服务/设备故障，以及安装/更新中断联合验收。 前置：T15.6、T07.5、T09.3、T16.5。 来源：M20.5。
- [ ] **T26.4 用户写入中断一致性** · 已延期 / 待实现 · P2 · hardware/installed：验证设置、应用注册、文档写入的中断一致性，区分未提交、已提交和可恢复状态。 前置：T04.4、T12.2。 来源：M06.3。
- [ ] **T26.5 正常与测试授权隔离** · 已延期 / 待实现 · P2 · hardware/installed：扩展普通镜像/fixture 的隔离检查，真实软件流程验证且不把测试授权带进正常镜像。 前置：T03.8、T09.1。 来源：M06.4。
- [ ] **T26.6 关机断电证据** · 已延期 / 待实现 · P2 · hardware/installed：验证基础镜像不变、正常关机/异常断电的不同结论，保留每轮独立证据和失败产物。 前置：T03.8。 来源：M06.5。
- [ ] **T26.7 外置硬件记录** · 已延期 / 待实现 · P2 · hardware/installed：记录实际 GPU/renderer、VT/seat、网络、音频等逐项结果；未覆盖组合明确标注。 前置：T25.1、T26.1。 来源：M08.5。

#### E09 采集与屏幕分享

屏幕/窗口捕获、保存、选择/授权/撤销和失败体验；用户会话同意不等同管理员认证。

- [ ] **E09.1 截图录屏与保存** · 已延期 / 待实现 · P2 · installed：交付用户截图/录屏与屏幕/窗口捕获接口、保存/错误 UX，不把 harness/QEMU 截图当产品。 来源：M19.1。
- [ ] **E09.2 屏幕共享与撤销** · 已延期 / 待实现 · P2 · installed：选择首批屏幕共享/采集 Portal、授权/撤销及会话边界，和文件 Portal、音频采集协调。 前置：E09.1、T06.3、T15.1。 来源：M19.2。

#### E11 XWayland 兼容

明确真实 X11/XEmbed 客户端集合；不能以 SDL 支持 X11 宣称会话有 XWayland。

- [ ] **E11.1 XWayland 与托盘** · 已延期 / 待实现 · P2 · installed：XWayland/X11 应用及 XEmbed 托盘兼容，验证真实客户端，不因 SDL 构建 X11 就声称有 XWayland。 来源：M19.4。

#### E13 窗口视觉效果

对所选圆角/模糊/阴影/动画/形状输入分别测量；已有 alpha 不重做。

- [ ] **E13.1 窗口视觉效果** · 已延期 / 进行中/部分完成 · P2 · installed：按优先级实现内容圆角裁剪、模糊、阴影、动画和形状输入；真实 alpha 已有，不重做。 来源：M17.5。 证据：2026-10-16 895ff98共通主题冻结后，唯一native owner完成整窗圆角及外阴影基础，已合6b9f0e9/4603005/1f670dd（源0393719/b531ff6/62a9545）。固定wlroots0.19.3 generic effect-tree补丁在原scene/outputcommit/damage/lock内先复合client+四frame+subsurface，再一次AAcoverage；不采用逐leaf重复AA/阶梯硬裁/背景角盖图/JS采样或隐藏绘图窗。显式nativeEffects none/rounded/rounded-shadow，旧theme缺省不变，max/full/CSD/frameless保持；外shadow非input/非opaque兄弟、analytic Gaussian-outline且剔除内部，RGB/alpha/sigma/offset由JS生成受界数值，四strip权限/FD预算不放松。scene128MiB计cache+workspace、target32768axis/16Mp，phase/scale/output缓存、damage/map/destroy失效与锁屏遮挡保守；超预算/分配失败明确fail而非square fallback。SDK/release同applier/base+patch9395ed69、独有SONAME effects2/header/link/runtime ABI2/actualembeddedhash严格配套，canonical JSON消CRLF假错，旧库/旧wire拒绝；private6/schema6，publicJSON1保持。现Debian配套源码和自有prefix真实编译，未构建新SDK发行镜像/ISO；Alpine历史入口明确early unsupported等待同套移植。父frozen snapshot实际Pixman8scale/outputtransform/alpha/overlap/crop、phase move41/43/occlusion/reveal/cache/budget、真实Wayland client/subsurface/input/lifecycle、真实GUI标题单coverage partial54/60与max方角0/旧none bytes、privatepair/oldserver/lock和actual生产v6daemon coldmissing/normal均通过；Node38与combined144通过。llvmpipe23bit真实GLSL原语2048/4096/8192通过，但完整WM GLES/DRM/物理GPU仍无设备资格；62显式precision声明仅澄清原本已highp分支，不伪称已复现数值bug。圆角/外阴影共通能力完成，区域backdrop采样/模糊、动画、形状输入和逐主题默认采用仍后续独立工作，因此E13.1保留partial。

#### E16 可复测性能预算

先记录启动/内存/帧与占用，再定可复测目标；优化方向按测量另选，不先删回退。

- [ ] **E16.1 可复测性能预算** · 已延期 / 待实现 · P2 · installed：测启动时间、空闲/峰值内存、帧耗时/输入延迟、镜像/安装占用，再定可复测预算。 来源：M20.4。

#### O1 有线网络与 DNS

有线连接、地址/DNS、错误与恢复作为独立后期网络项目；已具备的私有状态与 Wi-Fi PSK 控制不被它反向阻塞。

- [ ] **T17.3 有线网络与 DNS** · 已延期 / 待实现 · P2 · live/installed：补齐有线状态、地址/DNS 管理和失败反馈，不把已有 DHCP/DNS 记为未实现。 前置：T17.1。 来源：M12.4。 证据：用户明确将有线网络延后，归系统优化，不作为 Alpha 桌面候选的硬件前置。

### R1 Live 账户可用 — 已完成

**交付/边界：** Live 用公开账户和公开维护密码启动普通用户桌面；远程登录默认关闭，预设凭据不污染安装或救援。


#### T01 Live 账户与会话

只改变 Live 体验策略；默认 polly/polly，root 公开维护密码 polly。公开密码不提供个人数据保护。

- [x] **T01.1 运行模式账户策略** · 已完成 · P0 · common：已确认 Live 有公开默认账户/密码；完整安装首次必须设置 polly 与独立 root 密码。介质是 USB 或 SSD 不决定模式。 证据：2026-10-08 用户提出 Live 默认凭据，并明确选择安装首启设置两套独立密码。
- [x] **T01.2 Live 公开密码** · 已完成 · P0 · live：在 Live 专用配置层设置 polly 和 root 的公开开发默认密码 polly；提示这些密码公开，桌面仍为 UID1000。 前置：T01.1、T02.1。 证据：Live 专用层/构建辅助已实现；独立缓存容器真实 PAM/su/改密通过，不能据此宣称新 Live 镜像已启动。
- [x] **T01.3 Live 自动登录** · 已完成 · P0 · live：保留普通用户自动登录配置；容器验证默认凭据、改密和标准 su/PAM，不自动开放未验收的锁定/挂起。新候选实际自动进入桌面由 T01.5 验收。 前置：T01.2。 证据：getty 普通 UID1000 自动登录配置保持；独立缓存容器正确/错误 root 密码与普通用户改密/PAM 验证通过。
- [x] **T01.4 关闭默认远程登录** · 已完成 · P0 · live：默认不开 SSH/远程 root 登录；启用远程服务须独立配置，不能直接暴露公开默认凭据。 前置：T01.2。 证据：Live 层明确 mask ssh/sshd 的 service/socket 别名；独立容器核对 /dev/null 掩码，未重新构建原 Live 镜像。
- [x] **T01.5 Live 新策略启动** · 已完成 · P0 · live：新的 Live 候选实际启动并验证公开账户及 root 维护行为；改密默认仅本次会话，不宣传为持久化 Live。 前置：T01.3、T01.4。 证据：独立 r2 ISO/USB 已装配，sourceDirty=1、复用固定缓存载荷；build/live-profiles-r2-boot-slow-input/run/result.json 通过普通 OVMF UEFI/TCG、UID1000 DRM/logind 桌面、真实中文/剪贴板/工作区。public-maintenance 串口记录确认根0755与 UID1000→标准 root su 的公开密码；QMP退出非正常关机/持久性/独立救援证明，失败r1及首次TCG输入证据保留。

#### T02 安装凭据与模式隔离

公共 runtime/SDK 保持锁定账户模板；Live 预设在最终 Live 层应用。安装和独立救援不复制 Live shadow。

- [x] **T02.1 锁定模板与 Live 分层** · 已完成 · P0 · common：把公共锁定账户模板、Live 预设和安装镜像模板分层；安装生成独立状态，无安装默认密码，不把已设置密码的 Live 模板冒充未初始化模板。 前置：T01.1。 证据：platform-base 保持锁定模板，最终 live-base 才设置公开密码；Installed FROM PLATFORM_IMAGE。配方/不重置边界和独立缓存容器验证通过，完整新镜像待验收。
- [x] **T02.2 可信模式与拒绝回落** · 已完成 · P0 · common：明确 Live/fresh/installed/recovery 的可信模式入口；安装状态缺失/坏卷不回退 Live 登录或重开 setup。 前置：T02.1。 来源：M01.4、M03.1。 证据：公共只读 profile-check 校验模式、元数据/编码并拒绝缺失/串用；Live/安装会话和账户后端接通。fresh 由已存在的 initialized 权威决定；旧无守卫产物保留原验证路径。快验及普通 UID 容器检查通过，救援模式标签不等于独立救援已可启动。
- [x] **T02.3 模式串用回归** · 已完成 · P0 · common：组件回归验证 Live 预设不能复用为安装/救援锁定模板，缺失/串用/不安全标记均拒绝；安装无默认密码，旧账户导入保持既有凭据。救援整机及目标凭据写入授权仍由 T09 验收。 前置：T02.1、T02.2。 证据：统一 mounts 快验包含独立 installed/live/recovery 缓存容器和旧账户导入：正确/错误/旧密码、普通改密、模板字节保留、无预设重置及拒绝串用通过；不是新镜像/实际独立救援验收。

### R2 新安装可启动并初始化 — 进行中/部分完成

**交付/边界：** 在可丢弃虚拟目标上，新策略候选通过可写单系统启动、独立两套密码设置、标准认证和普通用户桌面；不要求先迁移旧系统或完成 GUI。


#### T03 存储与普通启动

只验收普通单系统启动；独立救援由 T09 验收，完整安装器由 T24 实现。

- [x] **T03.1 可写单系统契约** · 已完成 · P0 · fresh/installed：落实布局版本、UUID、必需映射/权限、各类状态权威和恢复分组，容量按载荷/暂存/救援实测；禁止整映射 `/etc` 或 `/var/lib`。 来源：M06.6。 证据：07e1692；布局版本/UUID/权限及容量规则组件验收。
- [x] **T03.2 早期 usr 接入** · 已完成 · P0 · fresh/installed：在 initramfs 自有工具链中将完整 `System/Resources` 接入 `/usr`，保留 merged-usr 关系；校验失败不得启动主系统 init。 前置：T03.1。 来源：M06.7。 证据：aacde4c；early-usr 与 initramfs-only 工具检查；不替代新候选冷启动。
- [x] **T03.3 必需持久状态映射** · 已完成 · P0 · fresh/installed：接通 `SystemData/Apps/Users` 及 Dpkg/Apt、日志/缓存/临时、账户/服务、HOME 必需映射；启动/维护前检查同一存储与权限，不静默回落。 前置：T03.1、T03.2。 来源：M06.8。 证据：a0a4e1c；namespace 映射及 r2 ext4 普通启动，服务状态仍逐项分类。
- [x] **T03.4 普通虚拟候选装配** · 已完成 · P0 · fresh/installed：普通单系统 regular 镜像装配、容量实测及目录权限已完成；Recovery 仅 reserved-not-bootable，不继承救援或真实安装验收。 前置：T03.3。 来源：M07.1。 证据：9e89f8c；single-system-r2 原始 raw 保持不变。
- [x] **T03.5 r2 普通启动基线** · 已完成 · P0 · fresh/installed：r2 无 fixture 的 OVMF/KVM 启动、首次设置、PAM 登录和 UID1000 桌面；该 smoke 由 QMP 退出，不是正常关机验收。 前置：T03.4。 来源：M07.5。 证据：build/single-system-smoke-r2/run/result.json；来源 9e89f8c。
- [ ] **T03.6 必需存储故障** · 进行中/部分完成 · P0 · fresh/installed：覆盖必需存储/映射缺失、错 UUID、坏 schema/权限、不可写、满盘、损坏及启动中断；拒绝空目录写入、空包数据库和认证重置。 前置：T03.3。 来源：M06.1。 证据：8e1e069/8af0915→75ad21c6/d47fee45及中央注册随ac5a5a5合并推送：descriptor稳定快照/严格JSON/必要Dpkg status/就绪及映射守卫完成，独立103单测和3个实际私有namespace夹具、64唯一故障拒绝通过。实际SYSTEM/PERSISTENT/runtime零可用块和PERSISTENT零inode仍可只读检查，实际prepare EROFS/ENOSPC明确拒绝；无空目录fallback/认证重置/全局reserve。用户选定满盘仍保留登录诊断清理，写入各按需求失败。tmpfs/synthetic UUID证明不关闭真实ext4损坏、包事务满盘、启动中断/整机掉电/冷启动；完整T03.6继续进行中。独立报告7c4076dc43ce14cc30de74b2939343536900cd159bedb0ca8341075ae083c7fc；最终native报告d4ec553edb9afa5c583e258140bc28fa63ace3ee97a1f0499612ff2ffab3739b。
- [ ] **T03.7 只读诊断入口** · 待实现 · P0 · fresh/installed：实现明确的故障信息、只读诊断和受控恢复入口，不自动格式化/修复未知介质。 前置：T03.6。 来源：M06.2。
- [ ] **T03.8 新策略正常冷启动** · 进行中/部分完成 · P0 · fresh/installed：将当前已提交的模式、账户、HOME 与必要组件装入新候选，实际普通 UEFI 冷启动、两套密码设置、默认密码登录与正常关机；保留失败/来源摘要。 前置：T02.3、T03.3、T04.5、T05.3、T05.4、T06.3。 来源：M07.5、M01.6。 证据：新 e879 的 Live ISO 与未初始化单 SYSTEM raw/VHDX已交付：Live ISO677996544字节/SHA d52d36a3，QEMU光盘实际普通 Live 桌面；VHDX SHA a0849d5d/QEMU真实首次设置；用户正确 Hyper-V PollyOS installed 桌面已观察。不是当前 ce73 新媒体、正常关机/重启耐久或 fresh Hyper-V 图形入口一致性完整验收。

#### T04 持久身份与版本状态

用户凭据/角色、版本服务账户、主机身份和网络状态各有权威；不整体共享系统账户表。

- [x] **T04.1 账户权威与版本** · 已完成 · P0 · common/fresh/installed：定义账户/初始化/角色权威及版本兼容规则；不把 root/polly 凭据、服务 UID 与普通 AppData 混成一个状态集。 来源：M01.1。 证据：已明确 config v2/v3、passwd/shadow、私有 roles v1 与派生 marker 的权威/版本边界；缺角色不重开初始化、不替换版本服务表。相关控制器/角色/迁移单测与既有真实 PAM 组件回归通过；不等于完整管理后端或新镜像验收。
- [x] **T04.2 管理员角色契约** · 已完成 · P0 · common/fresh/installed：定义 polly 管理员资格、稳定 UID/GID 和操作范围，普通应用不可自报身份；该模型先于首启创建角色，不依赖图形认证 UI。 前置：T04.1。 来源：M01.1、M04.3。 证据：roles.py 的独立 schema/UID/重复字段/服务身份/操作白名单校验通过；role eligibility 明确不是 PAM、会话身份或特权执行授权，真实后端仍为 T14.6。
- [x] **T04.3 root 私有账户存储** · 已完成 · P0 · common/fresh/installed：实现 root 私有、普通应用不可改写的存储/加载边界，不共享整个 `/etc`、`/var` 或把认证数据放入 AppData。 来源：M01.2。 证据：617cea4/df7088e；既有私有账户加载边界。
- [x] **T04.4 账户原子保存与锁** · 已完成 · P0 · common/fresh/installed：已实现私有有界状态锁、原子保存、并发写与提交后同步失败报错；不等于实际断电/完整恢复。 前置：T04.3。 来源：M01.4。 证据：1468b6b；有界 flock/并发/故障检查。
- [x] **T04.5 新布局账户接入** · 已完成 · P0 · common/fresh/installed：联合适配 `SystemData/Accounts`、控制器/passwd proxy/NSS/PAM、UUID/权限及唯一初始化权威；服务账户仍随系统版本，持久配置逐项分类，不整体替换 `/etc`。 前置：T03.3、T04.3。 来源：M01.6。 证据：df7088e；schema3/UUID/NSS/PAM/passwd 接入及 r2 普通认证。
- [ ] **T04.6 账户事务故障闭环** · 进行中/部分完成 · P0 · common/fresh/installed：补齐当前版本、只读/满盘/损坏/中断恢复与初始化权威一致性；失败不回默认密码或无密码登录。 前置：T04.4、T04.1。 来源：M01.4。 证据：新增受限/O_NOFOLLOW/fstat 账户读、硬链接拒绝、私有无效UTF诊断与重复JSON键拒绝实现已开始；编译/回归交给临时 worktree 快速验证子会话，未返回对应固定快照结果前不关闭完整故障恢复条目。
- [ ] **T04.7 服务状态逐项分类** · 待实现 · P0 · common/fresh/installed：版本配套服务 UID/GID 随系统；分类持久服务配置及升级/恢复规则，不整体覆盖 passwd/group/var/lib。 前置：T03.1。 来源：M01.1。
- [ ] **T04.8 主机身份权威** · 待实现 · P0 · common/fresh/installed：定义并保存机器身份/主机配置的权威、权限和维护保留；网络凭据实施归 T17，不重复做另一套存储。 前置：T04.1。 来源：M01.1。 证据：用户重排第四批为图形登录/首次设置/系统设置与文件功能；本轮暂停新增主机身份基础设施。原子会话工作树0f86311干净、无产品修改，任务仍待实现，不作用户功能的新增前置。

#### T05 全新首次设置

仅处理真正新安装；创建角色与 HOME 是初始化，不等待旧数据迁移或完整管理 UI。

- [x] **T05.1 稳定 UID 的新 HOME** · 已完成 · P0 · common/fresh：已实现 root/polly/稳定 UID 的私有 HOME、XDG、兼容链接及 user-dirs 初始化组件，迁移暂存也可复用；这是代码能力，不要求先在迁移目标创建 UID 目录。既有数据冲突拒绝，不覆盖。 前置：T03.3。 来源：M02.3、M01.7。 证据：21517ca；fresh HOME、两个真实 UID 数据隔离组件检查。
- [x] **T05.2 未初始化入口** · 已完成 · P0 · fresh：仅在真实未初始化状态进入受控 setup，不开放通用 root 桌面或无限制 root shell。 前置：T04.5。 来源：M02.1。 证据：617cea4；控制台 setup 入口；不是图形安装向导。
- [x] **T05.3 首启两套独立密码** · 已完成 · P0 · fresh：本地交互设置/确认 `polly` 与独立 root 密码；校验输入和 PAM 结果，不从聊天、参数、环境或日志取得密码。 前置：T05.2。 来源：M02.2。 证据：617cea4 与 r2 控制台/实际 PAM；首次必须独立设置 polly/root，无安装默认密码。
- [x] **T05.4 首个管理员初始化** · 已完成 · P0 · fresh：按既定角色模型创建首个 polly 管理员，桌面仍普通用户；bootstrap 使用受控 setup 权限，不依赖尚未建成的管理员 UI。 前置：T04.2、T05.2。 来源：M02.3。 证据：控制台首启在两套密码有效后、initialized 提交前原子建立 root:root 0600 roles.json；缺/坏策略显式拒绝，已初始化旧账户不自动猜角色。组件单测通过；原有策略精确迁移和实际 PAM 联合回归继续验收，非图形 Setup 完成。
- [ ] **T05.5 必要初始配置** · 待实现 · P0 · fresh：初始化必要主机/用户配置及权威完成状态，不以缺 marker 判断新用户；不会替换已有安装的当前认证。 前置：T05.1、T04.8。 来源：M02.3。
- [ ] **T05.6 首次设置中断恢复** · 待实现 · P0 · fresh：实现成功、取消、失败、重试和中断恢复；账户与完成标记不能半配置提交。 前置：T05.3、T05.4、T04.6。 来源：M02.4。
- [ ] **T05.7 首次设置故障验收** · 待实现 · P0 · fresh：验证第二次启动不重复 setup，磁盘只读/满盘/断电不会产生“初始化成功”的假象。 前置：T05.6、T03.8。 来源：M02.5。

#### T06 标准认证与密码维护

保留 root 密码标准 su；公开 Live 密码不进入安装认证；组件/历史镜像证据与新策略候选分开。

- [x] **T06.1 标准持久改密** · 已完成 · P0 · installed/fresh：标准 passwd、root 改密及锁定/解锁写入同一受控权威，普通用户不能改 root；额外用户生命周期另由 T11 完成。 前置：T04.5。 来源：M01.3。 证据：1468b6b/94c23cd；真实 passwd/PAM/su，保留实际调用 UID。
- [x] **T06.2 标准 su 与身份恢复** · 已完成 · P0 · installed/fresh：通过发行版标准 su/PAM 支持普通用户日常 `su -`，核实 root 身份、环境与退出后的普通用户身份。 前置：T05.3。 来源：M04.1。 证据：617cea4；root 身份/环境及退出后普通 UID/GID 验证。
- [x] **T06.3 普通 PAM 桌面链路** · 已完成 · P0 · installed/fresh：getty/login/PAM/logind/seat/runtime 连接 UID1000 原生桌面，认证失败不启动；图形登录界面另属 T14。 前置：T04.5。 来源：M03.2、M03.1。 证据：r2 普通 UEFI 密码登录与 logind/DRM 桌面；不继承 Live 自动登录。
- [x] **T06.4 r2 改密冷启动基线** · 已完成 · P0 · installed/fresh：三轮普通 r2 控制台密码登录、标准改密/root su、旧密码拒绝、新密码及数据保留；每轮正常关机。 前置：T06.1、T06.2。 来源：M01.5。 证据：build/single-system-account-persistence-r2-attempt3/run/result.json；不代替不同版本维护/救援。
- [ ] **T06.5 提权失败拒绝** · 待实现 · P0 · installed/fresh：验证错误密码、锁定账户、取消和服务失败均拒绝提权；不以 sudo-only、无密码规则替代要求。 前置：T06.2、T06.1。 来源：M04.2。

### R3 系统可维护与独立救援 — 进行中/部分完成

**交付/边界：** apt/内核维护及匹配恢复保留最新身份和数据；独立救援不依赖主系统资源，不使用 Live 公开密码授权。


#### T07 apt 与内核维护

使用当前可写系统和版本配套包状态；root 维护原型不等待完整管理员 GUI 或旧安装迁移。

- [x] **T07.1 载荷与包状态契约** · 已完成 · P0 · installed：定义完整系统载荷、版本/架构、容量、数据兼容及物料元数据；核对系统与包数据库匹配。 前置：T03.1。 来源：M09.1。 证据：7b6000d→临时集成67cc861→最终a5e176a已合并并推送；系统/完整Dpkg/Apt树SHA身份、status/TSV/usr+boot/list/MD5/diversion一致性、容量/兼容固定schema与拒绝矩阵已实现并独立20单测及组合CTest通过。dev-unsigned证明不认证来源/ABI/conffile或ext4/启动，不执行apt/替换/恢复。
- [ ] **T07.2 apt 维护与锁** · 待实现 · P0 · installed：验证 apt 安装/升级/卸载、配置冲突、divert、锁及内核启动文件更新；必要映射就绪前不得维护系统，不与离线恢复并发。 前置：T03.3、T07.1、T07.5。 来源：M09.2。
- [ ] **T07.3 维护保留最新身份** · 待实现 · P0 · installed：保留最新认证/管理员/网络状态，迁移可验证且版本不兼容时明确拒绝。 前置：T04.5、T06.1、T04.1。 来源：M09.4。
- [ ] **T07.4 内核与引导维护** · 待实现 · P0 · installed：验证 `/boot` 真实存储/兼容接入、微码、内核/模块、update-initramfs/update-grub 和包脚本，维护后实际冷启动，不能仅测路径存在。 前置：T07.2。 来源：M09.7。
- [ ] **T07.5 更新事务与中断** · 待实现 · P0 · installed：在 `SystemData/Updates` 记录操作 ID、源/目标、恢复范围、校验、阶段和错误；离线事务排除活动 apt 写入，关键阶段中断可识别并继续/修复/恢复。 前置：T03.3、T04.4。 来源：M09.8。

#### T08 匹配载荷与开发信任

完整系统替换与包状态匹配；测试身份验签、开发未签名边界和生产身份分开。

- [ ] **T08.1 匹配载荷替换** · 待实现 · P0 · installed/recovery：完整载荷替换写前检查容量/来源/兼容性及匹配恢复材料，在维护/救援环境执行；记录事务与中断状态，不覆盖用户数据或破坏唯一救援入口。 前置：T07.1、T07.5、T09.1、T09.2、T09.4。 来源：M09.3。
- [x] **T08.2 测试签名与拒绝** · 已完成 · P0 · installed/recovery：用测试身份验证签名、可信公钥、篡改/错误签名拒绝；正式信任根、生产签名及密钥操作另行确定/授权。 前置：T07.1。 来源：M09.5。 证据：f156227→fe89350及中央注册已随ff4be97合并推送；明确test-only Ed25519/外部测试公钥、错误签名/篡改/格式/工具失败拒绝，独立41项及0c完整源码套件通过。development-unsigned不提升，实际物料仍需独立preflight；无生产密钥/发行/写授权。独立报告0ec1c8497566d23fa28ad32ca417d2d8f0d7a6f60ea29ceb329a759413d4b165，最终native组合报告a3211b6f5321d2a247c65fa7c1e3324b5b0c7acab99e2da9bb5ee0df3b769cbe。
- [ ] **T08.3 开发未签名边界** · 待实现 · P0 · installed/recovery：开发未签名产物明确标识，不能通过成功形态的 fallback 绕过正式验签；不默认开启在线自动更新。 来源：M09.6。

#### T09 独立救援与一致恢复

救援使用自己的内核/软件，按已安装系统的 polly/root 凭据授权；诊断只读、无万能重置，不依赖 Live 默认密码。

- [ ] **T09.1 独立救援载荷** · 待实现 · P0 · recovery：构建救援自有内核、initramfs、Rootfs.img、Manifest 和工具；不依赖主系统程序/库/账户加载，主资源或包数据库损坏时实际启动。 前置：T03.1。 来源：M10.6。
- [ ] **T09.2 救援认证与保留** · 待实现 · P0 · recovery：诊断只读且不开放个人数据；写入/重装/账户恢复认证 polly 管理员或 root，忘记全部密码无内置重置入口。验证来源/材料和唯一救援入口，恢复后软件/包状态匹配而最新身份、凭据、App 和用户内容保持。 前置：T09.1、T04.5、T04.2。 来源：M10.7。
- [ ] **T09.3 匹配恢复与外部入口** · 待实现 · P0 · recovery：提供不依赖主系统软件的独立救援与匹配系统恢复，验证引导配置损坏、更新中断、空间不足和包/载荷不一致；共用 EFI 损坏须有外部恢复路径。 前置：T09.1、T09.2、T07.1。 来源：M10.1。
- [ ] **T09.4 数据兼容与恢复边界** · 待实现 · P0 · recovery：定义系统/应用数据 schema 兼容、备份、恢复与不可逆迁移边界，不能假定旧系统能读新数据。 前置：T03.1、T04.1。 来源：M10.2。
- [ ] **T09.5 诊断与授权账户恢复** · 待实现 · P0 · recovery：提供诊断导出、受控改密/账户恢复、修复说明和数据备份流程；回退不能恢复旧密码或偷偷重置凭据。 前置：T09.2、T09.4。 来源：M10.3。

### R4 数据迁移与共享应用 — 进行中/部分完成

**交付/边界：** 旧来源显式资格/备份/迁移可验收；额外用户认证和共享包的数据隔离闭环。新安装共享运行只依赖具体组件，不等待整个旧系统迁移。


#### T10 既有安装离线迁移

仅处理明确的旧来源；源只读、资格/备份/校验后原子发布，新安装不依赖本任务整组完成。

- [x] **T10.1 离线 HOME 导入** · 已完成 · P0 · migration：保留旧 HOME/XDG/文档及原始私有备份、内部硬链接和已知 root/ACL；冲突、未知属性/身份及中断显式拒绝。 前置：T05.1。 来源：M01.7。 证据：fa6763a/b8a9a4e/cbf128f；v1/v2/v3 检查范围保持。
- [x] **T10.2 明确身份与 ACL 映射** · 已完成 · P0 · migration：源/目标公开表指纹固定，普通 UID 稳定、服务身份显式重基；备份不改数值身份，漂移明确中断。 前置：T10.1。 来源：M01.7。 证据：e7c4ea3；schema4，真实只读 namespace；不写系统账户表。
- [x] **T10.3 旧账户权威导入** · 已完成 · P0 · migration：旧 schema2/homeUuid 明确资格，转换目标 schema3/persistentUuid；保留密码/锁定/初始化/自动登录，目标已有状态拒绝。 前置：T04.5、T10.2。 来源：M01.7、M01.5。 证据：94c23cd；私有备份/no-replace 与真实 tmpfs/PAM/su/passwd；卷发现 fixture 不是 ext4/整机证明。
- [x] **T10.4 原生应用迁移组件** · 已完成 · P0 · migration：两个普通 UID 用真实 cached manager/runtime 验证同 app-id/代码和 localStorage 1→2，源/备份不变；不是额外账户 PAM 或共享注册证明。 前置：T10.1。 来源：M01.7。 证据：build/storage-managed-home-migration-v4/result.json；旧 v2/v3 结果保留。
- [ ] **T10.5 迁移角色与版本配置** · 待实现 · P0 · migration：对明确旧管理员资格、主机/服务配置与新角色模型作显式适配；不重开 setup、不把同名服务推为管理员、不重置现有凭据。 前置：T04.2、T10.3。 来源：M01.1、M01.7。
- [ ] **T10.6 迁移后的正常冷启动** · 待实现 · P0 · migration：合并当前迁移工具，选择明确旧来源，在迁移后的普通候选正常登录、运行应用、改密并重复冷启动；不得用源丢失重开 setup。 前置：T10.3、T10.5、T10.4、T03.8。 来源：M01.7、M07.5。
- [ ] **T10.7 迁移中断与耐久** · 待实现 · P0 · migration：补齐目标 ext4 满盘/各阶段掉电重启诊断及备份保留；注入失败和 tmpfs 证据不替代真实文件系统/整机。 前置：T10.3、T10.1。 来源：M01.7、M06.3。

#### T13 应用运行与数据生命周期

版本/数据分别处理，未知数据不接管，运行资源不因主 PID 退出就回收。

- [x] **T13.1 D-Bus 桌面激活** · 已完成 · P0 · installed：补齐 `.desktop` D-Bus-only activation，不借任意 shell 命令或伪造 Exec 绕过。 来源：M15.2。 证据：2715d00→e68d142链及真实native修复e7d709已随ff4be97合并推送；普通UID1000新编产品真实自动启动/ACK/错误/8队列/断连/关闭/重新发现/FD拒绝及3500ms晚回复+4000ms阻塞pump绝对超时通过，21/21普通回归通过，旧Exec/bundle/菜单/XP相邻行为保留。明确不伪造PID、不重试/Exec fallback；common bus同步认证/注册不属于3000ms post-send期限，MIME/Open不由此完成。保留0c zero-FD背压原失败和确定性修复对照；最终报告a3211b6f5321d2a247c65fa7c1e3324b5b0c7acab99e2da9bb5ee0df3b769cbe。
- [ ] **T13.2 使用中代码安全回收** · 待实现 · P0 · installed：安全回收旧版本/孤立代码；覆盖脱离主进程的后代及仍被使用的资源，不以主 PID 退出判断可删。 前置：T12.2、T12.4。 来源：M15.3。
- [ ] **T13.3 卸载与独立清除数据** · 待实现 · P0 · installed：卸载默认保留 AppData；清除数据独立确认，仅针对管理器明确拥有的路径。 前置：T12.1、T12.2。 来源：M15.4。
- [ ] **T13.4 应用数据版本迁移** · 待实现 · P0 · installed：实现 schema/layout 迁移、独占/备份及不兼容回退策略，不静默清空数据。 前置：T09.4、T12.2。 来源：M15.6。
- [ ] **T13.5 第三方应用联合验收** · 待实现 · P0 · installed：选择更多真实第三方应用及非 XDG 适配，验证上游升级和完整跨重启安装/更新/回退/卸载组合。 前置：T12.4、T13.4。 来源：M15.7。

### R5 日常桌面基础 — 进行中/部分完成

**交付/边界：** Alpha 的图形登录、基础设置/本地音频与应用、文档打开保存、普通注销和关机体验；锁屏认证、视觉精修、共享包和设备硬件资格单独延后，不宣传已具受保护生产桌面。


#### T14 图形认证与账户管理

GUI 消费已有身份/角色后端；先建角色再用它认证，不反向阻塞首启。

- [x] **T14.1 图形首次设置** · 已完成 · P1 · installed：将已验证控制台双密码/初始化流程接入受控 GUI，取消/失败不虚报完成；GUI 不持通用 root 桌面。 前置：T05.3、T05.4。 来源：M02.1、M02.2、M02.4。 证据：2026-10-09 固定 4e6b004 生产默认 UEFI 新 QEMU guest 真实四字段首设，经受限 broker/标准 passwd/PAM 完成独立 polly/root 测试密码设置并转密码登录；先前 source/小 C/PAM 的取消、失败与权威 Retry 状态边界保留，不通用 Root GUI、不 console/PAM observer 旁路。真实排序环由 6d93e6f 最小源修复，父审合并并核实际截图/61项最终证据，receipt SHAb2f62ede。范围为已验证图形功能与新隔离 guest，不回填旧 Hyper-V 根因或宣称该宿主现场首设已测试；发行 VHDX 未初始化、无预设安装密码。
- [x] **T14.2 图形密码登录** · 已完成 · P1 · installed：实现真实 PAM 登录界面和普通用户桌面交接；仍默认密码登录，不改变历史已生成 Live 产物。 前置：T06.3。 来源：M03.1。 证据：2026-10-09 新 4e6b004 guest 标准 greetd/PAM 图形密码登录进入普通 installed 桌面，实际一次错误密码拒绝后正确重试成功；正常注销回 greetd 后再次登录，以及标准 guest Reboot 后原密码重新登录均成立。父核 03/04/18/19 实图与 guest-reset 事件，receipt SHAb2f62ede；不是 Live、root 桌面、锁屏解锁或恢复 cow。用户旧 Hyper-V 配置未改，现场挂载/启动由用户执行，不能以 QEMU 覆盖硬件或该宿主资格。
- [ ] **T14.3 登录失败与重试** · 进行中/部分完成 · P1 · installed：处理错误密码、账户不可用、服务失联、取消/超时和启动失败，提供受保护的诊断/重试入口。 前置：T14.2。 来源：M03.3。 证据：第四批受限 greetd/非root greeter、双密码/取消/独立提交、错误登录与权威状态 Retry 的功能源码及真实小 C/PAM 组件已具并纳入 ce73a3c；QEMU 新 VHDX 初次四字段实际可见，用户 Hyper-V PollyOS 通过控制台设密并进入 installed desktop。Hyper-V 首次图形入口不出现/首次卡住重启后能进桌面的确切原因未取 guest journal，不能假称全图形首启完成。未来镜像含 1cd5f77 控制台 user-sessions 服务依赖修复，已交付 e879 不被改写。
- [x] **T14.5 已有自动登录策略** · 已完成 · P1 · installed：root CLI 明确开启/关闭，跨重启保存且每次启动最多一次；不等于图形管理员认证或锁屏已经交付。 前置：T04.5。 来源：M03.4。 证据：617cea4/1468b6b；默认关闭与 once-per-boot 检查。
- [ ] **T14.6 真实管理调用者授权** · 待实现 · P0 · installed：验证真实本地会话、管理员角色和所需操作范围；拒绝自报 UID/任意路径/命令/hooks，可先用受限后端和夹具验收。 前置：T04.2、T05.4、T06.3。 来源：M04.3。
- [ ] **T14.7 管理员认证界面** · 待实现 · P1 · installed：系统管理使用认证 UI/PAM、取消/失联/超时反馈和不含凭据诊断；标准 su 仍使用独立 root 密码。 前置：T14.6。 来源：M04.3。
- [ ] **T14.8 自动登录设置界面** · 待实现 · P1 · installed：管理员认证后显式修改自动登录，提供风险说明，不存明文密码；锁屏和注销认证不被取消。 前置：T14.5、T14.7。 来源：M03.4。
- [ ] **T14.9 普通偏好与系统管理** · 待实现 · P1 · installed：区分普通偏好与账户/安全/系统组件管理；普通应用不能通过自报身份取得通用 root 执行权限。 前置：T14.6。 来源：M04.4。
- [ ] **T14.10 账户管理界面** · 待实现 · P1 · installed：接入改密、登录策略等管理操作，提供明确取消/失败反馈和不含凭据的诊断信息。 前置：T14.7、T06.1、T14.8。 来源：M04.5。

#### T16 会话与服务可靠性

有界恢复/自启动/保存与资源释放；基础会话不等待完整共享迁移。

- [ ] **T16.1 Shell 生命周期** · 待实现 · P1 · installed：明确 Shell 正常退出、崩溃、重启及最终失败策略，不误杀仍正常工作的普通应用。 前置：T06.3。 来源：M11.1。 证据：用户已选择Shell崩溃默认最多自动重启3次、耗尽保留普通应用并明确故障/手动恢复，正常退出/注销/health-check语义分开；随后明确暂缓新的恢复基础设施，第四批改为图形账户入口/设置/文件功能。原子会话0f86311干净，仅只读研究，完整策略未实现，不阻塞本批用户功能。2026-10-15 已有真实 native Shell 断开/重连、普通 App 存活证据及 Live 首帧/90秒启动 supervisor；这些不等于安装版重试耗尽策略或窗饰独立服务完成。
- [ ] **T16.2 服务就绪与诊断** · 待实现 · P1 · installed：补齐 IME、网络、音频、通知等必要服务的就绪/失效诊断和受控恢复入口。 前置：T06.3。 来源：M11.2。
- [ ] **T16.3 有界重试与人工恢复** · 待实现 · P1 · installed：实现有界重试/退避、状态持有和人工恢复，失败显式提示，不增加无限后台循环。 前置：T16.2。 来源：M11.3。
- [ ] **T16.4 自启动与会话恢复** · 待实现 · P1 · installed：接通应用自启动、窗口/应用恢复及保存提示；恢复对象与代码版本合法，不能恢复陈旧或已卸载会话。 前置：T16.1、T13.1。 来源：M11.4。
- [ ] **T16.5 会话耐久与释放** · 待实现 · P1 · installed：验证反复登录/注销、Shell 重启、服务失联和进程残留/资源释放，并记录可导出的会话诊断。 前置：T16.3、T16.4、T15.4。 来源：M11.5。
- [x] **T16.6 窗饰与 Shell 解耦** · 已完成 · P1 · common/live/installed：WM 独立监督无窗口 GUI/JS 窗饰服务，Shell 仅发布主题/写偏好；分离私有连接角色、只读一次性冷启动引导、原子帧及有界故障恢复。复用既有 GUI/Canvas2D/font 与权限/FD 校验，实际证明无 Shell 的窗框和输入，不回退 C 主题 painter、隐藏窗或 WM 内嵌 JS。 证据：2026-10-15 盘点时窗饰仍在Shell内，失联仅协商CSD，不保证不会自绘客户有框。2026-10-16 用户要求推送后自主完成剩余，已合入d669ec9+83eda5f（源81858f44+f7522f84）并完成独立服务交付。WM私有连接固定publisher/renderer角色，appearance v4，公共JSON1/geometry4保持；不可逆WM会话latch与Shell prepare优先race gate约束一次性只读引导，Shell唯一偏好writer。通用pu_gui_service复用字体/无owner Document/Canvas和Wayland/dispatcher/timer/shutdown事件等待，无SDL/隐藏窗/testhost/固定tick；producer join后才关wake/VM。失联保最后完整已呈现帧，新geometry/revision等matching frame或显式失败，重连fresh revision及三次有界恢复。父已审authority/wait/shutdown/安装源码并亲跑精确新C+当前全部JS的windowless/privatepolicy/七场真实lifecycle：missing/cold/normal/crash/saved/corrupt/legacy，不建namespace/lock、不写偏好；App实际点击变色和窗框title/hover/pressed/resize/DPI/min/max/restore、CSD/frameless/fullscreen、冻结/kill/newPID恢复通过。最终父新binary5906e369的正常退出/真实旧v3server拒绝/预算耗尽不注销WM、relocated安装--check/缺launcher明确失败且不改偏好与Node89/89通过；安装manifest仅写父自有输出，源/子缓存只读。父实际发现SIGTERM打断frameACK误报非零退出，followup仅明确stopping返回false取消、Wayland read配对，意外transport仍报错；子严格七场全部exit0且无Framefailed诊断，父独立复验通过。native-shell-raster与既有C integration只精确迁移当前style/token、border中点及异步帧就绪屏障，保原像素/几何断言；CLI/安装/封装FD负例通过。软件raster证据不是物理GPU/Darwin或整六OS像素认证；本交付未重打ISO或改VERSION。

#### T17 基础网络与凭据

iwd、连接/忘记/重连、有线和 DNS；高级企业/VPN 不是基础网络门槛。

- [ ] **T17.1 私有网络状态** · 进行中/部分完成 · P1 · live/installed：实现 `SystemData/Network` 的 root 私有配置/凭据及 iwd 接入，按服务映射而非整体共享 `/var`，区分安装版与 Live。 前置：T04.3、T03.3。 来源：M12.1。 证据：32030d9→247a375与默认Containerfile.storage/fresh builder接线随ff4be97合并推送；明确installed UUID私有快照/正常停止checkpoint、Live临时；terminal RAM guard-release修复经36独立单测/私有真实mount与UID1000拒绝通过，新factory12及组合root注册2/2通过。只是源码和临时树，未构建新媒体；真实PID1/+namespace/即时落盘/断电/冷启动/物理网络仍待验收，完整T17.1保持进行中。独立报告950c85efc3a0fb8302816f47a56f723e52b7e4a1402e97a72314d1f5f15eb693。
- [ ] **T17.2 网络记忆与重连** · 待实现 · P1 · live/installed：连接成功后记住/重连，支持忘记网络，验证重启/维护/恢复、错误密码、失联和凭据权限。 前置：T17.1。 来源：M12.2。

#### T18 本地音频设备

本地播放/录音及设备路由，不把蓝牙完成当普通音频前置；软件和物理证据分开。

- [ ] **T18.1 音频设备与路由控制** · 进行中/部分完成 · P1 · installed：补设备/端口/profile 选择、音量和失联恢复，复用现有私有 PipeWire，独立于蓝牙发现/配对。 来源：M14.1。 证据：2026-10-15 盘点：e442596 已完成六页独立 Settings；真实普通用户私有 PipeWire 软件设备执行音量 90%、麦克风静音、默认 sink，回读确认后保存，新 PID 重开仍保留。设备/端口/profile 的完整选择、失联与实体播放/录音/插拔仍未闭环，因此不是完整 T18 或物理音频验收。
- [ ] **T18.2 扬声器麦克风验收** · 待实现 · P1 · hardware：指定实体扬声器/麦克风，验证播放、录音、插拔、恢复及延迟；软件模拟不冒充物理设备。 前置：T18.1。 来源：M14.1。

#### T20 文档打开保存

原生打开/保存、MIME 和默认应用及文档启动参数；不依赖文件 Portal 或完整管理员 UI。

- [ ] **T20.1 MIME 与默认应用** · 进行中/部分完成 · P1 · installed：正确的 MIME/默认应用/文档启动参数，区分可启动应用与可处理文档；复用注册/启动查询而非第二套应用数据库。 来源：M16.3。 证据：ac43e9f→1ae1444e及中央documents链接/双平台file、Debian magic、Python3依赖/夹具注册随ac5a5a5合并推送；复用现desktop registry，普通UID1000新编产品真实local MIME/默认关联/Exec argv/URI/cwd/env/FD/退出、标准D-Bus Open及迟到/FD/错误/共享队列/关闭断连均通过。不写用户默认设置、不猜MIME、不造PID或不确定后重试fallback；保留3000ms post-send/common同步setup界限。本地concrete type匹配不等于全shared-mime aliases/subclasses/远程协议/default-write/bundle MIME模型，完整T20.1继续进行中。最终native报告d4ec553edb9afa5c583e258140bc28fa63ace3ee97a1f0499612ff2ffab3739b。 当前本地 MIME/Exec/D-Bus Open 与普通 File Text --file literal 参数及用户 XDG 默认优先级已具。完整 shared-mime、远程 URI、默认关联编辑和 bundle MIME 扩展仍待完善，不因现有组件完成关闭全项。
- [x] **T20.2 原生打开保存选择器** · 已完成 · P1 · installed：原生用户选择、取消/错误和真实文件读写；不以假路径回成功，不等待第三方 Portal。 前置：T19.1。 来源：M16.3。 证据：第四批子会话fade3257-83ac-4381-a82b-b524b08390d1与文件管理器并行实现原生选择/导航/取消及真实打开读取、新建保存；共享FS由4b0f28e2唯一维护。用户批准首版既有文件覆盖确认与变化后再确认，未具备时明确拒绝而非假保存。选择器和真实读写/普通权限/原生交互验收待返回。 第四批当前原生选择器范围已实现并纳入 ce73a3c：严格 native arity、普通父窗口模态、打开实际读取、新建保存、强 SHA256 观察的现文件覆盖/变化重问、Keep/Cancel/焦点/关闭回收；独立源码与普通新引擎 window fixture 通过。不是完整文本编辑器、第三方 Portal 或新版集中手测已完成。

#### T21 基础 Shell 与应用 UI

启动器、菜单/托盘通知和应用管理 UI；高级效果、窗口策略、终端形态另列。

- [x] **T21.6 系统设置中心** · 已完成 · P1 · installed/live：可操作的统一系统设置窗口，接通现有外观、显示、网络、音频、快捷键与关于页面；复用已具备的控制器和真实权限，不以卡片/假成功替代用户操作。 证据：用户明确将第四批改为实际系统功能优先；固定0f86311，子会话47f514de-9e94-47a4-8ccf-05299e0676fe实现Shell连接拥有的普通设置窗口、持续导航和现有服务操作；显示确认/快捷键捕获继续使用现有受控层，不扩大普通应用权限。功能与实际原生验收待返回。 第四批普通设置中心六页导航与复用控制器已进入本地 main ce73a3c。固定 e879 的实际 UI16.27s/音频17.38s 与合格私有 PSK 网络关闭/重开、最少七张 UI/十张网络 app-buffer 门槛通过，父核对日志 SHA6ee5d39a。账户管理、物理音频/无线、原生 EAP、正式授权和 Hyper-V 首启图形稳定性不被此完成声明覆盖。
- [x] **T21.5 可信菜单外点关闭** · 已完成 · P1 · installed/live：为真实 Shell 连接拥有的专用临时菜单实现原生外点关闭，经 surface 生命周期清理焦点后将同一次按下交回正常输入路径；保留其它独占层和 session-lock 隔离。不增加普通应用 popup grab 或通用跨进程输入接口。 前置：T06.3。 来源：M17.2。 证据：历史 6487101 确认 foreign outside-press 缺口。2026-10-15 用户实际新版 Live 复现开始菜单展开时标题按钮被独占焦点拦截；最终采用受限 WM 生命周期关闭，而非另造通用事件或放松所有独占层。6618394/6298ff3 已合入并推送：菜单 full-output zone -1 消除重复 28px 边距；真实 Shell owner、专用 namespace、mapped/presented/overlay/exclusive 合同限定外点关闭。真实 GUI 四 strip caption 的最大化/还原/最小化/关闭、拖离取消、普通客户 wire 单次投递及 opt-in 客户 DOM 单击、非菜单独占负例通过。锁屏 guard 未变；普通 SDL 客户可按自身策略消费激活首击。原生 fixture 证据不冒充新 ISO/WSLg 可见交互验收。
- [ ] **T21.1 启动器与窗口联动** · 进行中/部分完成 · P1 · installed：应用图标、分组、固定、图标网格与任务窗口联动，不把包 icon 元数据视为 UI 已完成。 前置：T12.2。 来源：M17.1。 证据：2026-10-15盘点已有桌面App快捷方式/框选/内部排列和保存cbe4000/0881e09、真实任务按钮/三Dock/滚动区。后续31b7236补确切App分组和真实窗口chooser；8fd7af8/b97958c补既有安全PNG/JPEG资源到taskbar/Dock/Start/Apps，52e22dd补显式runtime身份+四内置原创图标/真实installprefix；113302a补独立persistent pins、当前catalog启动、running同槽/真实count、不可用键盘管理、v1/v2全域原子升级v3，search/oldcallback/权限不变。cca643e补固定槽内pointer hover强调，不是完整邻近动画。只在现套件补必要数据/行为契约，未以metadata本身冒UI完成。当前剩余完整共享包/SystemData权威注册依赖t12-m15-8仍pending、命名/SVG图标通用解析与更广原生验收亦未交付，所以本广项保持in_progress，不重新声称已交付分组/固定/位图显示全未实现。
- [x] **T21.2 菜单焦点与关闭** · 已完成 · P1 · installed：Shell 临时菜单点击外部关闭、焦点与跨 surface 事件、快捷键及误关闭回归；普通应用继续采用已选的窗口内菜单/对话框方案，不要求新增通用原生 popup grab。 来源：M17.2。 证据：历史 7c12e8→49b3e6d 的 owned-surface 生命周期与 stale callback 清理保留。2026-10-15 6618394/6298ff3 补齐可信专用菜单的 native 外点关闭、同次 caption/client 路由、真实 4px 任务栏衔接；实际 GUI/native 测试覆盖三键、按下拖离取消、launcher 不先关后重开、搜索/焦点/Escape、非菜单独占保护。普通客户 wire 下发一次，受控 SDL activation-click opt-in 客户实际 DOM 单击/绿色帧验证；不将默认客户自身激活策略强改。未承诺所有应用 popup 外点 API；当前源码已推送，修正版 Live b7e7a700 与 main 6298ff3 同 tree。
- [ ] **T21.3 托盘与通知** · 待实现 · P1 · installed：托盘主题图标/overlay/动画/tooltip 与通知历史、丰富内容/声音；确定隐私、容量和外部资源边界。 来源：M17.3。
- [ ] **T21.4 应用管理界面** · 待实现 · P1 · installed：补齐安装、替换、回退、退役/恢复管理 UI、版本/状态/空间展示和明确错误。 前置：T14.7、T12.1、T12.2。 来源：M15.1。
- [x] **T21.7 闲置窗口拖动与缩放** · 已完成 · P1 · live/installed：主题/纯位置刷新不阻塞已有当前缓冲的标题栏拖动与缩放；真正尺寸/模式/装饰协商仍等待最新 matching commit，保留输入/工作区/边界契约。 证据：功能源码固定 ce73a3c 已审并纳入本地主分支；直接既有 Core 集成 runner 3.77s 与 held-buffer/no-body-click 拖动、真实 resize release 回归通过，receipt SHA0513501b。2026-10-08 固定组合 ffc887f 的 PollyUI/PollyWM 已增量链接，复用字节一致的最新 Core，receipt SHA9f45bf17；已交付 e879 媒体未更新，集中新候选手测仍待执行。
- [x] **T21.8 高分屏显示缩放选择** · 已完成 · P1 · installed/live：在独立Settings的每个显示器草稿中明确选择100%、150%、200%，保留自定义比例、现有Apply/可信Keep-Revert及确认后profile持久化；核逻辑尺寸、设备像素和输入，不以只放大字体替代系统显示缩放。不包含所有物理显示器/驱动或原生Mac认证。 前置：T21.6。 证据：用户追加任务；bebe881合入每head 1/1.5/2快捷比例、custom125不假选、typed/paste/原+更新真值且保留input DOM/caret/selection。选择只改draft，Apply仍固定命令/serial与可信15秒确认，不自动Keep；19项Settings与38项profile检查及父actual GUI通过。私有真实Wayland输出使用历史只读WM+新GUI6a+当前JS：logical1280x720→853x480→640x360，普通400x240逻辑App backing400x240→600x360→800x480，80x32控件物理80x32→120x48→160x64，实际seat pointer和Enter每档各一次。此为真实虚拟输出功能证据，非整套native全量重编/物理HiDPI资格；window.displays().scale的SDL contentScale不被误当pixel density。未生成新ISO或改现有用户监视器。

#### T22 授权关机与重启

普通本地活动用户电源动作及保存/警告，不每次索取 root 密码；挂起休眠不混入该交付。

- [x] **T22.1 本地会话电源授权** · 已完成 · P1 · live/installed：设计并实现只允许所需动作的受限授权后端，核实 login1 对本地活动用户的实际授权而非仅消息放行。 前置：T06.3。 来源：M13.1。 证据：用户批准的标准 logind/polkit 精准授权已实现并实际部署到 4e6b004 两模式候选，pin polkitd/两 libpolkit 126-2；保留多会话/忽略 inhibitor/挂起等拒绝，工厂核资源原字节/权限/依赖/标准激活。普通 UID1000 真实 self 会话 Active=yes/Remote=no/Class=user/Seat0，两 Can 查询 yes，标准 system-bus GetConnectionUnixUser 明确 u0；installed native guarded 两阶段 Reboot 真产生 guest=true guest-reset 并可原密码登录，Live settled native PID/session/caps 可用。receipt SHAb2f62ede、32/33 Root资格原图已核，不是消息放行或 fakeprovider。实际 Shutdown GUI 未产生动作属于 T22.2 未完成，Live 仅能力状态无真实 power 执行/硬件资格宣称。
- [ ] **T22.2 关机重启与保存** · 进行中/部分完成 · P1 · live/installed：关机/重启确认、保存机会、其它会话/更新警告、取消及能力变化处理；普通操作不每次索要 root 密码。 前置：T22.1、T16.1。 来源：M13.2。 证据：源 4e6b004 的 guarded Power UI 已实际两阶段触发普通新 guest 标准 Reboot，QMP 仅收 guest=true/guest-reset(1791475112)，随后原密码 PAM 登录、Classic 偏好与原生 FileText 26字节文档读回都成功；App close-veto/取消/真实保存成立。Shutdown GUI 最终确认数次及一次有界取消重開仍 ready/NoSend，无 accepted 或 guest SHUTDOWN，未 Root/CLI/QMP替代或反复刷新采运气，不归因未实证权限拒绝。受限候选已交付 D:\Temp\PollyOS，receipt SHAb2f62ede；保持此任务未完成。后台 busy UI-only修复不改变 native PID/revision/pending/Root-owner/Can/sent guard，Live仅能力状态无实际动作。

#### T15 基本注销与保存

保留 Alpha 的普通会话退出与保存要求；锁屏、受保护 TTY 和认证组合移入后期优化。

- [x] **T15.4 注销与保存** · 已完成 · P1 · installed：注销提供应用保存机会并回到受保护登录入口，不遗留已登录 shell 或误结束其它用户会话。 前置：T14.2。 来源：M05.4。 证据：共享 native 真实窗口/进程/Activate 屏障、严格标准入口与 SDL/Win32 close-veto 原语已实现，2f91cef 外部符号缺陷已修并实际链接。2026-10-09 正常用户注销经确认返回真实 greetd/可再登录；4e6b004 普通 managed App 收 close 后 boolfalse 保 1window/1process、common/app Cancel 保会话、nativeFS 真保存后正常关闭；标准 Reboot/PAM 登录后原生 chooser/FileText 真读回 /home/polly/alpha-smoke.txt 的 26 字节完整 normal-user-saved-document。父核实图/最终61项证据，receipt SHAb2f62ede。未 kill/TerminateSession/Root broker，发行盘不带测试 App/账号状态；无新 full editor、其他用户权限或 Hyper-V 现场认证宣称。

### R6 外置可用开发候选 — 进行中/部分完成

**交付/边界：** 安装器在明确授权的目标可靠写入；按选定硬件逐项证明日常使用、维护/恢复及耐久，分发物料与确切候选对应。开发候选不冒充生产签名或全硬件认证。


#### T24 安装器与写入安全

虚拟装配不等于实际设备安装器；逐次核对目标、范围、来源和确认，任何真实写入仍需单独授权。

- [ ] **T24.6 目标展示接入** · 进行中/部分完成 · P1 · fresh/hardware：把已实现只读目标报告接入安装UI，显示稳定身份/容量/分区/假定清除范围和具体拒绝理由，重新识别结果用于后续显式确认；不把 eligible 标记当写权限，不部署到错误layout路径。 前置：T24.1、T24.2。 来源：M07.2、M07.4。 证据：第三批ac5a5a5已合并推送：4124fb8/9f9c1a5→93be9483/b12147fe及中央接线完成固定普通用户只读native provider、4个相邻Python文件/6个生产JS部署；8s完成前严格期限、子进程/FD清理、新报告generation/实际窗口滚动指针确认取消及关闭迟到保护通过。生产默认pending，显式缺source.json显示失败而非空成功；私有collector/helper测试与生产binary分证。实际可信offline来源producer/source.json/支持介质及exclusive broker/writer仍缺，不关闭完整T24.6，不以root所有权或UI kernelBasis授予写权。最终报告d4ec553edb9afa5c583e258140bc28fa63ace3ee97a1f0499612ff2ffab3739b。
- [x] **T24.1 只读目标身份模型** · 已完成 · P1 · fresh/hardware：只读枚举/输出型号、容量、稳定serial/WWN、分区与假定清除范围；选择绑定及重新识别对缺失/歧义/活动来源/热插拔改变拒绝。JSON/CLI资格不等于UI确认或写权限，真实展示接入由T24.6完成。 前置：T03.1。 来源：M07.2。 证据：e3b74df→be85a42→最终a5已合并推送；34合成CLI/sysfs/graph/边界/重识别测试及组合CTest通过。未实际探测host盘、尚无writer/UI确认/独占raw opener或其它namespace证明；仅USB/sysfs外部来源floor，未知overlay/loop fail-closed。
- [x] **T24.2 内盘排除与防误选** · 已完成 · P1 · fresh/hardware：当前只读模型排除三块已知内盘型号/family及root/boot/source/活动holder/swap祖先，对身份缺失/冲突/热插拔改变拒绝；不按sdX/nvme号或RM布尔挑选，实际writer独占与确认仍后续。 来源：M07.3。 证据：与targets只读实现同一e3b74df/a5固定组合；型号alias、大小/重复ID、dm祖先/改变identity/diskseq/歧义拒绝fixtures通过；真实设备/其它mount namespace/raw opener与破坏性安装验收不由此替代。
- [ ] **T24.3 写入确认与取消** · 进行中/部分完成 · P1 · fresh/hardware：提供写入前明确确认、进度、取消边界和失败反馈；安装源/当前运行盘不得被误覆盖。 前置：T24.1、T24.2、T24.6。 来源：M07.4。 证据：ff4be97只读UI组件及ac5a5a5固定native provider组合已合并推送；普通UID1000真实指针选择/范围ack/fresh native generation/确认/取消/实际WMclose终止pending transport且迟到状态不复活通过。确认始终readOnly=true/writeAuthorized=false；数据来源为明确private collector fixture，不认证生产来源。实际writer/安装进度/写入取消/介质授权/exclusive证明未完成，不关闭完整T24.3或写盘gate。第三批最终报告d4ec553edb9afa5c583e258140bc28fa63ace3ee97a1f0499612ff2ffab3739b，第二批证据保持原SHA。
- [ ] **T24.4 安装失败与中断** · 待实现 · P1 · fresh/hardware：验证空间不足、写入/校验失败、拔出及中断；不发布虚假的安装成功或自动扩大写入范围。 前置：T24.5、T24.3。 来源：M07.6。
- [ ] **T24.5 新装与迁移流程分支** · 待实现 · P1 · fresh/hardware：实现目标安装流程并区分 fresh 与 migration：新装生成锁定模板/首启；迁移先资格与事务发布，不覆盖已有 Accounts/HOME，不由状态缺失猜测该重置。 前置：T03.4、T24.3。 来源：M07.1、M01.7。

### E01 蓝牙设备可连接 — 待实现

**交付/边界：** 独立完成选定蓝牙后端、发现、配对确认、连接/断开/忘记；不阻塞本地音频。

- [ ] **E01.1 蓝牙发现配对连接** · 待实现 · P2 · installed：选择蓝牙后端并实现发现、配对确认、连接、断开、忘记和失败反馈。 来源：M14.3。

### E02 蓝牙音频可用 — 待实现

**交付/边界：** 使用已验证蓝牙连接和音频路由；不是要求普通扬声器全硬件矩阵先完成。

- [ ] **E02.1 蓝牙音频与重连** · 待实现 · P2 · installed：实现蓝牙音频 profile/路由切换，验证输出、麦克风、重连及服务失效。 前置：E01.1、T18.1。 来源：M14.4。

### E03 安全挂起与唤醒 — 待实现

**交付/边界：** 仅在锁定/恢复及所选硬件通过后开放；普通关机不等待本项。

- [ ] **E03.1 锁前挂起与唤醒** · 待实现 · P2 · installed：锁定确认完成后才能挂起，唤醒仍需密码；验证锁进程失败、设备恢复和多显示器覆盖。 前置：T15.3、T15.6、T16.2。 来源：M13.3。

### E04 可选休眠 — 待实现

**交付/边界：** 休眠存储/恢复和盖子/电源键策略独立验收，禁止隐式内盘 swap；实际介质操作另授权。

- [ ] **E04.1 休眠与硬件电源策略** · 待实现 · P2 · installed：先在可丢弃虚拟目标验证休眠所需存储/恢复与取消失败；设计不等待真实盘授权。盖子/电源键/空闲策略在指定硬件和认证链路验证后才开放，不隐式启用内盘 swap。 前置：E03.1。 来源：M13.4。
- [ ] **E04.2 休眠介质与硬件验收** · 待授权/待决策 · P2 · hardware：在明确授权的存储/硬件上验证实际休眠与恢复、盖子/电源键及所选策略；虚拟结果不冒充 USB/实体机证据，不越过内盘排除范围。 前置：E04.1、授权。 来源：M13.4。

### E05 可选用户卷加密 — 待实现

**交付/边界：** 明确选择后实现加密/解锁/恢复材料；默认不启用，不阻断未加密开发版。

- [ ] **E05.1 可选用户卷加密** · 待实现 · P2 · installed：独立实现可选用户卷加密、启动解锁、密钥/恢复材料保存及更新/回退兼容；默认不自动开启。 前置：T09.4。 来源：M10.4。
- [ ] **E05.2 解锁故障与材料** · 待实现 · P2 · installed：验证丢失解锁材料、错误密码、取消、卷损坏和自动登录组合；不提供隐藏万能密钥或绕过解锁。 前置：E05.1、T14.5。 来源：M10.5。

### E06 第三方音频兼容 — 待实现

**交付/边界：** 验证所选 PulseAudio/ALSA 客户端的真实播放/采集，不把安装库视为兼容完成。

- [ ] **E06.1 第三方音频兼容** · 待实现 · P2 · installed：实现并验证 PulseAudio 客户端兼容及所需 ALSA 重定向，第三方应用确实能出声/采集。 前置：T18.1。 来源：M14.2。

### E07 高级网络配置 — 待实现

**交付/边界：** 隐藏/静态/企业网络按各配置分别验收；不能以该整组阻断基础已支持网络。

- [ ] **E07.1 隐藏静态与企业网络** · 待实现 · P2 · installed：补齐隐藏 SSID、静态 IP、企业网络与证书配置，不关闭证书校验。 前置：T17.1。 来源：M12.3。

### E08 文件选择 Portal — 待实现

**交付/边界：** 第三方文件选择调用、授权/取消和实际文件使用闭环；原生选择器不等待本项。

- [ ] **E08.1 文件选择 Portal** · 待实现 · P2 · installed：明确首批文件选择 Portal 协议范围，实现第三方调用、取消/错误及真实文件使用闭环。 前置：T20.2。 来源：M16.4。

### E10 辅助技术可用 — 待实现

**交付/边界：** 所选 Linux 辅助技术真正读取语义/焦点/动作与文本；键盘测试不是辅助技术验收。

- [ ] **E10.1 无障碍与辅助技术** · 待实现 · P2 · installed：语义树、焦点/动作/文本、屏幕阅读器及 Linux 辅助技术集成，验证实际辅助技术而非只测键盘。 来源：M19.3。

### E12 主题与输入法一致 — 待实现

**交付/边界：** IME 跟随与深色变体按受限主题契约验收；不无限扩展模板/字体加载范围。

- [ ] **E12.1 输入法与深色主题** · 待实现 · P2 · installed：IME 主题跟随、深色变体和现有主题深化；任意模板、自动监听、字体文件扩展先定义受限契约。 来源：M17.4。

### E14 深度文本输入 — 进行中/部分完成

**交付/边界：** 文字方向/字素、断行/caret 与真实 IME 上下文分别验收；不伪造主机 API 能力。

- [ ] **E14.1 文字方向与字素** · 进行中/部分完成 · P2 · installed：标题 shaping/bidi、字素安全省略及语义；补齐正文段落方向/locale、bidi、视觉光标 affinity。 来源：M18.1。 证据：2026-10-15 5bb181c 已将 native caption 文本迁移至现有 GUI Canvas2D，复用 Linux HarfBuzz/ICU shaping，不再维护 WM 的独立字体缓存。caption 当前省略按 Unicode code point 截断，尚非 grapheme-safe；完整 bidi/locale、视觉光标 affinity 和其它平台 shaping 仍待完成。
- [ ] **E14.2 高级断行与光标** · 待实现 · P2 · installed：字体连字 caret、高级断行/断字及匿名输入控件选择/剪贴板编辑，保留已实现稳定 ID 路径。 来源：M18.2。
- [ ] **E14.3 输入法上下文** · 待实现 · P2 · installed：改实际主机/输入链路实现 surrounding-text/delete-surrounding 和 Rime 上下文消费，不伪造 SDL API 能力。 来源：M18.3。

### E15 跨应用输出传输 — 进行中/部分完成

**交付/边界：** 输出拖放/offer/动作和接收阶段峰值内存有界；触摸/剪贴板历史是未选方向。

- [ ] **E15.1 输出拖放语义** · 进行中/部分完成 · P2 · installed：补齐向外拖放、offer、动作协商与 DataTransfer 语义，明确取消/拒绝及传入文本自动插入规则。 来源：M18.5。 证据：2ef182f 已交付公共 GUI 原生拖放合同和首个 Wayland 普通窗口 COPY 后端，原生 27 场景包含实际 JS 发起、接收、取消/拒绝、GC/关闭与连接丢失。Windows OLE、macOS/X11、MOVE、自定义拖拽图、Shell-layer 来源及传入文本自动编辑仍不属于已完成范围；没有因为首个 COPY 后端通过而关闭整项。
- [ ] **E15.2 传输峰值内存** · 待实现 · P2 · installed：接收传输阶段限制内存和大载荷，测峰值内存而非只在收完后检查长度。 来源：M18.8。

### E21 可选应用沙箱 — 待实现

**交付/边界：** 先选择 OS 权限/隔离模型和 Portal 边界；不宣传同 UID 数据目录为沙箱，不成为首版统一前置。

- [ ] **E21.1 沙箱与权限模型** · 待实现 · P2 · installed：选择应用沙箱/兼容打包/权限模型及 Portal 联动；未完成前不宣传同 UID 目录、socket 或 UI 提示为 OS 隔离。 来源：M19.5。

### C1 未选方向登记 — 待授权/待决策

**交付/边界：** 候选不是承诺交付的里程碑；指定目标/范围并批准后才拆出执行任务，不给 R1–R6 添加硬前置。

- [ ] **C1.1 VPN 后端** · 待授权/待决策 · P3 · candidate：选择 VPN 后端/权限及 UX 后立项，不默认引入另一套网络策略。 来源：M12.5。
- [ ] **C1.2 高级窗口行为** · 待授权/待决策 · P3 · candidate：贴靠/平铺/overview/手势先选择具体行为，保持手动全局工作区。 来源：M17.6。
- [ ] **C1.3 终端形态** · 待授权/待决策 · P3 · candidate：普通/Server/Client 入口与 shell 策略先选；不擅自换 bash/zsh 或启用服务。 来源：M17.7。
- [ ] **C1.4 其它输入引擎** · 待授权/待决策 · P3 · candidate：按真实语言选择引擎，保留可信 IME 与敏感字段隔离。 来源：M18.4。
- [ ] **C1.5 触摸拖放** · 待授权/待决策 · P3 · candidate：只有选择多点触摸协议/设备后扩展动作与取消；不阻塞普通指针传输。 来源：M18.6。
- [ ] **C1.6 剪贴板历史** · 待授权/待决策 · P3 · candidate：先决定历史/退出保留、敏感清除和限额，再实施后台管理。 来源：M18.7。
- [ ] **C1.7 更多硬件支持** · 待授权/待决策 · P3 · candidate：按明确新增设备扩展矩阵，不承诺未测组合。 来源：M20.3。
- [ ] **C1.8 测量驱动优化** · 待授权/待决策 · P3 · candidate：按 E16 数据选择裁剪/增量渲染/调度投入，不预设优化结论。 来源：M20.6。
- [ ] **C1.9 持久化 Live** · 待授权/待决策 · P3 · candidate：本次只改变普通 Live 账户；持久化 Live 独立候选，避免默认第二套安装器。 来源：M22.1。
- [ ] **C1.10 ARM64** · 待授权/待决策 · P3 · candidate：指定 ABI/依赖/启动与设备后立项，不能复用 x86 产物。 来源：M22.2。
- [ ] **C1.11 Tiny Core 暂缓** · 待授权/待决策 · P3 · candidate：只有重新选择底座才启动，不平行长期维护三套发行版。 来源：M22.3。
- [ ] **C1.12 多点触摸与手势** · 待授权/待决策 · P3 · candidate：指定设备、系统手势和协议取消语义，再协调触摸拖放。 来源：M22.4。
- [ ] **C1.13 HDR 与 VRR** · 待授权/待决策 · P3 · candidate：指定硬件/色彩/呈现链路并独立测量，不因 Mesa 存在宣称支持。 来源：M22.5。
- [ ] **C1.14 远程桌面** · 待授权/待决策 · P3 · candidate：独立选择采集/输入/会话授权与传输范围；与打印分开立项。 来源：M22.6。
- [ ] **C1.15 打印** · 待授权/待决策 · P3 · candidate：独立选择发现/配置/权限和真实设备；不与远程桌面共用一个完成判断。 来源：M22.6。
- [ ] **C1.16 Windows Shell 暂缓** · 待授权/待决策 · P3 · candidate：独立测试账号/VM与恢复后才可能重启，不修改 DWM。 来源：M22.7。
- [ ] **C1.17 PollyUI 跨平台** · 待授权/待决策 · P3 · candidate：macOS HTTP/目录、iOS/Android 生命周期/打包、bare Wayland/DRM 各按目标立项，不整体变成 PollyOS 发布门槛。 来源：M22.8。

### H0 D1 历史基线 — 已完成

**交付/边界：** 保留旧 A/B 产物/范围与证据，仅作回归或迁移来源，不转化为当前可写单系统验收。

- [x] **H0.1 D1 基线 1** · 已完成 · history · common：生成 GPT、256 MiB EFI、独立 ext4 A/B 系统槽和至少 2 GiB 用户卷的普通镜像文件。 来源：M00.1。 证据：617cea4；persistent-d1-boot-r2/smoke 的原始 sourceDirty 与关机范围保持。
- [x] **H0.2 D1 基线 2** · 已完成 · history · common：按 UUID 要求用户卷挂载，普通 UID 1000 启动原生桌面；各槽保留独立系统/包数据库。 来源：M00.2。 证据：617cea4；persistent-d1-boot-r2/smoke 的原始 sourceDirty 与关机范围保持。
- [x] **H0.3 D1 基线 3** · 已完成 · history · common：A/A/B/A 四次冷启动，实际设置、应用注册/AppData 和文档连续保留，测试镜像各轮正常关机。 来源：M00.3。 证据：617cea4；persistent-d1-boot-r2/smoke 的原始 sourceDirty 与关机范围保持。
- [x] **H0.4 D1 基线 4** · 已完成 · history · common：正常镜像不包含验证 fixture；单次原生桌面启动预检通过，不冒充正常关机或持久性验收。 来源：M00.4。 证据：617cea4；persistent-d1-boot-r2/smoke 的原始 sourceDirty 与关机范围保持。
- [ ] **授权 外置介质写入** · 待授权/待决策 · P2 · hardware：用户指定目标稳定身份/型号/容量与写入清除范围；三块排除内盘禁写，批准一次具体范围才解除。 证据：用户将授权外置安装/相关硬件复测推迟；此授权仍未授予，不成为 Alpha 虚拟介质交付前置。
- [ ] **授权 远端 CI 执行** · 待授权/待决策 · P2 · release：实际运行远端 CI、改变其权限或增加触发动作仍需具体范围。2026-10-15 用户授权的当前 main 代码签入/推送已执行；这不自动授权新 CI 工作流、Mac 主机或生产发布。本地配方验证不需要该授权。
- [ ] **授权 生产密钥与发布** · 待授权/待决策 · P2 · release：生产信任根/私钥操作与对外发布先选身份/渠道并获得具体授权；测试身份不等同生产授权。
- [ ] **授权 外置故障测试** · 待授权/待决策 · P2 · hardware：指定可丢弃数据、介质和拔出/掉电/满盘测试范围后才执行；安装写入授权不自动包括故意中断和故障注入。 证据：用户将授权外置安装/相关硬件复测推迟；此授权仍未授予，不成为 Alpha 虚拟介质交付前置。

### 历史证据与当前产物边界

- 2026-10-08 Alpha 范围重排：延期项目保留来源和状态，不因移出 Alpha 假标完成；代码 main=ce73a3c，已交付 ISO/VHDX仍 e879，未来集中新候选才携当前修复。
- 当前 Live 体验 ISO：677,996,544 字节/SHA256 d52d36a3627831ac93767a83bb13f96bffe43c41b00150542a7903484154287f，QEMU只读光盘实际桌面，PNG fd2d4a880650fdc2363945dba224385f0c1e9f268386f3539c2bb1d0152ef09c；无空白盘安装器、临时数据、公开开发密码，不用它解释用户 PollyOS installed 问题。
- 当前未初始化 VHDX：1,692,401,664 字节，虚拟容量3,568,304,128，SHA256 a0849d5dc0836193c6f56e4bebee2abf8954288463c069a85d5052d0effdb858；用户 Hyper-V 控制台首次设密与 installed 桌面已观察，但首次图形登录/重启差异原因未确认，未读取凭据，不能反向当完整 fresh 图形验收。
- Live 新策略 r2：`dist/pollydesktop-live-profiles-r2`，来源 `997587b` 且 sourceDirty=1，ISO 677,810,176 字节；`build/live-profiles-r2-boot-slow-input/run/result.json` 为普通 UEFI/TCG 图形/中文/剪贴板/工作区通过；`build/live-profiles-r2-public-maintenance/public-profile-diagnostic.log` 验证根 0755、公开 root 凭据及普通 UID1000 的标准 su。第一次 TCG 高速输入超时记录不覆盖；加速器感知键间隔仍要求真实标记通过。
- Live 新策略 r1：`dist/pollydesktop-live-profiles-r1` 复用固定锁定载荷，sourceDirty=1；`build/live-profiles-r1-boot/run` 保留失败。TCG 公开凭据诊断 `build/live-profiles-r1-diagnostic-tcg/public-profile-diagnostic.log` 确认内存根目录实际为 1777，新守卫拒绝，尚未通过桌面启动。init 与 CPIO 现明确 0755，继续独立 r2，不放宽父目录检查。
- 新 profile 镜像阶段完整断网构建曾因软件包层缓存未命中失败；之后以明确固定旧锁定载荷、无 apt 的 `Containerfile.profiles` 完成平台/Live 层和载荷检查。它拒绝已有预设/配置密码的来源，原镜像标签不改写。缓存复用不冒充完整包重建；独立救援尚未可启动。
- 历史 D1：`617cea4`；`build/persistent-d1-boot-r2/result.json` / smoke，A/B 范围与原 sourceDirty 不改写。
- 存储组件：`07e1692` / `aacde4c` / `a0a4e1c`；early usr/必需映射 namespace 不冒充整机或断电验收。
- 普通单系统 r2：来源 `9e89f8c`，raw 3,468,689,408 字节，SHA256 `4e1c0f7b16311baf5901e5b5a5009bcdc2679c7b6015d6668648d34defe38c84`；Recovery 仍 reserved-not-bootable。`build/single-system-smoke-r2/run/result.json` 的 QMP 退出不是正常关机。
- 认证连续性：`build/single-system-account-persistence-r2-attempt3/run/result.json` 三轮正常关机/冷启动；前两次时序失败与 r1 `/var/tmp` umask 失败证据保留。
- HOME：`21517ca` / `fa6763a` / `b8a9a4e` / `cbf128f` / `e7c4ea3`；v2/v3/v4 managed 结果分别保留，1→2 不等于共享注册/额外用户 PAM。
- 账户导入：`94c23cd`；真实 readonly tmpfs/PAM/su/passwd，fixture 仅适配卷发现。新工具未装入现有 r2，不宣称迁移镜像/ext4耐久已经通过。
- 以上已完成只指各子项的准确组件/产物范围；当前策略候选、独立救援、正式签名和真实外置写入仍需对应新证据。
- 2026-10-15 盘点：main 6298ff3 已正常推送；最新 Live b7e7a700/tree9c129e2 与其内容一致，固定 D:\temp\PollyOS\PollyOS.iso 真硬链接。历史备注中的当前介质、尚未推送等词只属于原记录日期，不覆盖本条和 Alpha 节最新证据。
- 已交付并从剩余项去重：六页独立 Settings、JS iwd、基础 Files 和单普通文件同 FS 移动、只读 Processes、桌面快捷方式/框选、Canvas2D/Image、Win/Linux 有界 WebGL2/WebGPU、GUI 窗饰与 Classic 边线/纹理、Live 启动与固定路径媒体发布。它们各有明确子集，不能因此关闭共享包、多用户、物理设备、完整浏览器兼容或整系统验收。
- 新发现待设计项：无 Shell 仍有完整系统窗框；当前只保证 App 存活，CSD 协商不保证不会自绘的客户有边框。独立窗饰服务尚未授权实施。其余明确待验项包括旧 Shutdown GUI/长输入失败、当前 installed 策略联合验收、真实 Mac/物理 GPU 与完整二进制发行履约。
- 本次签入/推送授权不解除远端 CI、生产密钥/公开发布、外置介质写入或故障测试的独立授权门槛；保持它们为待决策/受阻，不自动启动延期功能。
- 2026-10-15 六主题差异逐项登记：保留原E22/XPLuna三个IDs，扩为XP/Classic/Win11/Tiger/Lion/BigSur及共享字体/图标/控件/真实状态的35个条目；已修复7项单列完成记录，余项区分部分实现、明确缺失与参考不足。不把所有待核对区域都伪称已有确定像素bug，不重新打开已修Classic纹理/边线/布局/菜单输入，也不自动开启blur/materials/品牌素材或全六主题测试。
- 后续本地有界E22.7交付：a1dcab3/52383ab/1130278/623e1df完成只读Document owner、独立bounded state observer、普通Proxy属性语义与Canvas弱owner/owner-free finalizer token；真实关闭focus/plain/panel对象均可GC，live detached Canvas实际unsubscribe，live-GC后两帧host-only resize和原五图bytes保持。632953f保Appearance原focus wrapper而不恢复bevel/gloss，Classic卡focus0→335px、blur0差；retained ring175/Canvas176按真实clip绘四边全0缺点且backing不缩。E22.8只读核SDK六类选择控件确已存在，但Settings导航/Appearance是selected command按钮，不把此修复当checkbox/radio/tabs全主题认证。
- 新增两项用户要求已落源码：每显示器100/150/200系统缩放，以及只读任务管理器响应/采样性能，分别有UI/真实私有输出和GUI/真实proc证据；历史Live硬链接仍b7e7a700，未以本地代码提交冒称新介质已生成。源分支仍未推送。
- 扩展检查保留两个精确基线红项：module-boundaries的旧configureAppearance(theme)静态regex，与Files专用fake DOM缺querySelector；均在未改基线上复现，未为新功能隐去或修改生产guard。定点相关测试通过不表示所有历史suite全绿。
- 2026-10-16 推送进展：79b88ed及此前23个本地提交已正常推送并核远端一致，之后桌面标签b7f2916也已审查、定点实测并正常推送。前条源分支仍未推送仅属原记录时间；最新ISO依然b7e7a700，没有把新源码提交冒称新媒体。当前继续SDK选择控件、Classic所有程序、独立窗饰服务与最小MT02壁纸派生客户端材质；MT03跨应用采样、完整品牌/字体/OS像素与外部硬件资格不因此标绿。
- 2026-10-16 本批具体交付已闭合：桌面标签、Classic flat All Programs、SDK六选择控件及两项真实review修复、可选壁纸派生opaque client材质、无Shell独立窗饰及干净退出/安装闭环。前四项已推至7bf4538；窗饰核心d669ec9/收尾83eda5f与本条状态一并正常推送。长期E22仍按局部证据partial，物理GPU/Mac、字体/品牌资源、完整OS像素及MT03不冒称完成；未更新ISO、VHDX或VERSION。
- 2026-10-16 08:34 共通先行批已闭合：单一公共owner合7169e5a/4281df3/31044cd，统一按钮物理状态与激活、所有现选输入消费者完整appearance和真实选区文字；不相交caption876d126统一六主题字素截断/显式合法系统字体，默认原图保持。然后唯一Windowsowner合9c83846修Luna焦点完整四边，直接复用公共Canvas/owner/FR不另造实现。父最终Node140/140、Win原生像素/消费者及nativeResize/GC、Linux真实ICU/bidi/彩色emoji选区和caption通过；静态边界精确区分已移除native.setAppearance与合法input.setAppearance，未放松旧C painter/协议拒绝。用户不可用时协调者按快速收口决定新原生合成效果留下一批，未声称用户点选，圆角/阴影/跨Appblur和OS参考/业务缺口仍保留；本批不重打ISO。
- 2026-10-16 09:44 后续共享原生批已完成圆角/外阴影基础：先真实源码判定stock scene API不足，再批准单一固定wlroots补丁，唯一native owner实现分组AA、非input阴影及SDK/release严格配套；合6b9f0e9/4603005/1f670dd，E13及E22.23保留后续效果/样式资格而非全关。旧theme默认none，显式nativeEffects启用；private6/schema6和effects ABI2需同套重建，旧stockSDK明确拒绝，Alpine现入口明确未支持。父精确最终库/补丁哈希与真实生产windowlessdecorator coldmissing/normal收尾通过，代码不再有活动writer；只资格Pixman原生及软件GLSL原语，不冒完整WM GLES/DRM或物理GPU。未更新ISO/VHDX/VERSION，区域背景模糊仍独立待做。
- 2026-10-16 可见界面续批：9ed4ae1合de7ea1e令Settings框架/About/Keyboard字号与留白接已有token、Audio窄页控制换行，保page196/min142/42/max900与所有输入/事务。2781a6e+56d7ae6合b97958c，将已有受限bitmap资源接Start与Mac generic Apps同尺寸图盒，当前查询前100与shortcut/task并集retain，菜单关闭释放extra、异步ready重画当前menu；无新resolver/素材/权限/AllPrograms布局变化。98279b7补Files Places/Properties/empty-state排版与Power bounded root/wheel，安全shutdown逻辑不变。按用户规则未新增App测试/场景/矩阵/receipt，只复用现有Settings20、menu47、Power/Files40项；旧Power mock仅补真实querySelector标准能力、无新增case。低频fractional布局问题留独立非阻塞Bug，vendor候选38b+a0未合入；本批不重建native、媒体或更改OS设置，也不冒真实注册图标端到端/原OS像素资格。
- 2026-10-16 桌面弹出界面批：cdedb3c合eb2245e统一窗口操作/工作区/桌面快捷方式管理/窗口切换四菜单的既有panelViewport和主题字号，工作区行换行、原namefield挂载/ID/所有callbacks与switcher serial不变。b9bbf5f合c592166将tray菜单接shared command/selection ink与同滚动外框，保原submenu/toggle/itemRevision/nativewheel；父仅删除非toggle menuitem多余aria-pressed。856c0ca补notification bounded viewport、message/actions纵横wheel、应用名让位Dismiss，Appearance画廊标题/标签/状态/间距接原token而illustration/tile166/focuswrapper不变。复用既有workspace/menu/Settings合69项与syntax，无新App测试/场景/框架，无原生suite/真实notificationDBus资格冒称。低频Bug继续停放，未改Native/C/SDK/schema/协议、未重打ISO。
- 2026-10-16 应用身份与实际资源续批：370fcc9合52e22dd增加可选显式X-Polly-AppId，bundle直接取validated manifest.id；共用匹配helper exactcatalogid优先/显式唯一才采用/冲突保rawfallback，修内置org.pollyui.*与polly-*.desktop不一致造成任务label/图标不能关联，不猜名称/后缀，不改groupkeys/launch权限。四个Polly原创64px PNG与可再生成几何源已交付，五desktop声明真实wrapper ID与安装期Icon；actual CMake安装规则在独立目录验证--prefix覆盖后所有Icon仍指向同PNG，保原safe decoder/budget，不新增resolver/native/build/VM。既有及必要数据身份契约60项通过；不是新App样式测试或商业OS图标认证。7156719令Files Properties名字/完整path/link复用现readonly rawtext viewport，值与操作不变。真实搜索输入消费继续独立推进，本条不宣称已完成；非阻塞vendor Bug继续未合入，媒体未更新。
- 2026-10-16 搜索与常用操作续批：d778768+d343222合b9ada0f/2a678a5将生产Start/Apps搜索接现SDK真实输入，保currentMenu/ownerwindow/原32或24高度、ID/query128/first100/launch权限，支持caret/选区/Delete/剪贴板/IME并在refresh/theme变更保同DOM，composition占位hint不重叠、关闭清空并拒旧回调。SDK可选maxLength只在原replaceSelection裁插入且保suffix/caret，初值/setter同bound、缺省不变；父原输入39和相关菜单/功能87及hint47通过，现实际productionShell软件GUI入口再过中间编辑/refresh选区/真实preedit Enter拒绝/normalEnter1，无OS launch。6a5bd57补Files CtrlF当前folderfilter/CtrlShiftN原新建确认/AltEnter属性，保modal/composition/AltGr/repeat/身份守卫，dddf738将原filter128上限接同输入引擎而不在事后回滚caret；现Files34通过。这是输入/键盘功能，只有既有套件必要行为契约，无新增App样式测试文件或矩阵。独立持久taskbar/Dock pins仍在产品整合，不因model checkpoint就标已交付；原生Bug停放且媒体不变。
- 2026-10-16 Files路径复制：0454c97合62c3bf9，通过现clipboard.writeText能力注入提供Properties/context/非编辑CtrlShiftC三个入口，同一controller按selected generation/identity复制原样literal path，成功显式message、关闭context/保Properties并退休旧callback；缺能力禁用，写失败report且保ready目录/selection/Properties。只复制文字不读写文件，不冒文件剪贴板copy/权限桥接。现Files37项以inert clipboard验证Unicode/quotes、一次动作/旧身份/compose/modal/repeat/无FS，未触用户真实clipboard；无新测试文件或环境矩阵。
- 2026-10-16 独立固定应用：aa0cdbd/8c9d7ca/7d1a9aa合113302a，Shell配置v3新增launchers v1有序≤32catalog引用，与desktop v1独立；v1/v2沿原atomicwriter一次保全域迁移、未知版本不写空默认、旧reader回退边界有明确文档。Modern/三Mac及applications optin支持Apps Taskbar+/Dock+与真实RootMenu Pin/Unpin，零窗launcher走当前catalog/原SettingsBridge，唯一关联真实group同槽/count；missing/unavailable仍可Tab/ContextMenu管理，旧手势/成员/workspace/callback/重复IME activation拒绝，无fake Window.id/MRU/drag排序。实际displaycount/width/cache同model，Settings synthetic名称与真实注册关联分层，Unicode/空格opaqueID不猜suffix。父组合145项通过、现Python fixture仅AST语法和JS安装fixture仅syntax，未冒跑native矩阵；子一次旧911软件GUI看新idle/count2/missing槽及独立控件，非物理DPI/真实持久WM端到端资格。父补decorator-installed版本期望3及synthetic Settings位图保留/映射。原native Bug未合入、未更新SDK/ISO/C/权限；E22广项不因此全关。
- 2026-10-16 共享原生能力的预设采用：38fca16/29a338f合0c39dca/366a392，仅Modern明确rounded/原radius8/shadow0、三Mac明确rounded-shadow/原radius6/5/10与shadow20/18/24，JS旧policy编成sigma10/9/12、active24/inactive12、black，未改数值/颜色/布局或C/renderer/ABI/schema，Classic/XP与custom missing/none路径保持。只更新现policy契约和生成test几何；Node5+generatorcheck、Windows911当前生产caption producer/missing-none逐byte兼容过，历史冻结native机制资格不改写。本次只读Linux入口无首marker导致scene/caption均未执行，新的live WM/default-preset复验单列blocked任务，无新hash核验或GPU/OS原图资格宣称；不为数据采用重建环境。矩形input、max/full/CSD/frameless排除合同、paired effectsABI2/private6前提原样，未做glass/vibrancy/倒影或更新媒体。
- 2026-10-16 Dock悬停范围选择：用户ask_user当前不可用并委托自主决策，协调者选固定槽内pointer-only/无动画（非用户逐项点选）。afcb7ef合cca643e仅原art paint-space scale，optional dockHoverPercent整数100..125/缺100，三Mac120；真实slot/clip祖先/body交集夹限，40可画48或空间不足46/1，marker/count/input/所有layout不改。共享弱controlStates及现bounded settling处理clock/retime/scroll，无新RAFloop/observer。父补VNode baseline scale1以防DOM跨分支复用带旧zoom，组合143+现原transform6通过；子一次软件GUI入口验证同DOM/盒不变、clip/leave/cancel/keyboard不放大与原色图，无新repoApp测试文件/矩阵/receipt或Native构建。完整相邻联动/动画及原生/物理资格仍独立remaining。
- 2026-10-16 导航与FileText续批：f951b22合7bc4b25让Files中性PageUp/Down按实际viewport/42沿排序过滤后的精确identity分页，沿原select/focus/reveal/scrollbar，无新滚动算法。c86764a+d5d792d合11c0e9e/445aefe在Classic AllPrograms保默认平铺，增真实非独占tag分类/无tag组、层级Back/Left/Esc/完整headerTab和Allapps直达，原epoch/稳定槽/gesture串当前view，调用时刷新catalog并查活category成员；失败明确bool中止，不以保留旧列表冒fresh执行，非Windows安装目录/XDG XML或新Nativepopup。9b2b29f合a15b601让明确optin的FileText本体接既有公共Theme/输入/命令/滚动，App+chooser复用同底层订阅并准确cleanup，neutral默认API和原4096UTF8/conditionalwrite/ESTALE/committedreadback/NoReplay不变；packaged wrapper选择公开--desktop/--theme，--no-theme退出，不赋Shell管理权限。现组合162项通过，无新App样式测试文件/矩阵/环境或Native构建；旧软件GUI入口的分类导航资格只在软件输入/renderer范围，不冒安装目录/物理WM。
- 2026-10-16 当前交互收尾：ff79d66合3b5bfed让固定应用菜单内Earlier/Later沿现有序v3配置交换相邻两项，missing/unavailable可管理、首尾省略无效方向、非pin无排序；同Pin/Unpin唯一atomic写入/committed报错策略，currentMenu/output/taskidentity/expectedposition与held方向identity检查，desktop shortcuts不变，不是拖拽或动画。d47156c合09c5cba完整接Processes既有overlay10/SDK controller：optional onScroll严格函数/undefined、构造/idle/stop不通知、actual normalized value改变一次，含clamp、同步嵌套合并与异常原样抛/鼠标up必释放capture；拖动/page/keyboard据原fixedRowWindow重绘真实PID DOM，不额外sample，错误/refresh保留观察可滚。行42/列/overscan/2秒cooperative采样/readonly及原owner两帧测量不变。父现scrollbar/Processes/Files/menu/config/group/theme组合141项通过；原Processes软件GUI900x640实际4096model/12DOMrows及nativecapture/末PID/Home/不增sample通过，无新测试文件/样式矩阵/Native构建/VM或环境操作。E22.8/9/10/15/34的全部原OS/物理与剩余业务资格并未因此标完成，native preset live recheck继续blocked，vendor小数边线候选仍未合。
- 2026-10-16 Displays应用层主题收口：d9228ec合f3bba39，让页面、显示器标题、正文、说明和pending/unavailable状态直接消费现heading/body/status与content/control/window spacing tokens，显示器header允许换行而原actionrows继续wrap。display-inputs未改，所有数值输入尺寸/对象/value/caret/selection、3缩放preset IDs/selected、checkbox/mode/rotate/draft callbacks、serial/hotplug/detach及原15秒Apply/Keep/Revert事务保持。父原Settings/theme入口21项通过，子仅原800x600 selection-settings软件GUI验证checkbox/retime/busy/Apply serial7及pending15000，原AudioACK亦通过。仅3个App paths、无新增或扩展testcase/fixture/matrix/环境/Native构建；这是现公共token采用，不是原OS字体、物理输出或全部E22资格。
- 2026-10-16 Keyboard低窗口焦点修复：304fc61合bb273ae，唯一keyboard view复用现framed:false panelViewport，padding0/原flex分配/inner controlGap保card定位，root title/reset/list/footer槽和Change/Off/录制/禁用/错误原callbacks保持，无新frame/RAF/timer/observer/engine。一次软件560x260同driver红到绿：Tab13末Change原y907且list y112..212/scroll0不可见，修后Change及Off均y180..212/scroll727，原list x16/y112/w528/h100不变；Enter原record/disable各一次、manualwheel回0后普通repaint仍0，同DOM及detach退出通过。父现Settings/panel/theme组合22项通过，无新增测试文件/case/样式矩阵/mock或原生构建；只证明软件renderer下真实focus/scroll，不冒物理DPI或可信录制端到端重新认证。
- 2026-10-16 全E22持续推进而非小批完工：2dd6981合4de0f78让Displays三个scale preset成为每head独立named themedRadioGroup，保原ID/custominput和draft/Apply15秒事务，真实busy传factory。父先复现composing Space错误改1到1.5且prevent，六selection入口最早isComposing return后原probe零更新/零consume；现SDK原basic/controls及原scale软件GUI通过，父Settings/panel/theme22项通过。e59a07a合55c4a46让Programs/category及windowgroup真实长列表复用同SDK/desktop overlay10，显式panelViewport scrollbar:true只fixedvertical，默认/content/horizontal旧合同保持；同DOM/capture、wheel/focus/clamp同步、leave释放，原epoch/稳定命令槽/header/close未换义，父组合115项通过。da63fdd仅挑6paths合fff78bf，绝不merge含暂停vendor的支线祖先：optional panel.materialOpacityPercent整数0..100/missing100原opaque逐byte，三Mac88为Polly默认非OS实测，只passive材质RGBA，不淡化原色bitmap/focus/marker/badge/separator、不改boxes/hover/input。原软件透明frame实测material alpha255/224/0，旧100/new100整PNG bytes同、clear中原opaque foreground全部ARGB保持、所有actualboxes同；父当前组合116及原generatorcheck通过。没有新repo测试文件/样式矩阵/Native构建/VM或环境恢复。原生owner只读确认MT02仅自身wallpaperopaque、现effect tree仅本窗client/frame，无可复用MT03behind-scene采样候选；所需regional damage/budget/privacy/ABI和pairedcompositor资格未交。环境恢复明确询问未获具体授权，因此无machine/service重启；E22原图/字体/物理/native资格及Snap/真实目录/完整邻近动画/reflection仍不能标done，继续实际XPQuickLaunch产品项。
- 2026-10-16 XP与Settings续批：25cf27b合de90bb3，仅XP builtin/fallback显式windows-launchers，复用原v3有序pins/注册bitmap/cache/atomic失败策略，以compact实际28x26启动按钮前置，原每窗160x26和Window.id/顺序/activeclick保持；已运行App仍真实catalog launch一次，未知窗不合并，缺项可键盘Unpin/前后移，canonicalSettings走原bridge。XP Start也复用Classic现真实Programs/Categories/epoch/live-membership/scrollbar，不改realSearch记录或desktopPin域、不造安装目录/账号/Recent。原XP软件GUI一趟实测PNG16、launch1/minimize10/activate11、13pins窄栏Tab/wheel与Programs真实client内末项/Enter1/Esc回trigger。79eab7e合cfb8a8f只4Apppaths让Audio/Displays/Keyboard消费既有framed:false scrollbar:true+focusreveal，后两页头尾固定，输入/radio/音频ACK/可信录制/App业务无改，无新增testcase/文件；现Settings+shared34通过，原软件selectionSettings入口Apply/15秒/AudioACK通过。父最终XP/config/menu/theme/nativepolicy/Settings/sharedscroll组合130通过及generatorcheck；所有原图/字体/native物理资格保持独立。素材路径再次询问无输入，public查找工具504且替代页面仅泛用摘要，未获合格SP3/DPI状态包；E22.1/3/4/11明确blocked，不更改验收口径或伪造来源。
- 2026-10-16 材质/输入后续：9f04f6d只挑8paths合5f17666，BigSur菜单栏真实alpha+现透明surfaceflag、旧面板固定回调retirement，Dock原88/hover及Tiger/Lion旧menubar保持，真实软件PNG和旧菜单状态入口通过，无C/新ABI/环境操作。父另实证shared scrollbar composing keys把scroll0变4000，963226e早return修复；继续沿冒泡链实证5个现scenario red（Settings关闭、menu导航/关闭、Programs退层及trusted display确认），6268b07在desktop/menu/Settings/确认祖先与现Tab reveal入口也留composing事件，普通keys/token/deadline原样。扩的都是现行为case非App样式矩阵/新测试文件，父最终现组合185项通过；不冒native IME Beta/全系统输入资格。全部35个编号E22仍7done，其它按真实部分实现/明确blocked保留，不能为结束会话把OS参考、字体、原生材质/设备、完整动画及目录/账号/历史缺口标完成。
