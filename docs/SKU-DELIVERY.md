# 尺寸 SKU 交付记录（2026-10-20）

本文件汇总本轮尺寸 SKU 阶梯的实测产物。所有 ISO 都是 unsigned x86_64 UEFI
开发镜像，不是物理机/安全启动资格。

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
