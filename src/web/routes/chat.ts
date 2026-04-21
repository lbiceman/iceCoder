/**
 * 聊天和文件上传 API 路由。
 * 文件解析完全交给 AI 通过工具系统自主完成。
 *
 * 重构后：路由层变薄，核心循环委托给 Harness。
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import { promises as fsPromises } from 'node:fs';
import type { Orchestrator } from '../../core/orchestrator.js';
import { Harness } from '../../harness/harness.js';
import type { HarnessConfig } from '../../harness/types.js';
import type { ToolExecutor } from '../../tools/tool-executor.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { setActiveSession } from './sessions.js';

const SYSTEM_PROMPT_PATH = path.resolve('data/system-prompt.md');
const SESSIONS_DIR = path.resolve('data/sessions');

/** 将用户消息和 AI 回复保存到服务端会话文件 */
async function saveToSession(sessionId: string, userMsg: string, agentMsg: string, steps: string[]): Promise<void> {
  try {
    await fsPromises.mkdir(SESSIONS_DIR, { recursive: true });
    const sessionFile = path.join(SESSIONS_DIR, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
    const listFile = path.join(SESSIONS_DIR, '_list.json');

    // 读取已有消息
    let existing: { role: string; content: string }[] = [];
    try {
      const data = await fsPromises.readFile(sessionFile, 'utf-8');
      existing = JSON.parse(data);
    } catch { /* file doesn't exist yet */ }

    // 追加 step 消息、用户消息和 AI 回复
    for (const s of steps) {
      existing.push({ role: 'agent', content: s });
    }
    existing.push({ role: 'user', content: userMsg });
    if (agentMsg) {
      existing.push({ role: 'agent', content: agentMsg });
    }

    await fsPromises.writeFile(sessionFile, JSON.stringify(existing), 'utf-8');

    // 更新会话列表
    let list: { id: string; title: string; updatedAt: number }[] = [];
    try {
      const listData = await fsPromises.readFile(listFile, 'utf-8');
      list = JSON.parse(listData);
    } catch { /* empty */ }

    const title = userMsg.length > 30 ? userMsg.substring(0, 30) + '…' : userMsg;
    const idx = list.findIndex(s => s.id === sessionId);
    const meta = { id: sessionId, title, updatedAt: Date.now() };
    if (idx >= 0) { list[idx] = meta; } else { list.unshift(meta); }
    await fsPromises.writeFile(listFile, JSON.stringify(list), 'utf-8');
  } catch (err) {
    console.error('[sessions] Failed to save:', err);
  }
}

/** 读取系统提示词文件，失败时回退到最小提示词 */
async function loadSystemPrompt(): Promise<string> {
  try {
    return await fsPromises.readFile(SYSTEM_PROMPT_PATH, 'utf-8');
  } catch {
    return '你是一个智能助手，拥有工具能力。根据用户需求自主决定使用哪些工具。回答使用中文。';
  }
}

// multer 存储：保留原始扩展名，方便工具按扩展名识别
const storage = multer.diskStorage({
  destination: 'data/uploads/',
  filename: (_req, file, cb) => {
    const ext = path.extname(fixFilename(file.originalname));
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({ storage });

/**
 * 修复 multer 中文文件名乱码问题
 */
function fixFilename(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

export interface ChatRouterOptions {
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
}

export function createChatRouter(options: ChatRouterOptions): Router {
  const { orchestrator, toolRegistry, toolExecutor } = options;
  const router = Router();

  const uploadedFiles: Map<string, { path: string; filename: string }> = new Map();
  const pendingChats: Map<string, { message: string; sessionId?: string }> = new Map();
  const activeStreams: Map<string, AbortController> = new Map();
  /** 待用户确认的工具调用：chatId → { resolve } */
  const pendingConfirms: Map<string, { resolve: (approved: boolean) => void }> = new Map();

  /**
   * POST /api/chat/upload - 接收文件上传，不限格式
   */
  router.post('/upload', upload.single('file'), (req: Request, res: Response): void => {
    try {
      const file = req.file;
      if (!file) { res.status(400).json({ error: '未上传文件' }); return; }

      const originalName = fixFilename(file.originalname);
      const fileId = file.filename;
      uploadedFiles.set(fileId, { path: file.path, filename: originalName });

      res.json({ success: true, fileId, filename: originalName, size: file.size });
    } catch (err) {
      res.status(500).json({ error: `文件上传失败: ${err instanceof Error ? err.message : '未知错误'}` });
    }
  });

  /**
   * POST /api/chat/message - 接收消息
   */
  router.post('/message', async (req: Request, res: Response): Promise<void> => {
    try {
      const { message, fileId, command, sessionId } = req.body as { message?: string; fileId?: string; command?: string; sessionId?: string };

      if (!message && !fileId && !command) {
        res.status(400).json({ error: '需要提供消息、文件ID或命令' });
        return;
      }

      let filePath: string | undefined;
      let filename: string | undefined;

      if (fileId) {
        const fileInfo = uploadedFiles.get(fileId);
        if (!fileInfo) { res.status(400).json({ error: '文件未找到' }); return; }
        filePath = fileInfo.path;
        filename = fileInfo.filename;
        uploadedFiles.delete(fileId);
      }

      // /pipeline 命令 → 启动完整流水线
      if (command === 'pipeline' && filePath && filename) {
        const buffer = await fsPromises.readFile(filePath);
        const executionId = orchestrator.startPipeline(buffer, filename, {});
        res.json({ success: true, executionId, message: 'Pipeline 执行已启动', filename });
        return;
      }

      // 组装用户消息
      let userMessage = message || '';
      if (filePath && filename) {
        const fileNote = `用户上传了文件「${filename}」，文件保存在路径: ${filePath}\n请使用合适的工具解析该文件内容，然后回答用户的问题。`;
        userMessage = userMessage
          ? `${fileNote}\n\n用户问题：${userMessage}`
          : `${fileNote}\n\n请解析该文件并总结其内容。`;
      }

      const chatId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingChats.set(chatId, { message: userMessage, sessionId: sessionId || undefined });

      // 记录 PC 端当前活跃会话
      if (sessionId) {
        setActiveSession(sessionId).catch(() => {});
      }

      res.json({ success: true, chatId, message: '消息已接收', filename });
    } catch (err) {
      res.status(500).json({ error: `消息处理失败: ${err instanceof Error ? err.message : '未知错误'}` });
    }
  });

  /**
   * GET /api/chat/supported-formats
   */
  router.get('/supported-formats', (_req: Request, res: Response): void => {
    const extensions = orchestrator.getFileParser().getSupportedExtensions();
    res.json({ extensions: extensions.map(ext => `.${ext}`) });
  });

  /**
   * GET /api/chat/stream-chat/:chatId - SSE 流式聊天
   * 核心循环委托给 Harness
   */
  router.get('/stream-chat/:chatId', async (req: Request, res: Response): Promise<void> => {
    const chatId = req.params.chatId as string;
    const pending = pendingChats.get(chatId);
    if (!pending) { res.status(404).json({ error: '聊天会话未找到' }); return; }
    pendingChats.delete(chatId);

    const abortController = new AbortController();
    activeStreams.set(chatId, abortController);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.on('close', () => { abortController.abort(); activeStreams.delete(chatId); });

    try {
      const llmAdapter = orchestrator.getLLMAdapter();
      const toolDefs = toolRegistry.getDefinitions();
      const systemPrompt = await loadSystemPrompt();

      // ── 构建 Harness 配置 ──
      const harnessConfig: HarnessConfig = {
        context: {
          systemPrompt,
          tools: toolDefs,
        },
        loop: {
          maxRounds: 800,
          signal: abortController.signal,
          timeout: 60 * 60 * 1000, // 1 小时超时
        },
        permissions: [
          { pattern: 'delete_file', permission: 'confirm', reason: '删除文件需要用户确认' },
        ],
        compactionThreshold: 40,
        compactionKeepRecent: 10,
        onConfirm: (toolName, args) => {
          return new Promise<boolean>((resolve) => {
            // 通知前端弹框
            try {
              res.write(`data: ${JSON.stringify({
                confirm: { toolName, args, chatId },
              })}\n\n`);
            } catch { /* closed */ }

            // 等待用户通过 POST /api/chat/confirm/:chatId 回传结果
            pendingConfirms.set(chatId, { resolve });

            // 60 秒超时自动拒绝
            setTimeout(() => {
              if (pendingConfirms.has(chatId)) {
                pendingConfirms.delete(chatId);
                resolve(false);
              }
            }, 60000);
          });
        },
      };

      // ── 创建 Harness 并运行核心循环 ──
      const harness = new Harness(harnessConfig, toolExecutor);

      // 收集 step 消息用于保存
      const stepMessages: string[] = [];

      const result = await harness.run(
        pending.message,
        (msgs, opts) => llmAdapter.chat(msgs, opts),
        (event) => {
          if (abortController.signal.aborted) return;
          try {
            res.write(`data: ${JSON.stringify({ step: event })}\n\n`);
          } catch { /* closed */ }

          // 收集 step 消息
          if (event.type === 'thinking' && event.content) {
            stepMessages.push('[think] ' + event.content.substring(0, 200));
          } else if (event.type === 'tool_call' && event.toolName) {
            stepMessages.push('[call] ' + event.toolName);
          } else if (event.type === 'tool_result' && event.toolName) {
            const icon = event.toolSuccess ? '[ok]' : '[err]';
            const preview = (event.toolOutput || event.toolError || '').substring(0, 150);
            stepMessages.push(icon + ' ' + event.toolName + ' → ' + preview);
          }
        },
      );

      if (!abortController.signal.aborted) {
        if (result.content) {
          res.write(`data: ${JSON.stringify({ content: result.content })}\n\n`);
        }
        if (result.loopState.totalToolCalls > 0) {
          res.write(`data: ${JSON.stringify({ toolCalls: result.loopState.totalToolCalls })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({
          done: true,
          tokenUsage: {
            inputTokens: result.loopState.totalInputTokens,
            outputTokens: result.loopState.totalOutputTokens,
          },
        })}\n\n`);

        // 保存到服务端会话
        if (pending.sessionId) {
          saveToSession(pending.sessionId, pending.message, result.content, stepMessages)
            .catch(err => console.error('[sessions] save error:', err));
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        try { res.write(`data: ${JSON.stringify({ stopped: true })}\n\n`); } catch { /* closed */ }
      } else {
        const errMsg = err instanceof Error ? err.message : 'LLM 调用失败';
        try { res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`); } catch { /* closed */ }
      }
    }

    activeStreams.delete(chatId);
    try { res.end(); } catch { /* closed */ }
  });

  /**
   * POST /api/chat/confirm/:chatId - 用户确认/拒绝工具调用
   */
  router.post('/confirm/:chatId', (req: Request, res: Response): void => {
    const cid = req.params.chatId as string;
    const { approved } = req.body as { approved: boolean };
    const pending = pendingConfirms.get(cid);
    if (pending) {
      pendingConfirms.delete(cid);
      pending.resolve(!!approved);
      res.json({ success: true });
    } else {
      res.json({ success: false, message: '无待确认的操作' });
    }
  });

  /**
   * POST /api/chat/stop/:chatId - 停止流式聊天
   */
  router.post('/stop/:chatId', (_req: Request, res: Response): void => {
    const chatId = _req.params.chatId as string;
    const controller = activeStreams.get(chatId);
    if (controller) {
      controller.abort();
      activeStreams.delete(chatId);
      res.json({ success: true, message: '已停止' });
    } else {
      res.json({ success: true, message: '会话不存在或已结束' });
    }
  });

  return router;
}
