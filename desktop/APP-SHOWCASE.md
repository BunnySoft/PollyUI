# PollyOS App & Capability Showcase

这是一份**精简的“系统自带 App + 能力”展示清单**，目标是让第一次接触 PollyOS 的人
在几分钟内看懂它是什么、能做什么；不是要复刻 Windows 11/macOS 的全部内置应用。

配套图标是独立的一套原创素材，位于
[`resources/application-icons/showcase/`](resources/application-icons/showcase/)，
尚未替换现有运行时图标，方便先评审再接入。

## App 集合（10 个）

| # | App | 对标的系统应用 | 当前状态 | 展示的能力 |
|---|---|---|---|---|
| 1 | **Files 文件** | File Explorer / Finder | 已有（核心） | 目录浏览、属性、新建/重命名、MIME 打开、单文件剪切粘贴 |
| 2 | **Settings 设置** | Settings / System Settings | 已有（六页） | 外观、显示、网络、音频、键盘、关于 |
| 3 | **Terminal 终端** | Terminal | 已有（foot） | 命令行、开发与诊断入口 |
| 4 | **Text Editor 文本编辑** | Notepad / TextEdit | 已有（基础） | 打开、编辑、保存、覆盖/变化确认 |
| 5 | **Photos 照片** | Photos | 建议新增 | 图片浏览、缩放、幻灯片 |
| 6 | **Music 音乐** | Music / Media Player | 建议新增 | PipeWire 播放、播放列表、封面 |
| 7 | **Calculator 计算器** | Calculator | 建议新增 | 标准/科学计算、键盘输入 |
| 8 | **Calendar 日历** | Calendar | 建议新增 | 月视图、事件、今天 |
| 9 | **System Monitor 系统监视器** | Task Manager / Activity Monitor | 已有（Processes 基础） | 进程列表、资源占用 |
| 10 | **Browser 浏览器** | Edge / Safari | 外部验证（Chromium 155 已实测） | 原生 Wayland 网页浏览，不作为内置包 |

> “建议新增”是展示目标，不代表已经实现。现有实现只有 Files、Settings、
> Terminal（foot）、Text Editor 和 Processes；浏览器是外部 Chromium 实测结果。

## 系统能力（8 项）

| 能力 | 状态 | 展示方式 |
|---|---|---|
| Start / 全局搜索 | 已有 | 任务栏 Start、应用搜索、键盘导航 |
| Taskbar / 居中任务 | 已有 | 运行标记、分组、托盘、时钟 |
| 通知中心 / Quick Settings | 已有（部分） | 通知卡片、Wi-Fi/音量/亮度等快捷项 |
| 工作区 / 窗口贴边 | 部分 | 多工作区已有；Snap 布局/Overview 未完成 |
| 主题中心 | 已有 | 六套主题、Modern 25H2 风格、Keep/Revert |
| 原生文件对话框 | 已有 | 打开/保存、真实文件、覆盖确认 |
| 输入法 / 剪贴板 | 已有 | Rime 中文、候选框、复制粘贴 |
| 截图工具 | 建议新增 | 区域/窗口截图、保存到 Pictures |

## 图标设计规范

- **风格**：macOS-inspired。超椭圆（squircle）底板、分层渐变、内缘微高光、柔和环境阴影、
  克制的镜面光；有体积和材质感，但不像 XP 那样堆高光、纹理和粗描边。
- **结构**：1024×1024 母版，导出 256/128/64；透明背景，主体四周留白一致。
- **光照**：22–38px 高斯环境阴影、顶部大范围柔光、底部轻微环境遮蔽、1px 内缘；
  不做玻璃斜面、金属拉丝或纸张纹理。
- **配色**：Files 蓝底金文件夹、Settings 银灰蓝、Terminal 石墨黑、
  Text Editor 宝蓝、Photos 橙红、Music 玫红、Calculator 深灰、
  Calendar 正红、System Monitor 青绿、Browser 亮蓝。
- **边界**：不包含 Microsoft/Apple 的商标、系统图标、Segoe UI/SF 字体或下载素材；
  全部为原创 Pillow 绘制。
- **功能图标**：Wi-Fi、Bluetooth、Volume、Brightness、Battery、Airplane、
  Night light、Accessibility 使用同色系超椭圆徽章 + 白色实心符号。


## 文件与再生成

```
desktop/resources/application-icons/showcase/
  files-1024.png / files-256.png / files-128.png / files-64.png
  settings-*.png  terminal-*.png  text-editor-*.png  photos-*.png
  music-*.png  calculator-*.png  calendar-*.png  monitor-*.png  browser-*.png
  wifi-*.png  bluetooth-*.png  volume-*.png  brightness-*.png
  battery-*.png  airplane-*.png  night-*.png  accessibility-*.png
  showcase-sheet.png     # 一览图
  manifest.json          # 名称/状态/尺寸
```

重新生成（Pillow，无网络）：

```sh
python3 desktop/tools/generate-showcase-icons.py
```

## 建议落地顺序

1. **Calculator、Calendar**：纯 JS、无系统服务依赖，最适合作为“内置 App”样板。
2. **Photos、Music**：复用现有文件对话框、Canvas/Bitmap 和 PipeWire 音频。
3. **Screenshot**：接入合成器截屏/保存路径，作为系统能力入口。
4. **Browser**：先把 Chromium 作为可选外部应用，再决定是否内置/打包。
5. 最后统一替换现有 Files/Settings/Text Editor/Processes 图标并做任务栏/开始菜单验收。

本页只定义展示范围和素材，不宣称这些 App 已全部实现；实现状态以
[`docs/POLLYOS-PLAN.json`](../docs/POLLYOS-PLAN.json) 和
[`desktop/README.md`](README.md) 为准。
