---
inclusion: auto
---

# 弹性模式与兜底策略指南

## 使用 withRetry 进行通用重试

```typescript
import { withRetry } from '../core/resilience.js';

const result = await withRetry(
  () => someAsyncOperation(),
  {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    jitter: true,
    isRetryable: (error) => {
      // 自定义重试条件
      return error instanceof Error && error.message.includes('timeout');
    },
    onRetry: (attempt, error, delay) => {
      console.warn(`重试 ${attempt}: ${delay}ms 后`);
    },
  },
);
```

## 使用 withTimeout 防止阻塞

```typescript
import { withTimeout } from '../core/resilience.js';

const result = await withTimeout(
  () => longRunningOperation(),
  60000, // 60 秒超时
  '文档解析',
);
```

## 使用 CircuitBreaker 防止雪崩

```typescript
import { CircuitBreaker } from '../core/resilience.js';

const breaker = new CircuitBreaker(5, 60000); // 5 次失败后断开，60 秒后恢复

const result = await breaker.execute(() => callExternalService());
```

## 使用 withFallback 优雅降级

```typescript
import { withFallback } from '../core/resilience.js';

const result = await withFallback(
  () => primaryLLMCall(),
  (error) => '抱歉，AI 服务暂时不可用，请稍后重试。',
);
```

## Agent 中使用工具调用

```typescript
// 在 Agent 的 doExecute 中使用工具
protected async doExecute(context: AgentContext): Promise<AgentResult> {
  // 方式 1: 带工具的 LLM 调用（自动工具循环）
  const result = await this.callLLMWithTools(prompt, context, systemPrompt);

  // 方式 2: 带重试的 LLM 调用
  const result = await this.callLLMWithRetry(prompt, context, 2);

  // 方式 3: 普通 LLM 调用
  const result = await this.callLLM(prompt, context);
}
```

## 错误分类

| 错误类型 | 处理策略 | 示例 |
|---------|---------|------|
| 网络错误 | 自动重试 | ECONNREFUSED, ETIMEDOUT |
| 限流错误 | 退避重试 | HTTP 429 |
| 服务器错误 | 自动重试 | HTTP 500/502/503/504 |
| 客户端错误 | 不重试，直接失败 | HTTP 400/401/403 |
| 超时错误 | 重试或降级 | 操作超时 |
| 业务错误 | 不重试，返回错误信息 | 文件格式不支持 |
