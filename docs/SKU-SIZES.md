# PollyOS SKU 技术栈与尺寸

功能、组件和待定能力见 [SKU 矩阵](SKU-MATRIX.md)；实际交付边界见
[SKU 交付记录](SKU-DELIVERY.md)。

## 当前三档

| SKU | 底座 | 桌面/中文 | 驱动范围 | 当前实测 |
|---|---|---|---|---|
| **Mini** | Alpine / musl / BusyBox | PollyWM + PollyUI Shell；CPU UI/Canvas 2D；无中文/IME/3D | UEFI GOP/simpledrm + virtio | 65.29 MB |
| **Compact** | Debian / glibc 精简底座 | Debian 中文 CPU Shell 配方待集成 | 基础 GOP/simpledrm，不按厂商分版 | blocked，未交付 |
| **Standard** | Debian 通用底座 | 完整中文/IME、PollyUI、GLES 特效 | 通用驱动/固件集合（原完整硬件集合） | 882.16 MB |

当前顺序为 **Mini → Compact → Standard**。Mini 沿用原 Micro；Compact 是原
Debian 中文轻量目标（曾称 Thin）；Standard 取代原完整硬件档，不再存在单独的完整硬件档
产品、配置或命令行档位。

标准构建入口：

```sh
bash tools/build.sh --os mini|compact|standard --plan
bash tools/build.sh --os standard OUT --build ...
```

`--plan` 只读；`--build` 必须显式给输出目录。Standard 需要冻结的
`standard-effects4` runtime 和受控 APT `--lock`，详见
[构建指南](BUILDING.md)。

## Standard 尺寸/载荷依据

当前 Standard 媒体实测：

| 项目 | 数值 |
|---|---:|
| ISO | 882.16 MB / 841.29 MiB |
| USB 原始镜像 | 934.28 MB / 891.00 MiB |
| 最终包 | 411 |
| 新增归档 | 129 |
| 原生变体 | `standard-effects4` |
| 默认渲染 | Pixman/raster；GPU 模式走 paired GLES |

原完整硬件档的完整驱动/固件集合已经并入 Standard，包括：

- Intel/NVIDIA/AMD graphics firmware
- Realtek 有线、Intel/Realtek/Atheros/Broadcom/MediaTek Wi-Fi
- Intel SOF、Cirrus、HDA/HDMI/USB 音频和 ALSA UCM/topology
- `standardUtilities` 常用命令组
- P1000/Nouveau 路线、VM 路径和完整 stock kernel/modules

Standard 的包集合仍是完整硬件集合，不因产品改名而缩小；实际硬件兼容性
仍需独立验证。

## 历史原型（非当前产品）

| 名称 | 实测 | 状态 |
|---|---:|---|
| 原 Micro 演示 | 26 MB | 只作历史原型，不是当前 Mini |
| 原 Thin 演示 | 169 MB | 只作历史原型，不是当前 Compact |
| 原 minimal-zh 实验 | 236 MB | 只作历史原型，不是当前 Compact |

这些历史原型没有 Mini/Compact/Standard 的完整产品合同，不能重标为新档位。

## 尺寸边界

- Standard 的 882.16 MB 来自实际构建媒体，不是包大小推算。
- Mini 的 65.29 MB 来自实际构建/启动验证；GOP/virtio 双路径已复验。
- Compact 尚无可交付尺寸；在配方接通前不提供估算。
- 所有 unsigned x86_64 UEFI 开发镜像都不代表 Secure Boot、安装器、恢复或
  通用物理机资格。
