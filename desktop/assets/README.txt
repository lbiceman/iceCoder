冰豆应用图标资源

- （源）src/public/icons/favicon.svg  Web 与桌面共用矢量源
- icon.png        512×512，Linux / electron-builder 通用源（由脚本生成）
- icon.ico        Windows 安装包、任务栏、**系统通知左上角**（由 favicon.svg 生成，圆外透明）
- tray-icon.png   32×32 系统托盘（由脚本生成）

生成 PNG / ICO：

```bash
cd desktop && npm run icons:generate
```

macOS 的 .icns 在 `npm run dist:mac` 时由 electron-builder 从 icon.png 自动转换。

UI 内联图标统一放在 `src/public/icons/`，通过 `AppIcon`（`/icons/*.svg`）加载。
