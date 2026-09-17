品牌标只维护一份源图，其余在打包 / 开发时生成。

源图（入库）：

- src/public/icons/logo.png   侧栏 / 移动端顶栏

生成（不入库，npm run icons 或 npm run build 自动跑）：

- desktop/assets/icon.png     Electron 窗口 / macOS / Linux
- desktop/assets/icon.ico     Windows 任务栏、托盘、通知、安装包
- src/public/favicon.ico      浏览器 tab
- src/public/icons/favicon.svg

换新标：覆盖 logo.png 后执行 `npm run icons`，或直接 `npm run build` / `npm run build:desktop`。
