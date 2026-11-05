---
name: 创建Agent
description: 创建、编辑、生成或调整 iceCoder 自定义 Agent 时使用此技能
createdAt: 2026-11-05T00:00:00.000Z
---

用户要创建、生成、编辑、修改或调整自定义 Agent 时，按以下流程操作。

## 唯一目录

所有 Agent 文件的读写**只能**在 **`ICE_AGENTS_DIR`**（默认 `{数据目录}/agents/`）。

- **数据目录由用户设置**：桌面端在「设置 → iceCoder 数据文件夹」选择路径；会话、技能、Agent 都落在此目录
- 显式设置环境变量 `ICE_DATA_DIR` / `ICE_AGENTS_DIR` 时优先；源码开发未配置时为项目 `data/agents/`
- **禁止**写入 `src/agents/`、项目根目录、`skills/`、`docs/` 或其他路径
- 编辑已有 Agent 时：先 `read_file` 原文件，再改同一个 `{id}.json`，不要另存一份
- 保存后立刻生效，不用重启。聊天里用 `/命令` 进入，`/命令 exit` 或输入栏芯片的 × 退出

默认已有 `plan.json`（命令 `/plan`）。除非用户明确要改 Plan，不要覆盖它。

## 文件

一个 Agent 一个文件，文件名就是命令名：

```
ICE_AGENTS_DIR/
├── plan.json      → /plan（安装时自带，不要随便改）
└── ask.json       → /ask
```

`id` 必须和文件名（去掉 `.json`）一致。

## 必填格式

```json
{
  "id": "ask",
  "name": "只问不改",
  "description": "回答问题，不改仓库",
  "prompt": "只根据仓库内容回答。不要改文件，不要执行命令。",
  "tools": ["read_file", "glob", "grep"],
  "createdAt": "2026-11-05T00:00:00.000Z",
  "updatedAt": "2026-11-05T00:00:00.000Z"
}
```

约束：

- **id**：以小写字母开头，只能含小写字母、数字和连字符，最长 32。不能用内置命令：`also`、`next`、`shell`、`open`、`exit`、`agent`、`agents`
- **name**：必填，最多 40 字。显示名
- **description**：可空，最多 160 字。出现在 `/` 命令列表里
- **prompt**：必填，最多 8000 字。这是角色，决定怎么做事。它压过技能、用户规则和项目说明，压不过安全规则，也不能借此多要工具
- **tools**：封闭名单，最多 80 个。没写进名单的工具这一轮不会提供。名单里不存在的名字会被丢掉。不需要任何工具时用 `[]`
- **createdAt / updatedAt**：ISO 时间。新建时两个都写当前时间；修改时保留 `createdAt`，更新 `updatedAt`

## 先问清再写

1. 这个 Agent 要做什么、不能做什么
2. 命令名（`/id`）和显示名
3. 需要哪些工具。只给完成角色所必需的，不要默认全开

角色提示词里写清做法和边界。不要在提示词里要求名单以外的工具。

## 内置工具名

按角色挑选，名字必须原样写入 `tools`：

- 阅读和搜索：`read_file`、`glob`、`grep`、`file_info`、`list_drives`、`browse_directory`、`open_file`、`diff_files`、`env_info`
- 文档和网页：`fetch_url`、`web_search`、`parse_document`、`parse_pptx_deep`、`parse_xlsx_deep`、`parse_xmind_deep`、`parse_doc_legacy`、`notebook_read`、`image_read`
- 改文件：`write_file`、`edit_file`、`append_file`、`patch_file`、`batch_edit_file`、`undo_edit`、`fs_operation`
- 命令和 Git：`run_command`、`git`
- 子 Agent：`task`、`check_agent`
- 其他：`scheduled_task`
- 仅 Windows 桌面：`windows_mouse`、`windows_keyboard`、`windows_screenshot`、`windows_find`、`windows_ocr`。用户没要求操作桌面就不要加

## 自检

- [ ] 文件在 `ICE_AGENTS_DIR`，路径是 `{id}.json`
- [ ] `id` 合法，且不是内置命令；没有覆盖 `plan.json`，除非用户要求
- [ ] `name`、`prompt` 已填，长度未超限
- [ ] `tools` 里每个名字都在上面的清单中，且是这个角色真正需要的
- [ ] 保存后告诉用户命令（如 `/ask`）和退出方式（`/ask exit` 或芯片 ×）
