# 从干净机器编译 PollyUI、PollyOS 与 Live ISO

本文是构建入口，按仓库中实际脚本编排，不依赖维护者的会话目录、Podman 卷、
镜像 ID、已有 `D:\temp` 文件或预编译的 PollyUI。命令以仓库当前版本为准；
历史交付的实际源码、ISO SHA 和资格见 [交接记录](POLLYOS-HANDOFF.md)，不是构建输入。

## 1. 选择构建范围

| 目标 | 平台与入口 | 产物 |
| --- | --- | --- |
| 通用 GUI | Windows x64 / macOS / Linux，下面第 3、4 节 | `pollyui-engine` 静态库、`pollyui-playground` |
| 应用 Runtime | 同一顶层 CMake，`PU_BUILD_LAUNCHER=ON` | `pollyui`，含 QuickJS、GUI、SysRT；不是开始菜单本身 |
| 仅 SysRT | `cmake -S sysrt ...`，第 5 节 | FFI/执行库及独立原生测试，不需要 Skia/SDL |
| PollyOS 桌面 | **Linux x86_64 + Debian 13/glibc**，第 6 节 | PollyWM、Shell、Settings、Files、输入法等 |
| 开发 Live ISO | 第 6–8 节 | unsigned x86_64 UEFI、内存根文件系统的 `.iso` 和 `.img` |

当前 PollyWM **不能用系统原装 wlroots 或历史 Alpine SDK 替代**。Windows 原生
构建也不能直接生成 Linux ISO：在 Linux 或自己的 WSL2 Linux 环境中运行
Debian/Podman 流程。Apple Silicon 的原生 GUI 不等于 ARM ISO 支持；跨架构仿真
不是本文验证过的发行路径。安装版 VHDX、物理安装器、Recovery 与更新系统不是
Live ISO 构建的副作用，见 [Debian 说明](../desktop/release/debian/README.md)。

### 可复建与相同字节是不同目标

本文提供完整的源码/配方入口和检查方式，**不宣称在任意未来日期都能下载依赖，
也不保证另一台机器得到与已发布 ISO 相同的 SHA256**：

- QuickJS、Yoga 在仓库内；Skia/SDL/HarfBuzz/wlroots 等外部源码按版本或摘要校验。
- Debian 基础镜像、APT 索引、内核和部分系统依赖仍来自可变仓库；Mesa、
  libinput、Plymouth、polkit 等还要求特定版本可用。版本被移出仓库时应停止，
  不能删除校验或随意升级来冒充原配对。
- 构建编译器、包时间戳、SBOM 时间、文件系统和工具版本可能改变输出字节。
  同一源码不等于同一 SDK 二进制，更不等于相同 ISO。
- 长期重建要同时保存源代码、SDK/基础/工具 OCI 镜像、依赖源码及包、版本清单、
  摘要和实际构建参数；仅有 ISO、CMakeCache 或几个镜像 ID 不够。

本指南中的新机器全量联网路线需要实际在目标机器执行并保存结果；本次文档审查
不冒充一次全新机器的完整 Skia/Mesa/ISO 重建或硬件资格。

## 2. 机器、工具与源码

### 建议环境

- 桌面/ISO：原生 Linux x86_64，或 Windows + WSL2 的 Linux x86_64。
  容器由 Podman 运行；宿主不必也是 Debian，容器内必须是 Debian 13 trixie。
- 宿主需要 Git、Podman、POSIX shell；Debian 流程下面使用 Bash 并启用 pipefail。
  Windows 最后校验/发布还需要 Node.js。
  普通 GUI/测试建议 Node.js 22、Python 3.12+、CMake 3.31+、Ninja。
  项目最低 CMake 为 3.25；不要用旧 Node 运行 `node:module.register` 等测试。
- 为完整 SDK（尤其 Mesa）预留数十 GB 空间，建议至少 100 GiB 可用空间、
  16 GiB 内存，32 GiB 更宽裕。不是已测最低配置；容器 VM 也要实际分配这些资源。
- 首次构建需要访问 Debian、GitHub、freedesktop.org 等依赖源。下载可能很大；
  全流程不是 `--network=none`。离线运行要求先按第 9 节准备完整输入。
- 不需要宿主安装 GNOME/KDE、修改用户账户或运行系统安装器。首次 debootstrap
  只在构建容器命名空间中需要 `SYS_ADMIN`；不要改用 `--privileged` 或挂入宿主磁盘。

安装 Git/Podman 并按其发行版文档完成普通用户配置后先检查：

```sh
git --version
podman --version
podman info
uname -m
```

Windows 请在 **WSL 的 Linux shell** 中执行下面 Debian 命令；推荐把源码和构建
目录放到该 Linux 用户的文件系统，而不是 `/mnt/c`、`/mnt/d`。不要照抄维护者的
`podman-machine-default`、`enterns` 或其他用户专属工具路径。Podman Machine 用户
须自行确认挂载路径和虚拟机资源，不能假设 Windows 路径可由远端引擎直接读取。

### 桌面/ISO 使用独立、固定且字节明确的 Linux checkout

以下变量在**同一个 shell 会话**中一直使用。目录首次必须不存在：

```sh
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
export WORK="$HOME/polly-build"
mkdir -p "$WORK"
git clone --no-checkout https://github.com/BunnySoft/PollyUI.git "$WORK/source"
cd "$WORK/source"

# 默认固定本次获取的 main；重建旧版本时，把右侧改为所需完整 40 位提交。
REV=$(git rev-parse origin/main)
export REV
# 仅此 clone 禁止 checkout 文本转换，保留 Git blob 字节；不改版本化属性。
printf '* -text\n' > .git/info/attributes
git -c core.autocrlf=false checkout --detach "$REV"

export REPO="$PWD"
export OUT="$WORK/artifacts-$REV"
export BUILD_VOLUME="polly-build-$(printf %.12s "$REV")"
test ! -e "$OUT"
mkdir "$OUT"
git rev-parse HEAD > "$OUT/source-revision.txt"
git rev-parse 'HEAD^{tree}' > "$OUT/source-tree.txt"
test -z "$(git status --porcelain --untracked-files=normal)"
git diff --exit-code
git diff --cached --exit-code
```

QuickJS-ng/Yoga 已 vendored，不需要从别的机器复制 `build`，也不需要初始化它们
内部的可选测试子模块。生成目录全部放在 checkout 外，避免打包时被标记 dirty。
工作中需要编辑源码时请先提交，再用独立干净 clone 构建候选。

`.gitattributes` 明确要求 PowerShell 等脚本 checkout 为 CRLF；**即使在 Linux，
`core.autocrlf=false` 也不会覆盖显式的 `eol=crlf`**。`git archive` 同样不能被当作
“所有 raw blob 字节”的天然证明。以上 clone-local attributes 用于严格源码字节
检查；不要对 PNG、字体或其它二进制做换行转换。Windows GUI 开发可以普通 clone，
但那与用于冻结发行的 canonical 字节检查是两个概念。

## 3. Windows x64：GUI 与应用 Runtime

安装 Visual Studio C++ Build Tools/Visual Studio（C++ 桌面工作负载、Windows SDK
以及 bootstrap 使用的 vcpkg 组件）、
LLVM clang-cl/lld、CMake、Ninja、Git、Node.js 22。进入 **x64 Developer PowerShell**，
确保 MSVC 的 `INCLUDE/LIB/PATH` 已在当前 shell 生效。
`tools/build.ps1` 默认查找 LLVM/CMake 的标准安装目录；自定义安装时使用下面手动 CMake。

```powershell
git clone https://github.com/BunnySoft/PollyUI.git D:\src\PollyUI
Set-Location D:\src\PollyUI

.\tools\fetch_skia.ps1
.\tools\bootstrap-sysrt.ps1
cmake --preset win-clang -DPU_WEBGL2=OFF -DPU_WEBGPU=OFF -DPU_BUILD_DESKTOP=OFF
if ($LASTEXITCODE -ne 0) { throw "Configure failed" }
cmake --build --preset win-clang --parallel 2
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

$env:PU_RENDERER = 'raster'
.\build\win-clang\gui\pollyui-playground.exe --test gui\tests\smoke.js
if ($LASTEXITCODE -ne 0) { throw "Smoke test failed" }
ctest --test-dir build\win-clang --output-on-failure --no-tests=error -R '^gui-layout-'
if ($LASTEXITCODE -ne 0) { throw "Layout tests failed" }
.\build\win-clang\pollyui.exe gui\examples\playground\gallery.mjs
```

- `bootstrap-sysrt.ps1` 使用该 VS 安装的 vcpkg 及 `sysrt/vcpkg.json` 中的
  baseline，将 **x64-windows-static** libffi 安装到 `build\sysrt-deps`。
  Skia 和工程需匹配静态 CRT `/MT`；不要混用任意 `/MD` 或 Debug 预编译库。
- 仅需 GUI：省略 libffi bootstrap，configure 加 `-DPU_BUILD_LAUNCHER=OFF`，
  运行 `build\win-clang\gui\pollyui-playground.exe`，不运行不存在的 `pollyui.exe`。
- 上面主动关闭 WebGL2/WebGPU，避免把可选 GPU 依赖当作通用 GUI 的必要输入。
  Windows/Linux 的 `PU_WEBGL2` 默认是 ON，缓存旧值不会因换目录外的环境而改变。
- 若启用 Windows WebGL2，先按 [WebGL2 指南](../gui/sdk/WEBGL2.md) 执行
  `tools\fetch_webgl_angle.ps1`、`tools\fetch_vulkan_headers.ps1`，重新 configure
  `-DPU_WEBGL2=ON`。`tools\fetch_angle.ps1` 的窗口呈现 ANGLE 与 WebGL2 私有 provider
  不是同一个部署步骤。Dawn/WebGPU 另见 [WebGPU 指南](../gui/sdk/WEBGPU.md)，默认 OFF。
- 不要把 Windows `.lib/.dll`、这个 CMakeCache 或 Skia 预编译包拿去链接 Linux。
  切编译器/平台/CRT时用**新的构建目录**，不要删除整个仓库来“清理”。

## 4. macOS 与 Linux 的通用 GUI

macOS 先安装 Xcode command-line tools，然后：

```sh
set -eu
brew install cmake ninja sdl3 libffi pkg-config node python
export PKG_CONFIG_PATH="$(brew --prefix libffi)/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
bash tools/fetch_skia.sh
cmake --preset mac-sdl-metal -DPU_METAL=OFF -DPU_WEBGL2=OFF -DPU_WEBGPU=OFF
cmake --build --preset mac-sdl-metal --parallel 2
PU_RENDERER=raster ./build/mac-sdl/gui/pollyui-playground --test gui/tests/smoke.js
./build/mac-sdl/pollyui gui/examples/playground/gallery.mjs
```

预设名 `mac-sdl-metal` **不代表默认打开 Metal**。可选 Metal 需要
`tools/build_skia_metal.sh` 生成同版本 Metal Skia 并显式指定
`-DPU_METAL=ON -DSKIA_ROOT=... -DSKIA_LIB_DIR=...`；ANGLE/Metal WebGL2 又是另一条
可选路线，源码存在不代表 macOS 编译/物理执行已认证。不要用 Rosetta x64 库链接
原生 arm64 程序。macOS GUI 不是当前 Debian ISO 的生产环境。

Linux 的最短、依赖一致路线是先构建第 6 节 SDK，再把第 6 节 CMake 的
`PU_BUILD_DESKTOP/PU_DESKTOP_SERVICES/PU_BUILD_IME_ENGINE/PU_BUILD_SESSION_AUTH`
都设为 OFF，仍保 `PU_HOST=sdl`。这样使用 SDK 的 Skia、SDL 和 libffi 编译 GUI/
Runtime，不需要启动合成器。若只需 GUI，也可 `PU_BUILD_LAUNCHER=OFF`。
选择宿主原生依赖时，必须自行满足顶层 CMake 的 Fontconfig/FreeType、图像编解码、
SDL3/Wayland、libffi、libcurl 和静态 HarfBuzz 要求；具体配方以
`desktop/release/debian/Containerfile.sdk` 为准，不用 Linux Skia 下载脚本替代源码构建。

## 5. 单独编译 SysRT

不需要 Skia、Yoga、SDL 或桌面会话。Linux 需要 C/C++ 构建工具、CMake、Ninja、
pkg-config、libffi 3.4+、libcurl 开发包、Python、Node；D-Bus 额外测试需要
libdbus 开发包和 `dbus-daemon`。在仓库根目录、已具备这些原生依赖的 Linux shell
中使用新目录：

```sh
SYSRT_BUILD="$HOME/polly-sysrt-build"
cmake -S sysrt -B "$SYSRT_BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$SYSRT_BUILD" --parallel 2
ctest --test-dir "$SYSRT_BUILD" --output-on-failure --no-tests=error \
  -R '^sysrt-(ffi|ownership|callbacks|callback-shutdown|async|async-shutdown|async-lifetime|process|network)$'
```

Windows 在 Developer PowerShell 中先运行 libffi bootstrap，使用新构建目录和
`clang-cl` 编译器；可显式指定
`-DSYSRT_LIBFFI_ROOT=D:\src\PollyUI\build\sysrt-deps\x64-windows-static`。
Linux 的文件 ABI 生成器只支持 Linux x86_64 little-endian/LP64，不能在 Windows
运行后把输出标作 Linux 目标；正常 Linux 打包会重新 `--check`。
若使用第 6 节 SDK 而不在宿主安装依赖，可在同样的 Podman `/workspace` 源码挂载、
`/build` 卷挂载内运行上面命令，把 `SYSRT_BUILD` 改为 `/build/sysrt`。

## 6. 从零构建 Debian SDK 和整个桌面

以下继续使用第 2 节的 Linux shell、`REPO/OUT/REV/BUILD_VOLUME`。
首次 SDK 构建要联网，包含 Skia 和完整 Debian Mesa 本地包重编，可能耗时很长：

```sh
cd "$REPO"
sh desktop/tools/build-debian-sdk.sh 2>&1 | tee "$OUT/sdk-build.log"
```

这里的 `sh` 是执行已有脚本；外层仍为第 2 节启用 `pipefail` 的 Bash。
不要在执行到 `local-packages.json` 生成前，把一个只装过编译器的镜像当作完整 SDK。

该命令生成两个本机 Podman 标签：

1. `localhost/polly-debian-minbase`：`debootstrap` 创建的 Debian 13 最小 rootfs。
2. `localhost/polly-debian-sdk`：从该 rootfs 编译并安装依赖的开发镜像。

这是现有便捷脚本的固定标签，会更新同名标签；在专用构建引擎运行，不与其他
构建并发。本流程 shell 已启用 `pipefail`，保证 `tee` 不吞掉构建失败；如果选择
普通 `sh`，直接不接管道执行脚本并检查其退出码。
以下所有 build/package 错误都应停止，不继续用旧缓存产物。

固定真实镜像 ID，后续不用会变化的标签：

```sh
SDK_ID=$(podman image inspect --format '{{.Id}}' localhost/polly-debian-sdk)
MINBASE_ID=$(podman image inspect --format '{{.Id}}' localhost/polly-debian-minbase)
export SDK_ID MINBASE_ID
printf '%s\n' "$SDK_ID" > "$OUT/sdk-image-id.txt"
printf '%s\n' "$MINBASE_ID" > "$OUT/minbase-image-id.txt"
podman image inspect "$SDK_ID" > "$OUT/sdk-image-inspect.json"
podman volume create "$BUILD_VOLUME"
```

### SDK 里究竟包含什么

| 依赖 | 来源/固定点 | SDK 内位置 |
| --- | --- | --- |
| Skia | `08a5439a6be726021c1c1905d23ce298a3edc5e4`，m124，Clang 18/GN | `/opt/pollyui-skia` |
| SDL | 3.4.10 / `8e37db5e...` + 受校验 Wayland lifetime patch | 源码 `/opt/pollyui-sdl`，库 `/usr/local/lib` |
| HarfBuzz | 13.2.1 / `6f4c5cec...`，关闭 GLib/GObject 等的静态构建 | 源码 `/opt/pollyui-harfbuzz`，prefix `/opt/pollyui-text` |
| wlroots | 0.19.3 + `sources.json` SHA512 + 当前 scene-effects patch SHA256 | `/opt/pollyui-wlroots-effects4` |
| libinput | `libinput.json` 指定 Debian source，私有无 libwacom 构建 | `/opt/pollyui-input` |
| Mesa | `mesa.json` 固定 source `.dsc`/archive hash + lifetime patch | 本地包缓存 `/opt/pollyui-local-debs/mesa` |
| 系统包 | signed trixie/security/updates + 选定 backports | dpkg 库及 `/usr/share/polly-sdk-packages.txt` |

**“配对 SDK”就是这些原生头文件/库/配方，不是 JS SDK。** 合成器校验 ABI 及
嵌入式源码 pin；即使 FIR 开关关闭也需要匹配的 wlroots。以
`desktop/release/debian/wlroots-effects.json` 和 patch 实际 SHA 为权威，
不要把某次编译库的 `40a2...` 二进制 SHA 当作其他编译器必须产出的值。
本配方自动构建当前库，不要求复制维护者的 C6 库或 `polly-fir-optin-*` 卷。

先检查配对库及后续打包所需的实际工具/依赖：

```sh
podman run --rm --pull=never --network=none \
  -v "$REPO:/workspace:ro" "$SDK_ID" sh -ec '
    python3 desktop/release/debian/apply-wlroots-effects.py \
      /opt/pollyui-wlroots-effects4 --check-installed
    pkg-config --modversion wlroots-0.19 sdl3 harfbuzz libffi
    dpkg-query -W file libmagic1t64 libmagic-mgc libinput-bin
    test -s /opt/pollyui-local-debs/mesa/local-packages.json
    python3 desktop/tools/local-debian-packages.py /opt/pollyui-local-debs/mesa
  '
```

源码里的 SDK 配方显式安装 `file` 和 `libinput-bin`，因为打包器会把它们列为运行时
依赖根；不能依靠旧开发镜像碰巧装过它们。SDK 中原源码目录的 Git metadata、
许可证和 Mesa `.deb` 及其 JSON 都必须保留，只有 `.so/.a` 不足以打包。

### Configure / build

```sh
podman run --rm --pull=never --network=none \
  -v "$REPO:/workspace:ro" -v "$BUILD_VOLUME:/build" "$SDK_ID" \
  cmake -S /workspace -B /build/release -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DPU_HOST=sdl \
    -DSKIA_ROOT=/opt/pollyui-skia \
    -DSKIA_LIB_DIR=/opt/pollyui-skia/out/Release-linux \
    -DSDL3_DIR=/usr/local/lib/cmake/SDL3 \
    -DPU_BUILD_LAUNCHER=ON -DPU_BUILD_DESKTOP=ON -DPU_DESKTOP_SERVICES=ON \
    -DPU_LAYER_SHELL=ON -DPU_BUILD_IME_ENGINE=ON -DPU_BUILD_SESSION_AUTH=ON \
    -DPU_WEBGL2=OFF -DPU_WEBGPU=OFF -DPU_METAL=OFF \
    -DCMAKE_INSTALL_BINDIR=bin -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_INSTALL_DATADIR=share '-DCMAKE_INSTALL_RPATH=$ORIGIN/../lib/pollyui'

podman run --rm --pull=never --network=none \
  -v "$REPO:/workspace:ro" -v "$BUILD_VOLUME:/build" "$SDK_ID" \
  cmake --build /build/release --parallel 2
```

这会构建 GUI、应用 Runtime、SysRT、PollyWM、Rime engine、认证辅助程序及所启用测试。
`--parallel 2` 可改为 1；SDK 内部分依赖和打包脚本仍有固定 `-j2`，不是设置一个
环境变量就能限制所有进程。Skia 源码编译支持 `PU_BUILD_JOBS`；不要同时开多条重构建。
容器中的 `/build` 是原生 Linux 卷，避免 Windows 挂载上的 Ninja/IPO `EIO`。

### 定向检查与普通用户运行

```sh
podman run --rm --pull=never --network=none \
  -v "$REPO:/workspace:ro" -v "$BUILD_VOLUME:/build" "$SDK_ID" \
  sh -ec '
    node --test tests/module-boundaries.mjs
    python3 sysrt/tools/generate-files-abi.py --cc /usr/bin/cc --check
    PU_RENDERER=raster /build/release/gui/pollyui-playground --test gui/tests/smoke.js
    ctest --test-dir /build/release --output-on-failure --no-tests=error \
      -R "^(gui-layout-|desktop-fir-backend$|desktop-wlroots-effects-dependency$)"
  '
```

不要把“选中的检查通过”写成整个 CTest/OS 已通过。需要完整原生/ASan 资格时参阅
`desktop/tools/check-debian-runtime.sh` 和 [Debian 说明](../desktop/release/debian/README.md)；
它有自己的构建选项、正常/消毒目录和完整测试，不能把 sanitize 目录拿去打包。
真实设备/服务用例可能有额外输入，SKIP 和 unsupported 不是通过。

## 7. 运行时打包、容器与 ISO

继续使用同一个 `$REPO`、`$SDK_ID` 和 `/build/release`，输出仍在源码树外：

```sh
podman run --rm --pull=never --network=none \
  -v "$REPO:/workspace:ro" -v "$BUILD_VOLUME:/build" -v "$OUT:/artifacts" \
  "$SDK_ID" node desktop/tools/package-linux.mjs \
    /build/release /artifacts/runtime /opt/pollyui-sdl /opt/pollyui-harfbuzz

podman run --rm --pull=never --network=none \
  -v "$REPO:/workspace:ro" -v "$OUT:/artifacts:ro" "$SDK_ID" \
  node desktop/tests/package-manifest.mjs /artifacts/runtime --frozen
```

打包器**会重新 configure，并 clean-first 重编 `pollyui/pollywm`**，核验文件 ABI、
配对 wlroots、动态依赖、CMake 安装清单、SDL patch 和实际源码输入前后相等；
不是把以前 build 目录里任意 executable 复制出来。内部重编有 600 秒命令期限；
极慢/内存不足机器超时属于失败，不应继续发布不完整目录或擅自去掉校验。

`runtime/` 应包含 `rootfs/`、运行时 tar.gz、`manifest.json`、`build-inputs.json`、
`runtime-packages.txt`、`sbom.spdx.json`、`SHA256SUMS`、生成的 Containerfile、
本地 Mesa 包及摘要/来源。所有镜像打包文件均是普通文件，无物理设备写入。
`--frozen` 还要求实际 Git clean 及 `revisionSource=git`。

### 生成普通用户 Runtime 镜像

```sh
RUNTIME_TAG="localhost/polly-runtime:$(printf %.12s "$REV")"
podman build --build-arg "MINBASE_IMAGE=$MINBASE_ID" \
  -t "$RUNTIME_TAG" -f "$OUT/runtime/Containerfile" "$OUT/runtime"
RUNTIME_ID=$(podman image inspect --format '{{.Id}}' "$RUNTIME_TAG")
export RUNTIME_ID
printf '%s\n' "$RUNTIME_ID" > "$OUT/runtime-image-id.txt"

# 这是容器内普通 UID1000 的 headless Shell/WM/IME/audio 健康检查，不是引导 OS。
podman run --rm --pull=never --network=none --shm-size=128m "$RUNTIME_ID"
```

Runtime Containerfile 会联网从 APT 安装打包时**实际解析的精确版本**及校验过的
本地 Mesa `.deb`。所以这个 `podman build` 不是离线步骤；`--network=none` 是后面的
runtime 检查。如果某个精确包已不可下载，需要保存的包/对应快照源，不能用
`apt upgrade` 或删掉版本号绕过。普通 `pollyui` 和 PollyShell 由 UID1000 运行，
不要把容器构建时的 root 当作桌面运行身份。

### 生成 memory-only UEFI ISO

```sh
cd "$REPO"
POLLY_RUNTIME_IMAGE="$RUNTIME_ID" \
  sh desktop/tools/build-live.sh --debian "$OUT/live"
cd "$OUT/live"
sha256sum -c SHA256SUMS
cd "$REPO"
```

该脚本将：

1. 从当前 runtime 生成 `live-base` 与独立的 locked `platform-base`，
   安装内核/固件/Live 服务、polkit 和 Plymouth；普通 Live 使用公开开发账号。
2. 检查实际 Debian Live payload，再构建含 GRUB/xorriso/QEMU/OVMF 等的工具镜像。
3. export rootfs 到普通 `root.tar`，在工具容器内生成 UEFI ISO 与 GPT/FAT32 USB
   **文件**，输出源码身份、package inventory、`live-manifest.json` 和摘要。

它要联网，并使用/更新固定标签 `localhost/polly-debian-live-base`、
`localhost/polly-debian-platform-base`、`localhost/polly-debian-live-tools`；
在隔离构建引擎运行。它不会写入 USB 设备、安装系统或启动 QEMU。
不要与另一个修改这些标签的构建并发；记录实际 ID，不只记录标签：

```sh
LIVE_ID=$(podman image inspect --format '{{.Id}}' localhost/polly-debian-live-base)
TOOLS_ID=$(podman image inspect --format '{{.Id}}' localhost/polly-debian-live-tools)
export LIVE_ID TOOLS_ID
printf '%s\n' "$LIVE_ID" > "$OUT/live-base-image-id.txt"
printf '%s\n' "$TOOLS_ID" > "$OUT/live-tools-image-id.txt"
podman image inspect "$LIVE_ID" > "$OUT/live-image-inspect.json"
podman image inspect "$TOOLS_ID" > "$OUT/live-tools-image-inspect.json"
```

典型输出（版本读取 `desktop/VERSION`，不是此处写死 alpha 号）：

```text
artifacts-<revision>/
  runtime/
  live/
    pollydesktop-<version>-debian13-x86_64-uefi-live.iso
    pollydesktop-<version>-debian13-x86_64-uefi-usb.img
    live-manifest.json
    SHA256SUMS
    ... GRUB、内核/包清单等实际输出
```

这是**可构建的开发介质路径**，不自动等于历次正式交付包的 125 条冻结证据，
也不自动生成 `candidate-origin.json`；下面两种校验/发布等级不要混淆。

## 8. 校验、启动与发布边界

### 基础开发介质

先保存 `runtime/manifest.json`、`build-inputs.json`、全部 SHA 与镜像 ID。
`sha256sum -c` 能发现导出后损坏；打包/Live 检查能发现对应资源和配方不一致。
它们都**不是实际 UEFI 启动成功**，也不是第三方源码/许可证分发审计结论。

若要在自己授权的隔离测试环境启动基础 QEMU/OVMF，用同一 source/harness 和
新的 evidence 目录，例如：

```sh
VERSION=$(tr -d '\r\n' < desktop/VERSION)
podman run --rm --pull=never --network=none \
  -v "$REPO:/workspace:ro" -v "$OUT:/artifacts" "$TOOLS_ID" \
  python3 -u -B /workspace/desktop/tests/live-boot.py \
    "/artifacts/live/pollydesktop-$VERSION-debian13-x86_64-uefi-live.iso" \
    /artifacts/uefi-baseline
```

默认无 `/dev/kvm` 映射会使用可用的 TCG；宿主已有、当前用户已获准使用 KVM 时，
可显式增加 `--device /dev/kvm`，不要为构建修改宿主权限。原 fixture 为 4 GiB/
2 vCPU、只读介质、无 guest 硬盘/NIC/宿主共享或 host audio。失败要保留首次日志，
不能把换内存/超时后的通过重标首次通过。QMP quit 不是用户关机资格。
`--new-architecture` 另需实际截图审批、精确 runtime/harness revision 等输入，
不能通过空参数当作完整 Apps 验收。此节提供用户执行方法，本次写文档不运行 VM。

### 冻结交付级：实际 ISO 内容与运行时绑定

仓库还提供更严格、需要保留额外输入的路径：

- `desktop/release/debian/Containerfile.offline-live`
- `desktop/tools/offline-live-overlay.py`
- `desktop/tools/verify-live-runtime.py`
- `desktop/tools/publish-live-iso.mjs`

这不是对普通 `live/` 执行一次重命名。离线 overlay 必须有固定 Live base、
真实干净 Git runtime、明确的离线 `.deb` 包及 `input-pack.json`、frozen source/
producer。成功后镜像内有 `usr/share/pollyui/runtime-origin.json`。
`verify-live-runtime.py` 还要求 `inputs/root.tar`、同一 origin JSON、
`inputs/frozen-overlays/<每个实际 overlay 路径>` 和原 `runtime/` bundle，不能用旧
origin/截图或手写一个 `PASS` 填补。`Containerfile.offline-live` 的 COPY/ARG
就是 context 契约；不要把普通 online Live 冒充已执行此验证的 frozen overlay。

在这些输入已实际准备并保留时，工具容器中的真实校验命令是：

```sh
python3 -I -B desktop/tools/verify-live-runtime.py \
  /artifacts/live /artifacts/runtime /artifacts/inputs \
  --producer-revision "$REV"
```

它从**实际 ISO**提取 initramfs，逐文件比较 bytes/mode/owner、overlay origin，
拒绝遗漏/意外旧 Polly 文件，生成 `candidate-origin.json` 并追加摘要。
输出不能重复覆盖；输入不齐就明确不具备该级别资格。
历次交付的额外 native/资源/无启动等回执由各次构建真实记录，不应从旧包复制
到新包并声称重测。第 9 节说明怎样迁移已有完整离线输入。

### Windows 文件复制及固定入口

普通开发输出可整个复制到 Windows 新目录，用 `Get-FileHash -Algorithm SHA256`
与 `live-manifest.json` 的值核对；ISO 仍是普通文件。若已具有上面的完整
`candidate-origin.json` 与覆盖整个交付包的 `SHA256SUMS`，再用标准发布器：

```powershell
Set-Location D:\src\PollyUI
node desktop\tools\publish-live-iso.mjs D:\artifacts\verified-live-bundle
Get-FileHash -Algorithm SHA256 D:\temp\PollyOS\PollyOS.iso
```

默认写到 `D:\temp\PollyOS`，创建版本目录并原子硬链接 `PollyOS.iso`。
非 Windows 或其它目录要显式传 `--destination`；硬链接要求同一支持该能力的
文件系统。**不要对只有普通 builder 输出的目录伪造 `candidate-origin.json` 来
通过发布器**。Windows sharing violation 时保留新版本，由用户自行处理光盘
句柄，不自动关闭/卸载用户 VM。该工具不把 ISO 上传到 GitHub，也不把大镜像提交 Git。

## 9. 把构建能力移到另一台机器：离线输入清单

新机器首次可按第 2、6、7 节联网从配方生成 SDK，不依赖维护者缓存。若要离线或
长期重建，将**实际输入**作为可移交产物准备，而不是只交一个历史 ID：

| 输入 | 至少保存的内容 |
| --- | --- |
| 项目源码 | 完整提交/父链、Git bundle 或 repository、HEAD/tree、文件字节/模式清单、dirty 状态 |
| SDK | OCI 镜像归档，image inspect/digest、编译器版本、wlroots ABI/pin/installed receipt、Skia/SDL/HarfBuzz 源码 Git metadata、私有库、本地 Mesa 包与 `local-packages.json`/`source-inputs.json` |
| 基础与工具 | minbase、runtime（若复用）、Live base、image-tools 各自 OCI 归档及实际 ID |
| APT/源码 | 实际包版本与 `.deb`/source inputs、签名/摘要、仓库快照来源；Plymouth 两包等精确 closure |
| overlay | 与所选 recipe 相符的 frozen/producer/runtime/offline-inputs context，明确 `input-pack.json`，及 export root/实际 overlay 文件和 origin |
| 结果 | runtime/media manifest、完整 SHA、SBOM、命令/退出码、首次失败和各层资格；新构建不能借旧 boot PASS |

在已成功构建的 Linux 机器保存输入（路径仍在源码外）：

```sh
mkdir "$OUT/portable"
git bundle create "$OUT/portable/source.bundle" --all
podman save --format oci-archive -o "$OUT/portable/sdk.oci.tar" "$SDK_ID"
podman save --format oci-archive -o "$OUT/portable/minbase.oci.tar" "$MINBASE_ID"
podman save --format oci-archive -o "$OUT/portable/runtime.oci.tar" "$RUNTIME_ID"
podman save --format oci-archive -o "$OUT/portable/live-base.oci.tar" "$LIVE_ID"
podman save --format oci-archive -o "$OUT/portable/tools.oci.tar" "$TOOLS_ID"
(cd "$OUT/portable"; sha256sum source.bundle *.oci.tar > SHA256SUMS)
```

用安全传输把整个输入包和关联清单复制到新机器，先验证，再 load：

```sh
cd /path/to/copied/portable
sha256sum -c SHA256SUMS
podman load -i sdk.oci.tar
podman load -i minbase.oci.tar
podman load -i runtime.oci.tar
podman load -i live-base.oci.tar
podman load -i tools.oci.tar
```

随后用保存的 inspect/实际加载镜像重新确认 ID 和内容，clone bundle、应用第 2 节
checkout 字节策略，重新选择输出卷/目录；**不能假设导入后的标签仍是预期值**。
执行校验/原生构建时 `--pull=never --network=none`，不更新共享镜像标签。
默认 `build-live.sh` 仍会 apt/build，**不因为缓存存在就变成离线入口**：
离线生成应对已核验的 immutable Live base 使用上述 offline overlay 配方，或在
确认其完整 payload 与当前源码/运行时一致后，export 该确切镜像再调用
`build-live-image.py`，保留真实来源。旧 base 内含旧 Polly 文件时禁止直接复用。

包归档由源码缓存/SDK 保留不等于已经满足全部许可分发要求；
发布前还需单独检查 [许可证与来源任务](POLLYOS-PLAN.json)。

## 10. 常见失败与定位顺序

| 症状 | 应检查/处理 |
| --- | --- |
| 找不到 Skia、SDL3、libffi | 先区分 GUI/launcher/desktop；确认目标平台、对应静态 CRT/架构、prefix 和 CMake 目录；不要从别的平台复制库 |
| `wlroots scene effects` ABI/pin 拒绝 | 从当前 patch/recipe 重建 SDK 并检查 installed receipt 和实际库；相同 SONAME 不代表相同源码，勿伪造 receipt |
| GN/Skia 编译器 intrinsic 错误 | 当前 Linux Skia 使用 Clang 18；不要直接换成任意最新 Clang |
| `file`/`libmagic`/`libinput-bin` 缺包 | 重建包含这些 runtime roots 的当前 SDK；不是允许打包器跳过系统依赖 |
| Mesa/libinput/Plymouth/polkit 特定版本缺失 | 核对 recipe 和签名仓库可用性，使用完整保留包/快照；不放宽 pin 或混入新二进制 |
| Windows shell 能看 Git，容器内不能 | Windows worktree 的 `.git` 可能指向不可解析的绝对路径；使用 Linux 中独立 clone/bundle checkout；外部 revision label 不是 `--frozen` 所需 Git 证据 |
| raw 文件比较失败但 `git status` 干净 | 核对 `.gitattributes` checkout 转换与 blob 字节，使用 clone-local `* -text`；不批量转换二进制 |
| Ninja/IPO `EIO`、构建很慢 | 将生成目录和最好源码都移至原生 Linux 文件系统/卷，确认内存和磁盘；不要禁掉检查当作修复 |
| SHM `ENOSPC`/SIGBUS 或压力测试失败 | 核对容器 `/dev/shm` 大小及同 namespace 占用；保留原失败，不任意扩大测试约定预算追绿 |
| `unknown`/dirty 的应用构建身份 | 使用真实 Git clone 和同一 revision；打包过程中别改 source；不要用环境变量伪造 clean 身份 |
| 输出目录已存在 | 选新的明确目录，别覆盖旧回执/镜像；不要递归清理共享 workspace |
| hash/模式/owner/旧文件残留失败 | 停止发布，按实际包与镜像来源定位；不要只改 SHA 清单使其“通过” |
| 有 ISO 但不能启动/应用失败 | 保留 serial/manifest/源码与平台信息；内容校验不替代 boot、完整 App 或物理验收 |

最后记录：完整 revision/tree、实际 compile flags、SDK ABI/pin、OCI IDs、runtime
和 media manifest、ISO bytes/SHA、哪些检查真正执行、哪些 NOT RUN/unsupported。
默认 `POLLY_EXPERIMENTAL_FIR` 与 `POLLY_EXPERIMENTAL_LAYOUT` 均 unset/0；显式 `1`
只选择各自实现，不自动开启材质/扩权限或取得性能资格，详见
[Live 开关说明](../desktop/LIVE.md#optional-native-backends-in-current-source-builds)。
