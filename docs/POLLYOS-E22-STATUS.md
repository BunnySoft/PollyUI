# E22 当前任务、状态与完成顺序

> 本文由 `desktop/tools/polly-plan.py --write` 从 [POLLYOS-PLAN.json](POLLYOS-PLAN.json) 生成，不单独手工维护状态。
> 原始 35 项的完整范围、状态、证据与新旧映射保存在 [历史记录](POLLYOS-E22-HISTORY.json)。重整不是把原部分完成项改成全部通过。

## 当前状态

- 已交限定能力记录：**7 条**。
- 剩余任务：**18 条**；其中可独立推进 **4 条**，阻塞 **14 条**。
- “可推进”不表示已经开工；“已完成”只覆盖下表限定范围，不代表整个 E22、原 OS 像素或实时性能已完成。
- 参考输入、实现缺口、消费者收尾和最终原生验收分开，不再用长期 `in_progress` 混合表达。

## 已交能力

| 编号 | 能力 | 状态 | 已完成边界 |
| --- | --- | --- | --- |
| E22.C1 | 已交基础绘制修复 | 已完成 | 保留原E22.2/16/17/18/19/20/35的限定基础绘制、Classic边线/任务质感/三键/菜单衔接与真实outside-dismiss完成记录；不是整系统像素相等。 |
| E22.C2 | 已交共享控件与文字 | 已完成 | 已交per-instance字体度量/输入caret-selection-IME、六主题factory/appearance adapter、按钮focus/default及共享scrollbar/viewport机制和已有消费者；余下覆盖清单归R04，原OS字体/状态差异归R02/R18。 |
| E22.C3 | 已交应用数据与菜单 | 已完成 | 已交exact-appId分组/持久pins/排序、真实Programs与受校验source-folder多级浏览、readonly本地profile接口和合法应用bitmap接入；不包含账号CRUD/推荐历史后端或全部真实artwork端到端验收。 |
| E22.C4 | 已交原生效果底座 | 已完成 | 共享whole-client AA clip/外shadow、真实current-lower-scene Gaussian/tint、owned事务/预算/cache/隐私与effects4泛型768/SSE2原数学底座已交；不代表默认材质采用、目标OS样式或GPU新后端完成。 |
| E22.C5 | 已交Dock几何与动画 | 已完成 | 已交三Mac透明layer alpha、gap/indicator/iconfit/极窄双scroll修复及固定slot相邻distance动画；不自动代表真实反射、原OS位移幅度或玻璃样式。 |
| E22.C6 | 已交标准Start显式能力 | 已完成 | v9/schema4/standardHeight:true标准640/660 Start显式正确性、真实outputcommit/输入/前景/旧v8拒扩权已交；旧v7/v8 typed512仍保，packaged default solid不变。 |
| E22.C7 | 已交原生窗口交互 | 已完成 | 共享native窗口状态/输入底座及已发布半屏恢复、拖动恢复/拖边、基础Maxhover、Cascade/HV与TITLE右键/AltSpace入口保留；不是完整Win11 Snap或窗口Chrome脱离Shell进程。 |

## 剩余任务、依赖与关闭条件

前置列是现行台账中的实际 `requires` 边；没有满足的外部输入或决策不能靠继续写代码改成通过。每项的范围列同时写明关闭条件；共有底座已经交付的，不再重复开发。

| 编号 | 剩余任务 | 状态 | 前置 | 范围与关闭条件 |
| --- | --- | --- | --- | --- |
| E22.R01 | 认证参考输入 | 阻塞 | — | 合并原1/4：取得并登记六目标对应原版本/build/SP、DPI/缩放、light/tint/Dock设置及active/inactive/hover/held等原尺寸参考，记录来源/hash/crop/使用限制。关闭条件：所选比较状态的元数据可验证；现有JPEG不冒无损RGB，不推定授权。 |
| E22.R02 | 目标字体度量验收 | 阻塞 | C2、R01 | 只做原5剩余：对应主题合法已安装字体/明确替代的字宽、基线、字素/RTL与栅格对照；逐项列差异和可支持范围。关闭条件：测量数据、真实Runtime结果与已定义对照结论齐全，不重复字体接口实现。 |
| E22.R03 | 真实图标资源验收 | 阻塞 | C3、R01 | 只做原6剩余：用实际合法registered artwork数据集验证taskbar/Dock/托盘与标签，明确系统品牌不可分发部分及fallback。关闭条件：实际catalog→加载→native画面输入链、资源来源/差异清单齐，不重建resolver或凭title猜身份。 |
| E22.R04 | 现有控件消费者收尾 | 可推进 | C2 | 合并原7–10剩余的实现覆盖：列现有checkbox/radio/select/tab/list/input/bar及现有Settings/Files/Processes/通知/Power/认证面板实际消费者，补明证漏接线与状态/短viewport缺陷，复用现机制。关闭条件：明确覆盖表与必要现有入口通过、无待修已知缺口；不声称OS像素等价，原图状态对照保留到R18。 |
| E22.R05 | XP外观收口 | 阻塞 | C1、C3、R01、R02、R03、R04 | 合并原12/13剩余：XP标题bands/shadow/glyph状态、30px任务栏/launcher/tray/clock、真实Start内容/留白/profile图对照。关闭条件：对应原图状态的具体差异已修或按既定边界明确，不造账号/最近记录；原绘制基础不重开。 |
| E22.R06 | XP原生差异验收 | 阻塞 | C1、R01、R05 | 保留原3完整验收：固定源码/原生输出与XP同版本同缩放部件原图作预定几何/颜色/状态对照，说明字体/AA/资源残差。关闭条件：可复验输入、结果与差异处置齐，不以旧strip分数或旧ISO当新桌面通过。 |
| E22.R07 | Classic外观收口 | 阻塞 | C1、C3、R01、R02、R03、R04 | 合并原14/15剩余：Classic真实raw RGB、菜单密度/profile/原生级联对照；保双列默认及单列override/真实Programs。关闭条件：可信原图与native结果差异已解释/处理；不把JPEG量化色套全palette或新增账号管理前置。 |
| E22.R08 | Modern外观收口 | 阻塞 | C1、C3、C6、R01、R02、R03、R04 | 合并原21/22剩余：24H2 light caption/backplate/glyph状态、任务栏标记/间距、真实640x660 Start网格/footer内容对照。关闭条件：对应可用App/已有业务数据与样式验证齐；不把完整Snap/新账号CRUD或伪推荐作为本项补法，材料预算另R10/R11。 |
| E22.R09 | Modern圆角阴影收口 | 阻塞 | C4、R01 | 保原23剩余：当前Modern rounded已默认，核整窗内容裁剪与外shadow默认/参数、max/full/CSD和输入边界的目标样式。关闭条件：所选样式采用与对应native对照齐，不要求整个E13动画/新GPU后端全完成，不透明角贴片造假。 |
| E22.R10 | Modern材质消费者收口 | 阻塞 | C4、C6、R01、R11 | 保原24材质剩余：区分opaque wallpaper-base与live lower-scene blur，完成目标surface样式/前景输入/坐标及默认采用结论。关闭条件：预算明确放行后再决定默认/策略，原v7/v8权限与失败solid保持；不是调用DWM才算实现。 |
| E22.R11 | 材质性能与采用决策 | 阻塞 | C4、C6 | 集中原24的可用性能gate：依据完整open/动态更新的真实预算选择默认采用策略，保持原精度/输入/内存合同。允许通过统一内部后端接口纳入默认关闭、启动时显式选择的实验实现；源码纳入不等于默认采用或性能达标，旧两倍工程目标不作为实验源码入库门槛。若需跨原lroundf调用/质量或平台边界必须明确新裁决。关闭条件：预声明预算与非回退要求有实际合格结果，或明确不采用而不声称默认实时交付。 |
| E22.R12 | 三Mac窗框菜单栏收口 | 阻塞 | C2、C7、R01、R02、R04 | 合并原25/28/31剩余，分别保Tiger/Lion/BigSur独有样式与版本：窗框/traffic-light/active-hover/菜单栏尺寸颜色文字对照，明确unified toolbar不代表改造全部App内容。关闭条件：三目标各有对应证据/差异结论，不同主题不复做共享层。 |
| E22.R13 | 三MacDock几何收口 | 阻塞 | C5、R01、R03 | 合并原26/29/32剩余：按固定可认证Dock设置，逐Tiger二维rim/triangle、Lion透视shelf/glow、BigSur浮动rim/dots核几何与状态。关闭条件：原尺寸/缩放参数及native布局、滚动/点击证据齐，保可配置范围不冒全用户默认。 |
| E22.R14 | Dock原生应用语义收口 | 可推进 | C3、C5 | 保原34剩余的功能闭环：用实际原生窗口枚举验证启动/running/minimized、exact-appId分组/pins/排序与相邻动画输入/生命周期，明确MRU与当前支持界限。关闭条件：实际模型而非固定DTO覆盖必需行为，原OS位移幅度对照归R18。 |
| E22.R15 | Tiger透明原生收口 | 可推进 | C5 | 保原27剩余的native输出链：验证现有真实alpha与二维rim/前景/input的实际合成及失败/关闭；关闭条件：透明效果限定native合同完成，不称blur/反射，目标OS材质差异在R18按参考记录。 |
| E22.R16 | Lion真实反射与材质 | 可推进 | C4、C5 | 保原30真正未实现部分：真实源图像的icon/window reflection、Dock外shadow与玻璃blur消费者；沿现受限采样/合成能力设计，不贴伪窗口图或把透视色带叫反射。关闭条件：真实源、生命周期/隐私/预算/前景输入不变的机制与消费者可复验；OS参数对照归R18。 |
| E22.R17 | BigSur材质收口 | 阻塞 | C4、C5、R01 | 保原33样式剩余：依据macOS11 light的wallpaper/vibrancy规则调整现Gaussian+tint消费者与Dock外shadow，验证现前景/input/预算/隐私。关闭条件：目标策略与native输出对照齐，不从已有blur推定系统vibrancy完全相同。 |
| E22.R18 | 六主题原生收口验收 | 阻塞 | R01、R02、R03、R04、R05、R06、R07、R08、R09、R10、R11、R12、R13、R14、R15、R16、R17 | 合并原11及所有尚未完成的OS差异验收：对所选支持平台/版本/缩放/状态/控件与surface清单，逐项绑定原图、字体资源与最终source/native输出，保不支持项和残差记录；不以软件preview替代native，不强做无关全交叉矩阵。关闭条件：本清单所有约定比较/缺陷处置及前置已完成，才可关闭E22总项。 |

## 执行与收口顺序

**可以先独立推进：** R04 现有控件消费者收尾 → R14 Dock原生应用语义收口 → R15 Tiger透明原生收口 → R16 Lion真实反射与材质。

R01 的参考资料并行收集；缺资料不禁止先修可独立证明的功能缺口。依赖满足后的优先收口顺序为：

R01 → R02 → R03 → R04 → R07 → R05 → R06 → R09 → R08 → R12 → R13 → R14 → R15 → R17 → R16 → R11 → R10 → R18。

- 共享控件消费者先收口，再处理对应主题；已交机制只复用，不重做。
- Tiger 透明不依赖 Win11 大区域 FIR 性能；Lion 真实反射不能用透视色带代替。
- R11 是明确的性能与采用决策门槛，未放行不默认启用 R10 的实时材质。
- 默认关闭的实验后端可以独立纳入源码；统一接口和显式开关不代表性能达标或默认采用。
- R18 是最终原生／原图差异验收，不能由软件预览、旧 ISO 或历史局部通过替代。
- 显示桌面、完整 Snap、窗口 Chrome 进程拆分及新账号后端不临时塞成本清单前置；当前新增扩展保持暂停。

## 集中手测 ISO

**当前已交GUI集中手测ISO：已完成。**

根据用户修正早期启动等待/反馈问题请求，以已推送179f20e源码新编独立SquashFS+小bootstrap正式候选；旧97/843/DDD与证据保留。

最新候选为clean179f20e/schema2压缩RAMroot，bootstrap约4.3MB压缩/13.1MB普通文件展开，独立SquashFS654405632B，后续复制RAM再按需解压；早期真实阶段可见设计不伪造百分比。保持SDK40a2/ABI4/pin7b58、两实验OFF/Startsolid/七主题。真实启动/脱介质/实际提速未测，不挪用旧资格；用户修复占用后固定入口已通过新一次标准发布切换，原失败及旧版本保留。

只生成并交付ISO文件，不写入用户磁盘或安装系统；介质手测不替代E22原图、物理或实时性能资格。

| 交付字段 | 实际值 |
| --- | --- |
| 本次 ISO 入口 | `D:\temp\PollyOS\PollyOS.iso` |
| 版本化 ISO | `D:\temp\PollyOS\pollydesktop-0.1.0-alpha.8-debian13-179f20e-179f20e-88867bf1a50d\pollydesktop-0.1.0-alpha.8-debian13-x86_64-uefi-live.iso` |
| 大小 | 709148672 bytes |
| SHA256 | `88867bf1a50d326fec2e7251cc7c1372b6d215e2a07bb03f5c270b645194fe89` |
| 运行时源码 | `179f20e0d28a49071edfae6d0eb57f0cc9b625ac` |
| 媒体生产源码 | `179f20e0d28a49071edfae6d0eb57f0cc9b625ac` |
| 镜像内容核验 | 404 条实际 runtime/overlay 路径 |
| 根布局 | `squashfs-ram-overlay`；压缩根复制到 RAM：True；可写层：`tmpfs-overlay` |
| 压缩根 | `boot/root.squashfs`；654405632 bytes；SHA256 `0afcae8321fba692e91424794d0d83473c2cd16ed960a4d4a2fa20ee3e5c4549` |
| 小型 bootstrap | 4332358 bytes 压缩；13120270 bytes 普通文件展开量 |

构建发布时Agent未执行真实boot，原冻结回执NOT RUN不改；后续用户Hyper-V录像已见新RAM复制/校验OK/根挂载切换及桌面（日志uptime复制1.39→3.03s、切根3.81s，录像约20.5s桌面含8sGRUB倒计时）。录像未显示ISOhash/应用源码，属用户观察，不冒自动验收或旧新版同条件加速比；物理/拔介质/完整Apps未测。

**未覆盖：** 代码已消除整根提前展开并增加真实阶段提示，但仍读取整份压缩根到RAM；实际启动/图形反馈/速度和完整Apps/splash/E22/物理资格未完成。SDK40a2/pin7b58，两实验OFF、Startsolid；旧性能HOLD不改。

PollyOS.iso、PollyOS-179f20e.iso和新版本文件同inode硬链（links3）；用户修复占用后新一次标准发布成功，首次EPERM及旧97原文件保留，没有关闭/卸载用户VM。

## 原 35 项去向

旧编号仅作历史定位，不再同时维护另一套活动状态。一个旧编号可映射到已交能力和仍未完成的工作，不能只取其中已完成部分就宣布原要求全部通过。

| 原编号 | 原任务 | 现行去向 |
| --- | --- | --- |
| E22.1 | XP 固定参考与测量 | R01 |
| E22.2 | 控件与装饰绘制 | C1 |
| E22.3 | XP 真实截图差异验收 | R06、R18 |
| E22.4 | 六主题参考与状态来源 | R01 |
| E22.5 | 字体与文字基线 | C2、R02、R18 |
| E22.6 | 图标与品牌资源差异 | C3、R03、R18 |
| E22.7 | 按钮边线与交互状态 | C2、R04、R18 |
| E22.8 | 选择控件与页签覆盖 | C2、R04、R18 |
| E22.9 | 输入框光标与滚动条 | C2、R04、R18 |
| E22.10 | 对话框与面板一致性 | C2、R04、R18 |
| E22.11 | 原生状态与缩放对照 | C7、R18 |
| E22.12 | XP 标题栏材质与状态 | C1、R05、R18 |
| E22.13 | XP 任务栏与 Start | C3、R05、R18 |
| E22.14 | Classic 残余颜色差 | C1、R07、R18 |
| E22.15 | Classic 菜单与级联 | C3、R07、R18 |
| E22.16 | 已修 Classic 边线 | C1 |
| E22.17 | 已修 Classic 任务质感 | C1 |
| E22.18 | 已修 Classic 标题三键 | C1 |
| E22.19 | 已修菜单任务栏间隙 | C1 |
| E22.20 | 已修菜单外标题操作 | C1 |
| E22.21 | Win11 标题栏状态 | C1、C7、R08、R18 |
| E22.22 | Win11 任务栏与 Start | C3、C6、R08、R10、R18 |
| E22.23 | Win11 内容圆角阴影 | C4、R09、R18 |
| E22.24 | Win11 背景材质 | C4、C6、R10、R11、R18 |
| E22.25 | Tiger 窗框与菜单栏 | C2、R12、R18 |
| E22.26 | Tiger Dock 边缘指示 | C5、R13、R18 |
| E22.27 | Tiger Dock 透明质感 | C5、R15、R18 |
| E22.28 | Lion 窗框与菜单栏 | C2、R12、R18 |
| E22.29 | Lion Dock 透视与光点 | C5、R13、R18 |
| E22.30 | Lion 玻璃与倒影 | C5、R16、R18 |
| E22.31 | Big Sur 窗框菜单栏 | C2、C4、R12、R18 |
| E22.32 | Big Sur 浮动 Dock | C5、R13、R18 |
| E22.33 | Big Sur 壁纸染色模糊 | C4、C5、R17、R18 |
| E22.34 | Mac Dock 分组与放大 | C3、C5、R14、R18 |
| E22.35 | 已修 Classic 基础布局 | C1 |

完整原始证据、历史状态与补充记录仍在历史 JSON 和执行台账中保留。非阻塞 fractional/vendor 项目按现行台账单独跟踪，不冒 E22 原图或性能收口；失败 FIRST 日志没有重标为通过。
