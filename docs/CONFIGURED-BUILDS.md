# 用 YAML 配置生成 Live SKU

## 当前产品命名与入口

当前仅三档 **Mini / Compact / Standard**：Mini 复用 Alpine Micro（无中文、
IME 和 3D），Compact 是 Debian 中文 CPU 桌面（只基础 GOP/simpledrm，不按
显卡厂商分版），Standard 带完整驱动/固件。统一使用
`bash tools/build.sh --os <product> --plan|--build`，完整命令见
[新产品构建入口](BUILDING.md#current-product-builds)。

新增 `desktop/release/debian/configs/standard.yaml`，其配置名为 `standard`，
底层硬件仍为 `full`，原生变体仍为 `standard-effects4`。这只是新构建身份与
原有组件集合的显式绑定，不是把旧 full ISO 改名；原包闭包、锁和来源校验保持。
该配方仍含原 WebGL2/Mesa/LLVM，不能称为已实现新的精简 native。
Mini 不使用这个 Debian YAML/锁，Compact 新配方缺失时明确 blocked；
不存在已接通的 `compact-intel` 等厂商分版配置。

下文九份早期 YAML 及其路径保持兼容，不能从历史名称推断新的产品档位。
文中的 minimal-zh 阻断专指正式配置构建，不否认独立实验镜像。

该入口提供**配置、计划和执行通路**，不把配置文件当作已构建的产品。
实现及非编译复核最初保留在独立分支；用户后续明确要求合入，现已进入 `main`。
实现会话只运行 Windows 上的 Node.js 测试、Git Bash 入口和模拟后端；
复核会话另复用已有 WSL 主机的 Python 解释器运行纯 mock 单测。
没有运行编译器、真实 APT/gpgv、Podman、内核或 ISO 构建，也没有新装解释器。
极简版原生依赖变体尚不可用，因此其构建明确阻断；没有新的 minimal ISO、
中文字库实画、启动或物理硬件资格。

## 1. 安装纯 JS 工具与查看计划

使用 Node.js 22 和 npm。从仓库根目录进入工具目录安装精确锁定的依赖：

```powershell
Set-Location desktop\tools
npm ci --ignore-scripts --no-audit --no-fund
Set-Location ..\..
node desktop\tools\build-live-skus.mjs --help
node desktop\tools\build-live-skus.mjs --config desktop\release\debian\configs\standard-vm.yaml --plan
node desktop\tools\build-live-skus.mjs --config desktop\release\debian\configs\minimal-zh-vm.yaml --plan
```

Linux 上对应为：

```sh
(cd desktop/tools && npm ci --ignore-scripts --no-audit --no-fund)
bash tools/build.sh --live --config desktop/release/debian/configs/standard-vm.yaml --plan
```

`desktop/tools/package.json` 和 `package-lock.json` 只属于构建工具。
唯一新增 npm 依赖是纯 JS 的 `yaml`，没有安装脚本或 native addon；
不会安装到发行版运行时。YAML 解析器仅在使用 `--config` 时延迟加载。
普通 GUI 构建、旧 `--sku/--skus` 和 `--help` 不需要先安装它。

`--plan` 将 JSON 写到标准输出，不创建输出目录，不调用 APT、
容器或编译器，也不安装/删除任何包。需要保存时由调用者显式重定向；
重定向创建文件是 shell 的行为，不是计划器的副作用。
计划允许不提供输出目录、runtime 或 basic 内核包。
`blocked` 计划正常输出，表示无法执行；不是已有构建产物。

## 2. 每个 SKU 一份配置

配置位于 `desktop/release/debian/configs/`：
`standard-{basic,vm,intel,nvidia,amd,full}.yaml`，
以及 `minimal-zh-{basic,vm,full}.yaml`。没有继承、表达式、脚本钩子，
也没有另一套 JSON 输入配置。JSON 只用于输出的计划、依赖锁与收据。

| 字段 | 当前允许的含义 |
| --- | --- |
| `schemaVersion` | 整数 `1` |
| `name` | 小写字母起始、最多 48 字符的字母/数字/连字符名称；进入文件名，但不决定能力 |
| `description` | 非空说明文字，不参与包选择或命令推断 |
| `target` | `{distribution: debian13, architecture: x86_64}` |
| `hardware` | `basic/vm/intel/nvidia/amd/full`；显示策略、模块和内核合同由现有硬件清单解析 |
| `media` | 当前仅 `live-iso-usb`，保持内存 SquashFS 根、tmpfs overlay 和 ISO/USB 双输出 |
| `nativeVariant` | 白名单 `standard-effects4` 或尚不可用的 `minimal-zh-cpu` |
| `capabilities` | 必须与变体完全匹配的 `renderer/webgl2/vulkan/fonts/ime/audio` |
| `packageGroups` | 非空类别数组，每项严格只有 `description/stage/install` |
| `policy.noRecommends` | 当前必须为 `true` |
| `policy.forbidden` | 禁止出现在最终完整包清单中的包名；空数组允许 |
| `policy.pins` | `包名=版本` 数组；与组内版本声明冲突即拒绝，空数组允许 |

`stage` 是 `runtime/platform/boot`，三者必须都有非空请求。
`install` 是**明确的顶层包名或包名=版本**，不是完整传递闭包。
同阶段重复包拒绝；不同阶段重复同一请求允许（例如已有的 `python3`），
跨阶段版本冲突拒绝。说明文字写“安装某软件”不会安装它。
不接受 shell 字符串、APT 命令行选项、任意文件路径或通配表达式作为包名。

YAML 使用成熟解析器的安全核心 schema，再经过集中严格验证。
未知字段、重复 key、多文档、错类型、空安装列表、恶意 tag、
anchor/alias、merge key、非法包版本和超出 64 KiB 的配置都拒绝。
不能通过 `name: standard-full` 获得默认发布权限。
配置不是一个任意布尔组合空间：没有实现的编译组合不能自行变为 available。

### 标准版和中文极简版

标准版保留原有 native runtime、Mesa 修复包/LLVM、广覆盖 Noto、
Rime Luna、音频、应用和服务。六份标准配置的阶段请求与旧硬件接口相同；
标准 runtime 顶层包清单集中在 `release/debian/runtime-packages.json`，
打包器与验证器共用，配置不能偷偷裁掉标准 runtime。
可以在 `platform` 类别添加合法系统包；新依赖必须进入真实 APT 解算和最终锁。

极简配置声明 WQY Micro Hei `0.2.0-beta-4`、必要的 DejaVu/fontconfig、
Rime 简体拼音、候选和一般中文用户文本，应用 CPU raster、WM pixman，
无应用 WebGL2/Vulkan/彩色 Emoji。WQY 约 5 MiB 安装大小不是 Unicode 全覆盖；
没有按菜单字符裁剪字库。Shell、Files、Settings、Processes、USB 输入/存储、
有线 IPv4 DHCP、PAM/UID 1000、实际 READY、诊断、早期 Plymouth、
64 MiB bootstrap 和 RAM root 保持底线。

**`minimal-zh-cpu` 目前没有可执行且已验证的配对 native 配方/ABI 输入。**
现有 pollywm 的 `ldd` 传递闭包包含 EGL/GLES/GBM，
而 GBM 的 Debian 包依赖会继续引入 Gallium → LLVM → Z3；
`PU_WEBGL2=OFF` 或 raster 环境变量不会解除这条链。
计划列出缺失的 CPU/DRM allocator、GL 编译门与字体验证先决条件，
`--build` 在任何外部后端操作前失败，不会给旧完整 bundle 改标签。
后续应实现独立变体及来源/配方/ABI 收据，不能覆盖现 effects4 SDK。

本版极简配置保留标准音频。ONNX/DNNL 来自当前 backports SPA 包依赖，
不是 Rime；没有把“纯拼音”等同于移除 ONNX。
Debian Luna 包硬依赖 stroke，本配置仍让 APT 保持这条合法依赖；
没有删词库、字体文件或 `.so` 来伪造 dpkg 完整性。
`Build-Depends` 属于 native 构建环境，不当作运行时 `Depends`，
也不能反过来因为不分发编译器就声称不需要 LLVM 运行库。

`full` 即使功能变小仍保其原固件集合；`vm` 不代表物理通用版。
`basic` 仍需明确的独立 basic 内核包，不能拿 stock 内核改标签。
换字体不自动要求重编内核；显示模式仍受硬件合同约束。

## 3. 计划、锁与真实性

计划包含规范化配置、各阶段顶层请求、能力合同、变体/ABI 声明、
硬件显示与内核策略、必需功能、bootstrap 上限和阻断原因。
没有完整 APT 输入时为 `unresolved`，`resolution.packages` 为 `null`，
绝不把顶层请求称为完整 closure，也不写成功形态的 packages lock。

三个域独立：

| 标识 | 用途 |
| --- | --- |
| `configSha256` | 规范化 YAML 对象，包含说明；不是仅文本排版 hash |
| `nativeVariantInputSha256` | runtime 请求、编译能力、配方标识和 wlroots effects ABI/patch 合同；不同硬件可复用相同 native 需求 |
| `packageRequestSha256` / `planSha256` | 完整包请求/硬件约束，以及含解析状态和依赖锁身份的完整计划 |

它们不替代实际 native 二进制 hash、原 SDK 收据、源码清单或包签名。
本入口只组装已经验证的 frozen runtime，不编译任何 native 变体。
改变 native 能力/字体/IME 闭包需要合适的新 runtime 输入；
只改硬件固件集合可以复用真正相同的 runtime。

### 保存的 APT 解析输入

新配置执行器消费一个受控 APT 导出目录，不自动在线采集依赖。
**本分支没有附带真实 snapshot/lock，也没有在线锁采集器。**
应由现有受控 Debian 构建环境的 APT 解算/归档流程提供完整目录；
不要手工猜测依赖、provider 或架构来填写锁。缺少输入时只看计划，执行失败关闭。

目录根必须有 `packages.lock.json`，结构如下。尖括号是必须替换的说明，
此段不是可以直接使用的真实锁或安装命令：

```json
{
  "schemaVersion": 1,
  "kind": "polly-apt-resolution",
  "packageRequestSha256": "<计划中的包请求摘要>",
  "runtimeManifestSha256": "<原 runtime manifest 的 SHA256>",
  "runtimeImageID": "<不可变 image ID>",
  "solver": {"name": "apt-get", "version": "<实际版本>", "note": "<解算来源/时间/边界>"},
  "packages": [
    {"name": "<包名>", "version": "<实际版本>", "architecture": "amd64", "reason": "<主动请求或 APT 原因；不支持逐边来源时明确写出>"}
  ],
  "archives": [
    {"name": "<新包名>", "version": "<实际版本>", "architecture": "amd64",
     "path": "packages/<sha256>.deb", "sha256": "<sha256>", "bytes": 1,
     "source": "trixie-main", "stage": "platform"}
  ],
  "sources": [
    {"id": "trixie-main",
     "inRelease": {"path": "snapshot/InRelease", "sha256": "<sha256>"},
     "index": {"path": "snapshot/Packages", "sha256": "<sha256>"},
     "releasePath": "main/binary-amd64/Packages"}
  ]
}
```

`packages` 必须是**完整最终已安装集合**，包含 minbase 和原 runtime 的包，
而不只是本次安装增量；架构只允许 `amd64/all`。
`archives` 是本次新增的 Debian 包，只能属于 `platform/boot`。
所有文件必须是目录内常规文件，禁止符号链接和路径逃逸。
snapshot index 是原始未压缩 `Packages`，必须能由 InRelease 中相同路径的
SHA256 和长度认证。允许 Debian trixie、updates、security、backports 的
main/non-free-firmware amd64 索引；变体本地包沿 frozen runtime 原有校验，
不能伪装成 Debian 官方签名包。
basic 内核仍是单独验证的 pack，不放进官方 APT archive 集合。

提供保存输入只将计划变为 `resolved-unverified`：

```powershell
node desktop\tools\build-live-skus.mjs --config desktop\release\debian\configs\standard-vm.yaml --plan --lock D:\build-inputs\vm-lock
```

执行时先核每个文件 hash/包身份，再在隔离 runtime 容器中：
用其 Debian archive keyring 对 InRelease 执行 `gpgv`，检查发行版/时间、
索引摘要和精确 `.deb` control/SHA256；以临时 **file-only** 源执行真正的
APT 解算模拟（分别 runtime+platform、全部阶段），不自造 Debian 依赖算法。
解算的是 YAML 请求，而不是把全部缓存 archive 当作用户主动请求。
锁中多余/缺少依赖、移除包、升级 frozen runtime 或不正确的阶段归属均失败。
这阶段不是普通 JSON 中 `authenticated: true` 可以跳过的布尔声明。
信任根是源码内 `desktop/release/debian/archive-trust.json` 固定的官方 Debian
keyring 路径与 SHA256，不接受 lock 自带 keyring。其 digest 来自现有已认证
stock 证据并与导出 keyring 字节相符；容器 keyring 更新后也会失败关闭，
必须经来源审查更新该源码策略，不能自动采信新 keyring。

之后各阶段只安装已认证的本地 archive，`--no-download --no-install-recommends
--no-remove`；最终检查实际 dpkg 全量集合严格等于锁。
配置路径的 platform/live `podman build` 也显式使用 `--network=none`，
覆盖 basic 安装器及包维护脚本的网络边界；旧联网 APT 构建入口不改变网络策略。
旧 CLI 的原有签名 APT 联网流程不改成“信任这个 JSON”；新配置路径是明确的
离线输入接口。签名过期/源版本消失时重新准备真实解析输入，不能关校验追绿。

## 4. 实际构建先决条件与命令

**下面是后续获得构建授权后的命令，不是本轮已经执行。**
Windows 可安装纯 JS 工具、检查配置和发布产物，
但真正 Debian/Live 组装必须在自己的 Linux x86_64 或 WSL2 Linux 内运行。
实现会话没有进入 WSL；复核会话仅在已有 WSL 主机执行短时纯 Python mock 单测，
没有启动共享构建机上的容器、执行真实 APT/签名检查或抢用内核编译资源。
基础 SDK/native/runtime 制作仍见 [常规构建指南](BUILDING.md)；
不要用 Windows GUI 二进制、未配对 wlroots 或旧完整 runtime 冒充 minimal。

配置执行所需输入：

- 干净、已提交的固定源码 checkout；输出必须在源码与 runtime 目录外且尚不存在。
- 已通过原 `package-contract`、完整性及来源校验的 Debian frozen runtime bundle。
- 该 bundle 对应的不可变 runtime image ID；配置锁必须同时绑定实际 manifest 和 image。
- 已有不可变 image-tools ID；本入口不构建 SDK/native/tools。
- 上节完整受控 APT 解析目录，含签名 snapshot 和本地 `.deb`。
- 选择 basic 时还需独立 `kernel-pack.json/kernel.config/kernel-image.deb`。
- Podman、Node.js、Bash；runtime 容器需原有 APT/gpgv/dpkg 工具，
  image-tools 需原有 Python/镜像工具。本轮未验证这些新执行路径的真实 Linux 运行。

Linux 命令（替换变量为真实输入）：

```sh
bash tools/build.sh --live "$OUTPUT" \
  --config desktop/release/debian/configs/standard-vm.yaml --build \
  --lock "$APT_INPUTS" --runtime-bundle "$RUNTIME_BUNDLE" \
  --runtime-image "$RUNTIME_IMAGE_ID" --tools-image "$TOOLS_IMAGE_ID"
```

basic 改用 `standard-basic.yaml` 并显式追加
`--basic-kernel-pack "$BASIC_KERNEL_PACK"`；其他硬件不接受此参数。
minimal 配置即使给了旧标准输入也会在任何构建动作前因 variant unavailable 失败。
`--config` 必须显式二选一 `--plan/--build`；
与 `--sku/--skus`、重复选项、相互冲突的 plan/build 同用会拒绝。
不要把 `--live` 与 GUI 的 `--run/--clean/--metal` 等混用。

旧入口保持语义：

```sh
bash tools/build.sh --live "$OUTPUT" \
  --runtime-bundle "$RUNTIME_BUNDLE" --runtime-image "$RUNTIME_IMAGE_ID" \
  --tools-image "$TOOLS_IMAGE_ID" --skus vm,intel,nvidia,amd,full
bash tools/build.sh --live --sku vm --plan
```

旧 `--sku/--skus` 不带 `--plan` 仍走原有实际组装；不要误当 dry run。
默认硬件仍是 full，普通无 `--live` 的 GUI 构建不变。
旧标准硬件入口与配置计划共用硬件/标准 runtime 合同，
不要求旧调用者去解析 YAML。

## 5. 阶段、产物与发布

| 阶段 | 输入与输出 |
| --- | --- |
| 解析/计划 | 安全 YAML → 严格规范化 → 阶段顶层请求/能力约束；可输出 unresolved/blocked |
| 冻结/预检 | 源码、原 runtime、lock/snapshot/archive 独立复制；记录 hash；真实签名及 APT 模拟先于任何镜像 build |
| runtime | 消费已有 frozen native；原包 pins、ABI、Mesa/SDL 修复与源码合同保持，不从 full bundle 删除文件 |
| platform | Containerfile 接收冻结配置 context，安装其 platform archive，保留硬件/kernel/PAM/网络校验 |
| boot/live | 同配置的 boot archive 与早期 Plymouth，实际全包集合与 lock 比较；保留独立 basic kernel 检查 |
| overlay/export | 记录实际 plan/lock、原 native manifest、覆盖文件和 dpkg status；保留原来源/权限/namespace 验证 |
| media/verify | 实际 ISO/USB 根字节、bootstrap、包清单、配置和来源收据交叉校验 |

新媒体名包括 `硬件-配置名-plan摘要前12位`，完整 hash 记录在收据中；
发布版本目录同样隔离配置，拒绝不同内容覆盖。
媒体附带 `resolved-plan.json`、`packages.lock.json`、
`configuration-sbom.spdx.json`（本次完整系统包视图及原 native manifest 引用）。
原 frozen runtime 的 native SBOM、build-inputs 和源码清单保持原样，
不会用新 metadata 伪造重新编译的 native。
实际 root 还保留 `/etc/polly-build-plan.json` 和 `/etc/polly-packages.lock.json`；
manifest、origin、root、sizeReport 和发布器必须一致。

组装入口**不自动发布，也不更新 `PollyOS.iso`**。
配置路径即使 hardware=full 或 name=standard-full，只有精确匹配原标准 full
能力、阶段请求与策略才有显式更新 alias 的资格；
添加额外包、改变能力等都没有该资格。非标准配置只能版本化发布。
旧无配置字段的 schema 1/2、已有标准 SKU 继续按旧合同只读验证，
不允许通过漏字段把配置产物降级为历史产物。

`build-run.json` 记录 preparing/assembling/complete/failed，日志保留第一处错误。
预检失败不进入 build，任何阶段失败不处理后续 SKU、不发布媒体。
APT 模拟、包完整性或 Node 测试成功都不等于真实启动、中文实画或硬件认证。

## 6. 不编译的测试与排查

从仓库根运行纯 Node 单元/CLI/外部模拟后端测试：

```powershell
node --test desktop\tests\live-config.mjs desktop\tests\live-profiles.mjs desktop\tests\publish-live-iso.mjs desktop\tests\live-sku-build.mjs
node desktop\tests\package-contract.mjs
node desktop\tests\release-report.mjs
```

也可在 `desktop/tools` 执行 `npm test`。旧 Linux-only 集成测试在 Windows 会跳过；
新测试直接调用实际 Node dispatcher、Git Bash 顶层 plan 入口（有 Git Bash 时）、
模拟的外部构建后端和真实文件系统发布验证，**不执行 Podman/APT/native 构建**。
缺少 Git Bash 会明确跳过 shell 用例，不冒称其覆盖。
Linux adapter 的签名/APT/镜像路径仍需单独真实验证。
另有纯 Python `unittest`，仅在已有 Python 的主机上运行：

```sh
python3 -I -B desktop/tests/live-config.py
```

该测试 mock 所有 gpgv/APT/dpkg 外部调用，未识别的 subprocess 调用直接失败；
覆盖身份/hash、信任根、来源/时间、包架构/清单、阶段解算及失败路径。
模拟 gpgv 的输出不是验证真实签名，也不执行真实 APT、容器或编译。

本分支固定实现版本 `18c11c85` 的非编译复核结果：
Windows Node 联合测试共 30 项，**26 项通过、0 项失败、4 项既有 Linux-only 测试跳过**；
原 package-contract 和 release-report 纯 JS 测试通过。
复核会话使用已有 WSL `/usr/bin/python3 -I -B` 运行上述 Python 单测，
**15/15 通过**。这仅验证 mock adapter 逻辑，不是实际签名认证、APT 解算/安装、
容器组装、启动或中文实画通过；旧 Linux-only 集成测试仍未因该 Python 结果获得资格。

| 错误/状态 | 排查 |
| --- | --- |
| 找不到 `yaml` | 在 `desktop/tools` 用 lock 执行 `npm ci --ignore-scripts`，不要全局安装或安装 native 工具 |
| `blocked / Native variant unavailable` | 不是缺一个环境变量；需要真正实现、制作并验证声明的 native 变体 |
| `unresolved / requires ... --lock` | 顶层包列表不是依赖闭包；提供受控 APT 解析输入，不猜测依赖填假锁 |
| `Standard ... cannot be relabelled` | 标准 native 闭包不能用配置裁剪；不要绕过 pins 或删除库文件 |
| snapshot/Release/archive 错误 | 核对有效期、发行版、完整索引、签名 keyring、精确包版本和 hash |
| APT stage solution 不一致 | 检查自动依赖/provider、stage 归属、基础 runtime 身份及是否误带额外 archive |
| root inventory/receipt/SBOM 不一致 | 不发布；保留 build.log/FIRST，核对真实安装结果与冻结计划 |
| stable alias 被拒绝 | 使用版本化发布，不把 name/hardware 标签当作默认能力合同 |

体积字段严格分层：顶层包 metadata 不是 closure，
`.deb` 总量只是 archive proxy，`size.isoBytes=null` 表示未测量。
现阶段没有 minimal 实测 ISO；WQY 安装大小或删除包的展开大小不能直接从 ISO 扣除。
实际 root 继续使用现有 gzip SquashFS，和各 `.deb` 的压缩算法、block、去重不同。
只有实际组装后 `sizeReport.media` 才是媒体测量，不将规划估计写成产物事实。
