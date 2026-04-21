---
inclusion: auto
---

# 工具使用规则与项目约定

## 文件解析规则

当遇到以下文件类型时，应自动使用对应的解析工具：

| 文件类型 | 工具名称 | 说明 |
|---------|---------|------|
| .doc / .docx | `parse_doc` 或 `parse_document` | Word 文档解析 |
| .ppt / .pptx | `parse_ppt` 或 `parse_document` | PowerPoint 演示文稿解析 |
| .xmind | `parse_xmind` 或 `parse_document` | XMind 思维导图解析 |
| .html / .htm | `parse_html` 或 `parse_document` | HTML 页面解析 |
| .txt / .md / .csv / .json / .xml / .yaml | `parse_document` | 纯文本类文件直接读取 |

## URL 访问规则

- 使用 `fetch_url` 工具访问网页 URL
- HTML 页面默认提取纯文本内容
- JSON API 响应自动格式化
- 默认超时 30 秒，最大响应 10MB
- 自动跟随重定向

## 文件操作规则

- `read_file`: 读取文件内容
- `write_file`: 写入文件（自动创建父目录）
- `append_file`: 追加内容到文件末尾
- `edit_file`: 查找替换（支持正则）
- `delete_file`: 删除文件
- `list_directory`: 列出目录内容
- `file_info`: 获取文件元信息

所有文件操作限制在工作目录内，防止路径遍历。

## 搜索规则

- `search_in_files`: 在文件内容中搜索（类似 grep）
- `find_files`: 按文件名模式搜索

## Shell 命令规则

- `run_command`: 执行 shell 命令
- 有危险命令黑名单保护
- 默认超时 30 秒

## 兜底与重试策略

### LLM 调用重试
- 网络错误（ECONNREFUSED, ETIMEDOUT, ECONNRESET 等）自动重试
- HTTP 429/500/502/503/504 自动重试
- 指数退避 + 随机抖动，最大延迟 30 秒
- 默认最多重试 3 次

### 工具调用重试
- 单个工具调用失败自动重试 3 次
- 工具调用超时 60 秒
- 工具调用循环最多 30 次迭代（防止无限循环）

### Pipeline 阶段重试
- 每个阶段失败后自动重试最多 2 次
- 重试间隔指数递增（3s, 6s）

### Agent 级别重试
- `callLLMWithRetry()` 提供额外的应用层重试
- 在 LLM 适配器重试之上再加 2 次重试

## 长时间运行支持

- HeartbeatMonitor: 心跳监控，检测系统是否卡死
- CircuitBreaker: 熔断器，连续失败 5 次后暂停请求 60 秒
- withFallback: 优雅降级，主操作失败时执行兜底逻辑
- withTimeout: 超时保护，防止单个操作无限阻塞

## 项目代码风格

- TypeScript 严格模式
- 使用 ESM 模块 (`import/export`)
- 文件后缀使用 `.js` 在 import 路径中
- 中文注释和日志
- 策略模式用于可扩展组件（解析器、LLM 提供者）
- 所有 Agent 继承 BaseAgent，实现 doExecute()
