应用图标资源

- （源）src/public/icons/logo.png  首页 / 侧栏品牌标，桌面图标从这张图缩放生成
- icon.png        512×512，Linux / electron-builder 通用源
- icon.ico        Windows 安装包、任务栏、系统通知左上角
- tray-icon.png   32×32 系统托盘
- notification-app-logo.png  44×44 通知备用标

生成 PNG / ICO：

```bash
cd desktop && npm run icons:generate
```

macOS 的 .icns 在 `npm run dist:mac` 时由 electron-builder 从 icon.png 自动转换。

UI 内联图标统一放在 `src/public/icons/`，通过 `AppIcon`（`/icons/*.svg`）加载。
