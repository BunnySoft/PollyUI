# PollyOS 当前批次交接

更新时间：2026-10-08。代码合并基线为 `a5e176ac603d189a63264fa10662706614ba9299`，
已正常快进合并并推送到 `BunnySoft/PollyUI` 的 `main`；没有强推。
本文交接当前批次，不把实验性组件等同生产系统或全部任务完成。

## 执行入口与工作方式

- 唯一计划数据：`docs/POLLYOS-PLAN.json`。`POLLYOS-BACKLOG.md` 第 16 节是生成视图。
- 主会话实现、协调及合并；临时 worktree 子会话验证固定提交，不测试持续变化的主工作区。
- 实现已提交但验证未返回保持进行中；父项汇总和执行前置分开。重型构建/VM 单 lane。
- 每批先正常提交/推送代码，再更新交接和准确状态提交/推送，然后按就绪前置开下一批。
- 不自动操作真实介质、生产密钥、对外发布；这些仍须具体授权。

## 本批代码与准确范围

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

## 固定快照证据

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

下一批按具体前置选择：

1. T08.2：测试身份签名、错误签名/篡改拒绝，复用已合并载荷契约，不动生产密钥。
2. T17.1：私有网络/iwd 状态边界，Live 临时与安装持久分开，测试不连接用户网络。
3. T24.6/T24.3：目标报告展示/显式确认，仍不实现未授权 writer；安装源及排除范围不可被忽略。
4. T21.5：原生 dismiss 信号与实际输入隔离另立有界接口任务，不与 XP 视觉继续混在一起。

下一批仍用独立分支实现与固定快照验证；仅在收到准确证据后关闭，
不把全批完成等同系统已可生产发布。
