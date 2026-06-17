---
name: 打开claudeCode
description: 使用这个 skill 打开 Anthropic 的 Claude Code CLI（`claude` 命令），在新终端中启动交互式编码会话
createdAt: 2026-06-16T00:00:00.000Z
---

当用户要求"打开 Claude Code"、"启动 claude"、"在终端里跑 claude"等时：

1. **检查安装**：在终端里先 `where claude`（Windows）/ `which claude`（macOS/Linux）确认命令存在；若不存在，提示用户先运行 `npm install -g @anthropic-ai/claude-code` 或访问 https://claude.com/claude-code 获取安装方式。
2. **选择工作目录**：默认用当前项目根目录；如用户指定了路径，先 `cd` 过去再启动。
3. **启动方式**：
   - 交互式会话：直接执行 `claude` 打开 REPL。
   - 带初始提示：执行 `claude "<用户的初始请求>"`。
   - 管道模式：执行 `echo "<指令>" | claude -p` 做一次性任务。
   - 续接会话：加 `--continue`（最近一次）或 `--resume <sessionId>`（指定会话）。
4. **新终端窗口**：用 `start "" cmd /k claude`（Windows）或 `osascript -e 'tell app "Terminal" to do script "claude"'`（macOS）保持当前 shell 不被占用。
5. **常用参数速查**（按需提示用户）：
   - `--model <sonnet|opus|haiku>`：切换模型
   - `--permission-mode <acceptEdits|plan|bypassPermissions>`：权限粒度
   - `--add-dir <path>`：允许访问额外目录
   - `--debug`：调试模式
   - `--help`：查看全部选项
6. **首次使用**：提醒用户首次运行需要 `claude login` 完成 OAuth 认证。

避免：在用户没确认前擅自 `npm install -g`；在已有 Claude Code 进程的目录里重复启动；将 `claude` 与 VS Code 的 `code` 命令混淆。
