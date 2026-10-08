# PollyOS 当前批次交接

更新时间：2026-10-08。本地 `main` 的最新代码基线为
`ce73a3cee08f8b09ff9f78e681957a0c993e0d51`，已正常快进合并，本轮尚未推送。
此前已推送的代码基线为 `ac5a5a570aee09ce1ce8ca641cac9ae92099e2c1`，
交接提交为 `0f863116fb3f1de8abbb6e032925a9860ce17553`；没有强推。
第一批 `a5e176a` 和第二批 `e7d709e`/`ff4be97` 证据保留在下文；
第三批始终固定 `ac5a5a5`，新私有环境实际编译验收，没有原生阶段源码修复。
本文不把实验性组件等同生产系统或全部任务完成。

**当前补充：** 本地代码包含第四批基础用户功能、控制台服务依赖修复
与闲置窗口交互源码修复。
已交付 ISO/VHDX 仍来自 `e879de1`，不被重标为新源码。
用户已要求先完成功能、再集中手测，并将文件 App 强化与专项优化延期。
最新版本边界与剩余收尾见 [Alpha 路线](POLLYOS-ALPHA.md) 和 JSON 生成执行清单。

## 执行入口与工作方式

- 唯一计划数据：`docs/POLLYOS-PLAN.json`。`POLLYOS-BACKLOG.md` 第 16 节是生成视图。
- 主会话实现、协调及合并；临时 worktree 子会话验证固定提交，不测试持续变化的主工作区。
- 实现已提交但验证未返回保持进行中；父项汇总和执行前置分开。重型构建/VM 单 lane。
- 每批先正常提交/推送代码，再更新交接和准确状态提交/推送，然后按就绪前置开下一批。
- 不自动操作真实介质、生产密钥、对外发布；这些仍须具体授权。
- 当前顺序为功能代码闭环、统一新候选、一次集中手测；只保留必要编译/类型检查和直接小回归，不扩展测试矩阵或每功能反复构建 VM。
- 基础 Files 已随合适中央接线合入本地 main；未完成复制/移动/Trash 草稿没有合入。文件 App 强化归系统自带 App 后期任务，停止子会话但保留 worktree、草稿和证据。

## 当前 Alpha 范围与第四批结果

Alpha 是可手测的普通用户开发候选，不等于正式安装器、安全生产桌面或目标硬件认证。
文件 App 强化、XP 全量视觉精修、断网构建、渠道身份、复测、XWayland、采集、
硬件热插拔、有线、锁屏认证、共享包、多用户隔离及授权外置安装按用户决定移后期，
保留未完成状态、来源和授权，不成为 Alpha 门槛。

- 基础 XP 控件与装饰绘制维持已完成；完整参考/DPI、Start、disabled/focus、
  外部图标等已知差异属于系统优化，不宣传官方 1:1。
- 当前六页 Settings、基础 Files、原生打开保存已经实现并合入当前本地 main；
  第四批真实新引擎普通 UI/音频/私有 PSK 网络、Files/chooser 的有界交互证据保留。
  原生 EAP、物理音频/无线、全功能 App 与安装版认证整机验收不被这项完成覆盖。
- 图形首次设置/密码登录源码和真实小 C/PAM 组件已具，但用户 Hyper-V
  首次图形入口/重启差异仍未根因闭环。控制台回退缺 user-sessions 依赖的真实缺陷
  已在 `1cd5f77` 修复，未自动更新用户现有 VM 或重置其本地密码。
- 闲置窗口主题/纯位置更新不等待无意义的新缓冲，在 `ce73a3c` 完成功能源码修复；
  真实尺寸/状态/装饰协商仍保留 matching commit，直接 Core 回归通过。
  只有 Core/runner 增量，旧媒体未包含该修复，集中下一候选才重新链接。
- 当前 Live ISO `pollydesktop-0.1.0-alpha.5-debian13-x86_64-uefi-live.iso`：
  677,996,544 字节，SHA256
  `d52d36a3627831ac93767a83bb13f96bffe43c41b00150542a7903484154287f`，
  已加 Library；QEMU 只读光盘实际普通 Live 桌面，不是安装到空白 VHDX 的安装器。
- 当前独立未初始化 VHDX：实际 1,692,401,664 字节、虚拟 3,568,304,128 字节，
  SHA256 `a0849d5dc0836193c6f56e4bebee2abf8954288463c069a85d5052d0effdb858`。
  QEMU 实际四字段首设画面与用户正确 **PollyOS** Hyper-V installed 桌面观察分证；
  Live 截图不解释/修复用户 installed 机器。
- 宿主 Hyper-V 创建权限不足、用户后改为自行建 VM，待 UAC 请求已停止；
  没有代办管理员认证或修改用户 VM/磁盘。所有 owned QEMU 媒体工具已结束，
  原 raw/cow/fw/源分支/失败证据保留，不把 QMP 退出当正常持久关机。

**距离 Alpha：** 当前代码集成已完成，仍有必要功能闭环、统一新介质、
集中手测三个收尾包；具体未完成执行项见 A0，不用完整长期清单百分比估算。

## 第一批代码与准确范围

| 单元 | 原分支提交 → 组合提交 | 当前结论 |
| --- | --- | --- |
| T07.1 系统载荷/包状态契约 | `7b6000d` → `67cc861` | 严格只读 capture/preflight、完整系统/Dpkg/Apt SHA 身份及包状态/容量/兼容检查，输出独立 sidecar；不认证来源、ABI、conffile 或实际 ext4/启动，不执行 apt/替换/恢复 |
| T24.1–2 只读目标模型 | `e3b74df` → `be85a42` | 模型/稳定 ID/祖先/排除/热插拔/重新识别与合成 CLI 测试完成；`writeAuthorized=false`，不含 UI 确认、writer、独占 raw opener、其他 namespace 或真实硬件验收 |
| T21.2 菜单授权 A 小批 | `7c12e8e` → `49b3e6d` | Shell-owned surface、stale callbacks、捕获与 listener 生命周期完成；组合 17 宿主回归和既有原生兼容通过，完整 outside-app 能力仍缺 T21.5 原生信号 |
| E22 XP 蓝色 Luna 小批 | `1176066` → `e048243` | 30px 任务栏、21px 标题按钮、多段绘制、bevel、原创通用图形和基础状态；其他四主题数据保持，实际四倍率组成截图完成；不是整桌面 1:1 |
| XP 冷启动兼容修复 | `1d5254a` → `c49f409` | 仅确认匹配 serial/prepare、negative ack、正常传输/cancel、schema 2 的特定拒绝后，尚未提交外观的启动可重试 generic schema 1；实际 commit 后可见 warning，不改偏好或静默降级运行时选择 |
| 组合夹具与中央注册 | `4a1e3bd`、`7d2623a`、`a5e176a` | mock selector 实际执行 Luna focus；native integration 改用实际 30px/多段数据且保留边界与其他主题断言；新增 5 个 CTest/fast 源检查 |

相邻 `settingsView` 冲突只合入 `error || appearanceWarning`；所有菜单 instance
callbacks 保留。原冲突、前失败、修复和固定提交映射均在验证报告中，不删特性。

## 第一批固定快照证据

最终集成验证子会话：`4838b4ff-1600-4719-9cbb-bb08e7bb3e34`。
工作区：
`C:\Users\chengzhu\.copilot\repos\copilot-worktrees\PollyUI\bunnysoft-animated-parakeet`。

证据根：`build\combined-e048243-59a1317a`。
报告：`combined-report-a5e176a.json`，69,544 字节，
SHA256 `c5e30c0acaecd2d509d9ec0f8a4e51f16eba5769bf8b0fb41314073200965a6b`。
`EVIDENCE-a5e176a-SHA256SUMS` 对 289 项证据及报告逐项验证。
主会话核对报告 SHA、`complete=true`、`phase=final` 后才合并。

- 私有 native volume `polly-child-combined-e048243-59a1317a`；共享 native cache 仅只读。
- 初始完整 194 步、修复后实际 CPP 22 步；注册重配置又触发 5 步，固定最终 HEAD 重验。
- 最终 13/13 原生/注册 CTest，3 个实际 PollyUI theme/appearance/XP fixtures 通过。
- 新编译固定 `6487101` schema-1-only compositor：修复前真实失败，修复后实际 schema 1
  commit、live Shell、可见非 fatal warning、偏好/catalog 不变；运行时再选 Luna 仍拒绝并保留旧快照。
- 逻辑 800×600 的实际 compositor scene buffer：1/1.25/1.5/2 倍各 9 张，
  active/inactive、hover/held/release/max/restore、launcher/settings/taskbar/clock。
  `c49` 截图不冒充 `a5` 新截；二者 only glue，native binary hashes 一致且 `a5` 重验已完成。

独立快速子会话：`6e642253-6ffb-4b8e-8fa5-9c8ac6fa01c5`，固定 `c49f409`：
98 Python、menu 17、startup 17 共 132 runner tests，加 XP assertion/generator/syntax，
无 skips/failures。证据：
`C:\Users\chengzhu\.copilot\session-state\6e642253-6ffb-4b8e-8fa5-9c8ac6fa01c5\files\final-combined-fast-c49f409`。
它不替代原生测试，`a5` 的中央注册由最终原生 lane 精确重验。

## 必须保留的限制

- 当前 headless Pixman/software GL 不是实际 GPU、物理屏、PAM、UEFI/新媒体或持久性证明。
- XP 参考 SP3/精确 DPI 未认证；字体/品牌资源不复制。caption 30px 色带 MAE
  `1.0222` 不推广为桌面相似度；完整 Start、disabled/focus、边框与外部 SNI 图标仍有差异。
- schema 拒绝消息本身含“out-of-range”歧义，不当作可靠 capability；
  transport/missing ack/commit uncertainty 不进入成功形态 fallback。
- 全菜单 outside-app 仍缺可信原生 surface/owner/child/generation 事件；
  DOM blur/window metadata 猜测不能代替它。
- targets 开发 CLI 尚按源码邻接定位 layout；未来部署须明确安装位置，不错误复制后假称可用。
- 目标枚举 fail-closed 于未解析 overlay/loop，非 USB 外部来源未支持；
  本批没有真实盘扫描/写入许可，排除三块内盘的决定不变。
- 初始 querySelector、32px native 断言、截图稳定时序、旧 compositor 失败、
  hotfix 冲突等记录全部保留。不要删除有 ignored 媒体/证据的子 worktree。

## 现有介质与下一批

旧 single-system-r2 来自 `9e89f8c`，Recovery 仍 reserved-not-bootable；
不能说本批新 renderer、roles、payload contract 已装入旧系统镜像。
此前 profile Live r2 与其 dirty-source/TCG/公开维护证据保持独立，
本批重编译/组成验证不冒充新 ISO/PAM 或正常关机验收。

当时选择的第二批执行项：

1. T08.2：测试身份签名、错误签名/篡改拒绝，复用已合并载荷契约，不动生产密钥。
2. T17.1：私有网络/iwd 状态边界，Live 临时与安装持久分开，测试不连接用户网络。
3. T24.6/T24.3：目标报告展示/显式确认，仍不实现未授权 writer；安装源及排除范围不可被忽略。
4. T21.5：原生 dismiss 信号与实际输入隔离另立有界接口任务，不与 XP 视觉继续混在一起。

下一批仍用独立分支实现与固定快照验证；仅在收到准确证据后关闭，
不把全批完成等同系统已可生产发布。

### 第二批开工记录

前三个隔离实现分支均已核对干净源 `8ce0b6d22fe9d5095f136f4f497850e20c1edd34`；
另增 T13.1 独立分支，基线 `81f948f` 仅记录本批计划，系统行为与 `8ce0b6d` 相同。
主会话维护共享计划和注册，不让分支各自改写中央状态。

| 执行项 | 子会话 / 分支 | 本轮交付与剩余边界 |
| --- | --- | --- |
| T08.2 | `951d53c8-b0b7-4553-96a5-fef0328a7862` / `bunnysoft-payload-test-signatures` | 测试身份签名、错误钥/签名/篡改/格式拒绝；生产密钥和发布仍未授权 |
| T17.1 | `d7b1a26f-73e8-4b37-a324-503fc1ce53f0` / `bunnysoft-private-network-state` | root 私有版本快照、Live 临时与安装 UUID 绑定、iwd 启动加载/正常停止保存；运行期即时持久、断电及真实网络验收未完成 |
| T24.6 / T24.3 | `2ca28434-854f-4de9-928b-806d17ad4374` / `bunnysoft-install-target-confirmation` | 只读报告 UI/provider/controller、显式确认和过期回调拒绝；原生 helper 部署接入与 writer 未完成，确认始终 `writeAuthorized=false` |
| T13.1 | `b4a59cb1-4aaa-4c7d-9f72-bfa451931552` / `bunnysoft-dbus-application-activation` | 补 D-Bus-only 应用的私有总线激活及真实服务夹具；保留普通 Exec/应用生命周期，不伪造 PID，不扩大为任意 D-Bus/特权 broker |

第二批当前状态和证据以下节为准。T21.5 原生菜单信号没有被本轮四条分支隐式放行。

## 第二批合并与验收

固定代码 `ff4be97f6e8a019a60f4d295e9d2b892fae55f0e` 已正常推送；
原生代码 `e7d709ea6fa99506bf5c19d06d0549f198d13b01` 与其完全相同。
`ff4be97` 只将 FD 文档改为“不接受或导出 FD”，不声称随后又重编译 C。

| 执行项 | 合并链与结论 | 未覆盖范围 |
| --- | --- | --- |
| T08.2 测试签名 | `f156227` → `fe89350`；test-only Ed25519、独立测试公钥和严格拒绝，中央注册完成；本有界项完成 | 不提升 development-unsigned，不认证实际物料/包来源，不操作生产密钥或授权写入 |
| T13.1 桌面激活 | `2715d00`/`695997a`/`1a1438c`/`e68d142` → `60b7b17`/`62ec086`/`b720b49`/`894743c`，真实原生修复 `e7d709e`；本有界项完成 | 不提供 MIME/Open/任意 D-Bus broker；共同总线同步认证/注册不在 post-send 3000ms 内 |
| T17.1 私有网络 | `32030d9`/`247a375` → `71ae641`/`4f5ef2d`，默认装配 `0c4289f`；私有快照、正常停止 checkpoint、显式 factory initializer 与 root 容器证据完成，整项仍进行中 | 无新媒体/实际 PID1 `+` namespace、即时持久、断电/冷启动、物理网络验收 |
| T24.6/T24.3 只读界面 | `c05793b` → `6388e5c`，中央注册 `07eae839`；真实普通用户窗口/指针/滚动/重新识别/确认/取消/关闭迟到保护完成，整项仍进行中 | 默认 helper-pending；仅合成 provider，无实际枚举、部署 broker、独占访问、writer 或写盘授权 |

### 最终证据与来源对应

同一独立 worktree 验证会话 `4838b4ff-1600-4719-9cbb-bb08e7bb3e34`，
使用本批新私有 volume `polly-child-batch2-0c4289f-59a1317a`，
没有改旧/共享 native volume。源码只读、网络关闭、SDK 固定
`4ef0cd4e096e79eedc8310c9cc87897fc5db778a6e68401e2ee7a56a64555cfb`。
缓存依赖如实复用，但项目二进制实际新编；全部项目编译及原生运行是 UID/GID 1000。

证据根 `build\batch2-native-0c4289f-59a1317a`；
报告 `native-final-ff4be97.json`，103,712 字节，
SHA256 `a3211b6f5321d2a247c65fa7c1e3324b5b0c7acab99e2da9bb5ee0df3b769cbe`。
`complete=true / phase=final-native-fixed-source`。
主会话逐项核对 `FINAL-NATIVE-SHA256SUMS` 的 **350 项证据加报告，共 351 项** 后合并。
真实普通用户默认 pending 与合成确认画面均已实际查看，不用形状代理代替内容验收。

- 新 `0c4289f` 编译 197 步；真实原生修复 `e7d709e` 再增量重编 applications/service，
  `ff4be97` 后 Ninja 无需工作，六个最终 binary hashes 与 `e7d709e` 一致。
- 普通 UID1000 的 21/21 原生选择器通过，106.93 秒；真实激活无 `--probe`：
  正常 ACK、自动启动、错误/格式/启动失败/过大/实际 pipe-FD 拒绝、队列及 timer、
  3500ms 迟到回复加 4000ms 停顿后的绝对超时、无 replay、重发现/关闭/断连。
- 三个实际新 PollyUI 像素夹具通过，外观文档 1124 assertions；
  软件 headless/Pixman 不是物理 GPU/显示器或 XP 全桌面 1:1。
- 真实独立普通应用（`typeof desktop` 为 undefined）默认 pending/合成两模式通过；
  原生 wheel、实际 pointer 选择/ack/fresh 确认/取消、实际 WM close 后 held reply 不复活。
  图片为真实 1040×800 app buffer 和 1280×1000 组成结果，不是 mock-host 截图。
- 另一个 root 容器中 `root-container` 标签 2/2 通过：Network36 与 fresh factory12，
  不混入 ordinary UID1000 结果，不宣称 PID1/namespace 执行。

最终 `pollyui` SHA256
`1e76c214e4cdc7f1111704cca98cec897cf226d3a0bbb5766327da1817f9a8d6`；
`pollywm` SHA256
`3b44e5c2130f519114d8148ed43ebc03bad1d739fc517c0790988fbfaf7a212c`。
其余四个真实 helper/manager hashes、原 UID/GID/mode 和 314 项私有转存记录在报告中。
后置只读 volume 字节转存使用 UID0，不冒充原生运行，也不是权限失败后改用 root。

独立快速会话 `6e642253-6ffb-4b8e-8fa5-9c8ac6fa01c5`：

- 固定 `0c4289f` 完整 source-only：17 Python selectors 的真实日志合计 244，
  Node 单次 153（86 top-level），无 failures/skips；XP unit/generator/syntax 通过。
  报告 SHA256 `349fbdaeac10c2d8a493d4095e552d538b44e79a12e76659629e26e8038ace6b`。
- 固定 `e7d709e` 只重验受影响的严格 C、Node53 与隔离基础设施；
  报告 SHA256 `9673362ef073da856520ae86657ea0ba1f4f558ea9dea8adc9cdb7570845a52e`。
  `--probe` 明确没有跑产品 FD/JS/pump；不代替上述真实新原生结果。
- `ff4be97` 文档身份收据
  `cdf6e708fd8b742df262fc9cd6335f3bfd09be87335ac346c15367a6c3149d93`：
  仅一行文档，其余 775 个 tree blob/mode/path 与 `e7d709e` 一致，没有测试重跑。
- 独立 Network36/private namespace、签名41、目标100/34及逐字段一致性、
  D-Bus53/C/基础设施各自固定源与 receipt 保留；不把重叠测试相加冒充新覆盖。

### 失败修复与保留边界

保留原 `0c4289f` 的正常 300ms ACK 却 3000ms TIMEOUT、20/21 原结果：
libdbus 的 zero live-FD budget 对无 FD 消息也施加接收背压。
确定性同 SDK/UID1000/daemon 500ms 对照为 budget0 completed0、budget1 completed1；
修复仅 activation live budget1、per-message0 和显式 descriptor-presence 拒绝，
不延长期限、不重试、不放宽私有总线守卫。
真实 pipe-FD 负例与所有中间日志保留。

Network 原 post-unlink fsync EIO 可导致 refused 却失去 lease，已独立复现；
`247a375` 将持久 fsync/回读和锁关闭放在 guard 尚存时，
确认 RAM runtime 后最后单次 unlink，无 silent restore 或后续 checkpoint fsync。
guard cleanup 失败不撤销已提交 persistent generation，仍拒绝自动重载。
普通窗口迟到回调/菜单无实例时 stop/restart 保护、测试 harness 的 retired-pointer UAF
及首次点击仅 focus 的真实诊断均保留；后两者只修 scratch fixture，没有掩盖产品失败。

本批没有新 ISO/VM、PAM/logind/PID1 启动、物理 GPU/无线/设备写入；
旧 single-system-r2 不能声称已包含这些新代码。
完整 T17、T24、原生 outside-app 菜单和 XP 1:1 仍开放；
真实介质、生产钥和发行 gate 不变。按具体前置继续下一批，提交/推送不是停止点。

## 第三批开工记录

第二批代码 `ff4be97` 与交接/状态 `18d47e7` 已分别正常推送；
以下三个隔离实现分支固定在 `18d47e78ab6c4e32330e2592d0a3ee5d4bc14eb2`。

| 执行项 | 子会话 / 分支 | 当前范围 |
| --- | --- | --- |
| T03.6 必需存储故障 | `21c0b051-d0ad-444a-b95d-21babfb0c9f9` / `bunnysoft-storage-fault-guards` | 严格 manifest/映射/就绪守卫及故障矩阵；不空目录 fallback、认证重置或自动修复，整机/真实盘故障仍须独立验收 |
| T20.1 MIME 与默认应用 | `78d977e3-b66b-4353-938d-b5931a7b54a5` / `bunnysoft-mime-document-launch` | XDG 默认应用、MIME 与正确文档启动参数；复用现有应用数据库，保留真实 D-Bus/FD/期限/no-replay 及普通 Exec 边界 |
| T24.6 只读原生 provider | `b9cd8e69-6436-428d-a4b7-17d86617c342` / `bunnysoft-installer-readonly-provider` | 填补现 UI 的真实只读 transport/部署；无任意命令/root broker/writer，不伪造来源、容量、kernelBasis 或写权限 |

共享注册、默认构建链与计划状态仍由主会话统一维护。MIME 分支拥有现
`applications.c`/应用查询；安装报告分支用独立 adapter，并交回最小注册契约，
避免两条分支同时重写同一原生入口。固定提交交回后再独立验证和单 lane 组合。
不会在验证中枚举主机真实磁盘、改变默认应用或触及真实用户文档。

**满盘策略已由用户明确选择：** 如果既有账户、包状态和映射完整可读，
保留登录、只读诊断和清理能力；只有需要空间的持久写入按其真实需求拒绝。
不得把 `f_bavail`/`f_favail` 为零变成 `Storage.check`/preflight 的全局拒绝，
也不设置全局任意 reserve。必要 Dpkg/status 缺失、空、非正规或不可信仍拒绝；
写入的 ENOSPC/I/O 错误必须显式反馈，不能清空状态、重置认证或假称成功。

## 第三批合并与有界验收

固定源码 `ac5a5a570aee09ce1ce8ca641cac9ae92099e2c1` 已正常快进合并并推送。
前三个执行项完成下列组件，**完整 T03.6、T20.1、T24.6/T24.3 仍进行中**；
不为了关闭本批把未覆盖的整机、MIME 管理或实际安装来源范围删除。

| 组件 | 原分支 → 组合提交 | 本批完成及剩余范围 |
| --- | --- | --- |
| 必需存储记录/映射守卫 | `8e1e069`/`8af0915` → `75ad21c`/`d47fee4`，注册 `7e51c3d` | 受限 FD 快照、严格 JSON、非空可信 Dpkg/status、就绪及映射拒绝；103 单测/64 私有故障矩阵/三个 namespace 夹具通过，真实 ext4/包事务/掉电/启动未认证 |
| 本地文档 MIME/默认关联/Open | `ac43e9f` → `1ae1444`，接线 `ebb06fd` | 新普通用户产品真实 local MIME/Exec/标准 Open 和错误/迟到/FD/退出通过；无用户默认写入、全 MIME aliases/subclasses、远程协议或 bundle MIME 模型 |
| 固定只读 native provider | `4124fb8` → `93be948`，接线 `2c01e17`；期限修复 `9f9c1a5` → `b12147f`，对象隔离 `ac5a5a5` | 无参数普通用户固定 helper、真实取消/回收/窗口及 8 秒完成资格通过；生产来源 producer/source.json、有效介质模式/exclusive broker/writer 仍缺 |

### 固定证据与实际新二进制

验证会话仍为 `4838b4ff-1600-4719-9cbb-bb08e7bb3e34`，工作区与旧批次相同，
但本批使用新的专有 volume `polly-child-batch3-ac5a5a5-59a1317a`；
不写旧/共享 build cache，也不拿旧 binary 代替当前源码。
SDK 固定 `4ef0cd4e096e79eedc8310c9cc87897fc5db778a6e68401e2ee7a56a64555cfb`，
网络关闭、源码只读；全部项目编译是 UID/GID1000，实际 256 步。
缓存依赖如实复用；未变的 helper/WM 新编结果可能与旧 SHA 相同，不表示复用了旧文件。

证据根 `build\batch3-native-ac5a5a5-59a1317a`；
`native-final-ac5a5a5.json`，76,995 字节，SHA256
`d4ec553edb9afa5c583e258140bc28fa63ace3ee97a1f0499612ff2ffab3739b`。
`complete=true / phase=fixed-source-native-and-explicit-private-fixtures`，
`sourceDirty=false`。主会话核对报告、**210 个 artifact 加报告共 211 个 SHA**、
真实缺来源错误和 native 确认画面后才合并。

- 普通 UID1000 的 23/23 原生 CTest 通过，119.65 秒；
  真实新产品 document/Open 和 activation、app/launcher/bundle、菜单/XP及八个相邻 native selectors 保留。
- 文档真实夹具不接受 `--probe`：临时实际文档/file 分类、XDG 默认关联、
  Exec argv/URI/cwd/env/FD/退出、标准 `asa{sv}` Open/自动启动、
  实际 FD 拒绝、错误/过大/队列/关闭/断连和元数据重新发现通过。
  实际 3500ms 晚回复加 4000ms pump 停顿明确超时，无 ACK/replay/fallback。
- 新生产 PollyUI 三个像素夹具通过，外观 1124 assertions；
  不是物理屏/GPU 或 XP 整桌面 1:1。
- 独立 root 容器中的存储13/Network36/factory12 注册 3/3 通过，
  7.53 秒、原 30 秒限制不变；不混成 ordinary native 或 PID1/namespace 实机证据。

生产 `pollyui` SHA256
`c893eceb3cfca9007bf667c94ecce44da25122a4ca670d3f2e6958b584f68607`；
`pollywm` SHA256
`3b44e5c2130f519114d8148ed43ebc03bad1d739fc517c0790988fbfaf7a212c`。
十个真实新 target 的 binary SHA、四种对象的 compile_commands/nm、
原 UID/GID/mode 与 185 项转存文件记录均在报告中。
后置只读 volume 的 UID0 字节转存不冒充原编译/运行 UID。

### Provider 的四种证据不能混用

1. **生产 binary：** 无 helper 覆盖或时钟钩子；默认 main 明确 pending，
   显式 opt-in 且缺生产 `source.json` 时真实固定 helper 报 ENOENT，
   UI 显示失败，不输出空成功 inventory。未缓存 strace，未安装工具或伪造 syscall trace；
   “枚举前失败”依据实际异常及已审定 configuration-before-enumerate 顺序。
2. **普通 SDL 测试变体：** 只定义固定 private fixture-helper 路径，
   clock/read/waitpid 仍真实；UID1000/groups 空，真实新引擎窗口、滚轮/指针、
   fresh native 确认/取消/实际关闭终止 transport 和迟到保护通过。
   仅接受 `NATIVE-COLLECTOR-FIXTURE`，不是生产来源或真实盘资格。
3. **小型传输测试：** 专用 OBJECT 独有 clock/read/waitpid 重定向，
   harness 仍真实 libc；注册全部 16 cases/31 UID1000 marker，36.85 秒通过。
   四个精确边界是确定性样本，不冒充 8 秒墙钟或 SDL 窗口证明。
4. **部署检查：** CMake component 只在本批私有安装 stage 验证四个相邻 Python
   文件 0:0/0644、目录0755和六个生产 JS，不夹带 fixture/source.json。
   双平台 runtime 包 authority 已声明 file/Python3，Debian 还有 libmagic 库/数据；
   这是当前源码接线与 SDK 工具 provenance，不是新 runtime bundle/Alpine/image 已构建。

Private staging 使用 Podman 创建的明确 0755 tmpfs 和 marker，
不加 CAP_SYS_ADMIN，不执行 mount/unshare，不读取主机磁盘或改变传播属性。
只有私有合成 metadata/命令/proc/sys 文本被 collector 使用；
root staging 和 actual UID1000 acquisition 分 phase 记录。
来源真实性不能从 `/run`、root 所有权、generation 或 UI kernelBasis 推断，writer 未放行。

### 独立源码证据与保留失败

快速会话 `6e642253-6ffb-4b8e-8fa5-9c8ac6fa01c5` 固定同一 `ac5a5a5`：
18 Python selectors 日志实际求和 257，单次 Node 174（107 top-level），
无失败/跳过，另有 52 条 pure app-bundle、XP unit/generator/syntax。
报告 SHA256
`309a74d9e4a8cdfcc52b29b49d9c14471f304d0d62c01f642cf8fd0727902316`。
observer 只记录原 subprocess 输出，未改 args/60s 限制或重新实现/重跑选择器。
这份 whole-source proof 不代替前述新引擎。

固定组件证据各自保留：8af 存储 103/64 私有矩阵，
ac43 MIME67/C/52，4124 provider107/34/12cases27及其已知期限缺口，
9f9 仅受影响的生产 C/四精确边界。
原 4124 确实在入口 elapsed7999、最终 EOF elapsed8001 时错误 resolve；
修复后 EOF7999 成功、EOF8000/8001拒绝，
post-drain7999但 pre-resolve8001 也拒绝。先释放原 JSON，只 reject timeout Error；
8 秒常量和生产 API/header没有测试 escape。

WSL 临时运行目录丢失导致未开始的 MIME SDK preflight 曾失败，原日志保留；
只在确认配置目录确实缺失时恢复已配置的 UID1000/0700 volatile 目录，
不换 rootful、不改 store/runroot/linger/全局挂载。
其他 evidence driver 打字/匹配错误保留并单独分类，没有改产品或隐藏测试失败。
本批原生阶段没有 unexpected product/compile/test 失败，也没有新源码修复。

本批没有新 runtime bundle、完整 apt 包重建、Alpine 产物、ISO/VM/PID1/PAM/logind 启动、
物理 GPU/无线或真实介质操作。完整 T03.6、T20.1、T24、T17、原生菜单和 XP1:1
继续开放；旧镜像不能声称包含本批代码。继续按具体前置选择下一批独立实现。

## 第四批：用户功能优先，四线并行

第三批代码 `ac5a5a5` 与交接/状态 `0f86311` 已分别正常推送。
用户明确纠正后续排序：先交付可用系统功能，不继续把故障恢复工程作为默认优先项。
主机身份、Shell 恢复和安装来源三个新分支已暂停，均为干净 `0f86311`，
没有产品编辑、新增提交、构建或持续 helper；工作区保留，不删除。
安装来源缺口仍属实，但不成为图形入口、设置和文件功能的新前置。

当前四条隔离功能线固定在 `0f863116fb3f1de8abbb6e032925a9860ce17553`：

| 功能 | 会话 / 分支 | 用户可操作交付 |
| --- | --- | --- |
| 图形首次设置与登录 | `7d0bf6ec-34e8-48d4-b685-8bb584ca8df4` / `bunnysoft-graphical-setup-login` | 双独立密码的真实首次设置、随后真实 PAM 密码登录并交接 UID1000 桌面；同一流程避免重复账户后端 |
| 系统设置中心 T21.6 | `47f514de-9e94-47a4-8ccf-05299e0676fe` / `bunnysoft-usable-system-settings` | 单设置窗口内导航外观/显示/网络/音频/快捷键，复用已有真实控制器和持久行为 |
| 原生文件管理器 | `4b0f28e2-6cc2-48f5-b900-3d9b04d7ab8c` / `bunnysoft-native-file-manager` | 真实目录导航、属性、MIME 打开、创建与重命名，并维护唯一普通用户 FS 后端 |
| 打开/保存选择器 | `fade3257-83ac-4381-a82b-b524b08390d1` / `bunnysoft-native-open-save-dialog` | 原生用户选择和取消、真实读取/新建保存/已有文件覆盖确认，复用上述 FS 后端而非另做一套 |

用户已明确批准 **greetd** 作为安装版底层登录管理器，Polly 提供非 root 图形
首次设置和登录界面；真正 PAM account/credentials/open-session/logind/VT
由标准管理器负责，现有 lock-only helper 不当作登录会话成功。
Live 既有公开账户及启动策略不随之改变，root 不获得图形桌面；
默认密码登录及原显式自动登录政策保持。

用户亦明确要求第一版支持 **覆盖已有文件**：必须明确确认，
目标观察发生变化时要求重新确认，取消不写、失败不假称保存。
文件后端与选择器统一接口；新建无覆盖仍保留，不能因后端暂缺功能
默默把“仅保存新文件”当作该要求已完成。普通本地文件并发模型及观察/提交
间的真实限制必须说明，不宣称不存在的文件名 atomic-CAS，亦不引入 root 文件 broker。
测试只操作私有临时文件，不改真实用户文档或主机默认应用。

Shell 的“最多三次自动恢复、耗尽保留应用、明确故障/手动恢复”用户选择继续保存，
但恢复新实现已暂停，正常退出/注销/health-check 区分不变。
本批验收以用户能完成真实功能流程为主；必要守卫是功能约束，不另扩展成恢复工程。
四条功能实现可并行，重型编译和镜像/原生运行仍单 lane，固定提交通过后再合并。
