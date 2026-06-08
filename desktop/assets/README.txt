冰豆应用图标资源

- （源）src/public/favicon.svg  Web 与桌面共用矢量源
- icon.svg        与 favicon.svg 同步的本地副本（仅供参考）
- icon.png        512×512，Linux / electron-builder 通用源
- icon.ico        Windows 安装包与任务栏
- tray-icon.png   32×32 系统托盘

生成 PNG / ICO：

```bash
cd desktop && npm run icons:generate
```

macOS 的 .icns 在 `npm run dist:mac` 时由 electron-builder 从 icon.png 自动转换。
