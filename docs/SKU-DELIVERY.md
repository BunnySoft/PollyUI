# SKU 交付记录（2026-10-22）

当前产品只有三档：**Mini / Compact / Standard**。本页只记录这三档的交付边界；
旧产品名不再作为产品档位使用。

所有 ISO 都是 unsigned x86_64 UEFI 开发镜像，不代表通用物理机、Secure Boot
或恢复/安装资格。

## Standard（当前交付）

Standard 取代原完整硬件档，并把该档的完整驱动/固件、Wi-Fi/音频扩展和
常用命令载荷并入同一产品合同。

| 项目 | 实测结果 |
|---|---|
| ISO | **882,157,568 字节，882.16 MB / 841.29 MiB** |
| ISO SHA-256 | `902838e3004639abe82f94dd73077f950098bc4d4be428dc9ceb9ac896d80f95` |
| USB 原始镜像 | **934,281,216 字节，934.28 MB / 891.00 MiB** |
| USB SHA-256 | `9fbfc057a787b104638d2539ac293f014e8df6e58ba7e57db1d6f74b8214075d` |
| 构建入口 | `tools/build.sh --os standard`；配置 `configs/standard.yaml` |
| 原生变体 | `standard-effects4` |
| 硬件集合 | 内部 profile `standard`（原完整硬件集合） |
| 特效 | 全局窗口透明度、真实 2D 预览、Flip 3D、Canvas Aurora、原创兔子、本地静音视频壁纸、四工作区立方体和 Settings 控件 |
| 默认渲染 | Pixman/raster；3D 特效需在 `Advanced startup` 选择 GPU acceleration |
| 解码 | 独立 FFmpeg 9.0.2 LGPL-only 辅助进程；H264/VP8/VP9、MOV/Matroska；无音频、网络协议、GPL/nonfree 或硬件解码 |
| 依赖 | 411 个最终包、129 个新增归档；固定 keyring、签名/索引/归档核验和 file-only APT 解算 |
| ISO UEFI | UID 1000 PAM/logind、真实 DRM/KMS、中文提交、剪贴板和工作区切换 |
| USB UEFI | 同一桌面/输入检查；模拟 e1000e DHCP、网关 ping、系统 DNS、HDA 播放/采集枚举 |
| GPU 模式 | 同一媒体的 direct-kernel 启动；实际 GLES、virtio DRM/KMS；非 headless 注入 |
| 边界 | GPU 客机使用 llvmpipe；未实机验证 Wi-Fi、声音/录音、多屏、恢复或性能 |

原完整硬件档中曾单独记录的 Wi-Fi/音频扩展（Atheros/Broadcom/MediaTek/Intel/Cirrus
固件、ALSA UCM/topology）、Realtek 有线固件和 `standardUtilities` 命令组现在
都是 `standard.yaml` 的组成部分；不再存在单独的完整硬件档配置或媒体身份。

## Mini

| 项目 | 实测结果 |
|---|---|
| ISO | **65,286,144 字节，65.29 MB** |
| SHA-256 | `92389a08e6833c595b30fca7da2f248e905edef9d1655cc27a55558125faa899` |
| 底座 | Alpine / musl / BusyBox |
| Shell | PollyWM + PollyUI Shell；CPU UI/Canvas 2D |
| 排除 | WebGL2、WebGPU、软件 3D、中文字体/输入法 |
| 构建入口 | `tools/build.sh --os mini`；旧脚本 `desktop/release/micro/build-shell.sh` |

## Compact

Compact 的新 Debian 中文 CPU Shell + 基础 GOP/simpledrm 配方尚未集成。

- `tools/build.sh --os compact --plan` 明确返回 `blocked`
- `--build` 在外部动作前失败
- 历史 Thin / minimal-zh 镜像不是 Compact 交付

## 验证边界

- 源测试、定向 Release 回归和构建入口检查不等于全仓库测试全绿。
- 构建失败和首次失败证据单独保留；不把重跑通过当成首次通过。
- 媒体 manifest、锁、SBOM、原生来源和日志属于构建输出，不随 Git 提交。
- Standard 的离线 APT 锁仍由受控构建保存；仓库不自动采集或伪造锁。
