# PollyOS 当前批次交接

更新时间：2026-10-08。最新代码合并基线为 `ff4be97f6e8a019a60f4d295e9d2b892fae55f0e`，
已正常快进合并并推送到 `BunnySoft/PollyUI` 的 `main`；没有强推。
第一批 `a5e176a` 证据保留在下文；第二批原生代码为 `e7d709e`，`ff4be97` 仅更正一行文档。
本文不把实验性组件等同生产系统或全部任务完成。

## 执行入口与工作方式

- 唯一计划数据：`docs/POLLYOS-PLAN.json`。`POLLYOS-BACKLOG.md` 第 16 节是生成视图。
- 主会话实现、协调及合并；临时 worktree 子会话验证固定提交，不测试持续变化的主工作区。
- 实现已提交但验证未返回保持进行中；父项汇总和执行前置分开。重型构建/VM 单 lane。
- 每批先正常提交/推送代码，再更新交接和准确状态提交/推送，然后按就绪前置开下一批。
- 不自动操作真实介质、生产密钥、对外发布；这些仍须具体授权。

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
