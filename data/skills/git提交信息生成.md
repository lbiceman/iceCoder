---
name: git提交信息生成
description: 根据 git diff 生成符合 Conventional Commits 规范的中文提交信息，并可一键写入
createdAt: 2026-06-17T00:00:00.000Z
---

根据当前 git 改动生成规范的提交信息。

## 流程
1. **收集改动**：`git status --short` 与 `git diff --staged`（含未暂存时用 `git diff`），不要看未跟踪的二进制
2. **判断范围**：
   - 仅文档/注释 → `docs:`
   - 仅样式/空格 → `style:`
   - 仅测试 → `test:`
   - 修复 bug → `fix:`
   - 新功能 → `feat:`
   - 重构（无行为变化）→ `refactor:`
   - 构建/CI/依赖 → `build:` / `ci:` / `chore(deps):`
3. **生成标题**：`<type>(<scope>?): <中文一句话摘要>`，≤50 字，动词开头，无句号
4. **生成正文**（多文件/复杂改动才需要）：
   - 空行后 `**改动**:` 列出要点
   - `**影响**:` 描述对调用方/接口的影响
   - `**测试**`: 说明如何验证
5. **结尾标记**：含破坏性变更追加 `BREAKING CHANGE: <说明>`
6. **询问用户**：先输出候选 1～3 条，让用户选一条或微调，再决定是否执行 `git commit -m`

## 禁止
- 不自动 `git commit`，必须用户确认
- 不在标题里用 emoji（除非用户明确要求）
- 不把 secrets/凭据写进提交信息
- 不引用未跟踪的大文件或临时调试脚本（避免随提交入仓）

## 示例
```
feat(用户登录): 新增手机号验证码登录

**改动**:
- 新增 SmsCodeService 与 /api/auth/sms 接口
- 登录页增加「手机号登录」Tab

**影响**: 不影响原有账号密码流程，老用户无感知

**测试**: pytest tests/test_sms_login.py
```
