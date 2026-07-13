# RFC：异步子代理（Async Sub-Agent）设计方案

> Version: 1.0
>
> Status: Draft
>
> 目标：让 Sub-Agent 真正参与 Runtime，而不是作为一个很少被调用的 Tool。

---

# 一、背景

目前 Sub-Agent 工作流程：

```
Main Agent

↓

调用 Sub-Agent

↓

等待...

↓

Sub-Agent 返回

↓

继续执行
```

存在的问题：

- 主 Agent 被阻塞
- Sub-Agent 使用率低
- LLM 倾向于自己读取文件
- 无法利用等待时间

因此：

需要改为 **异步执行模型（Async Sub-Agent）**。

---

# 二、设计目标

实现：

- Main Agent 永不空闲
- Sub-Agent 后台运行
- Supervisor 管理 Sub-Agent 生命周期
- Workspace 共享结果
- Main Agent 在需要时再消费结果

---

# 三、整体架构

```
                     Main Agent
                          │
                请求后台分析任务
                          │
                    Supervisor
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
 Explorer Agent     Search Agent     Review Agent
        │                 │                 │
        └─────────────────┼─────────────────┘
                          │
                   Shared Workspace
                          │
                     Main Agent
```

Main Agent：

负责：

- 思考
- 决策
- 合并结果

Sub-Agent：

负责：

- 搜索
- 阅读
- 总结
- 分析

---

# 四、生命周期

## 1. Main Agent

```
开始

↓

思考

↓

发现需要额外信息

↓

提交后台任务

↓

继续工作

↓

等待需要结果

↓

融合结果

↓

继续执行
```

---

## 2. Sub-Agent

```
启动

↓

读取 Workspace

↓

执行分析

↓

生成 Summary

↓

写入 Workspace

↓

退出
```

Sub-Agent：

永远无状态。

---

# 五、执行流程

例如：

用户：

```
帮我修改 OAuth 登录。
```

执行：

```
Main Agent

↓

开始规划

↓

发现需要了解认证模块

↓

Supervisor

↓

启动 Explorer Agent

↓

Main Agent 继续规划修改方案

↓

Explorer 返回：

Auth 位于：

src/auth/

middleware/

config/

↓

Main Agent 合并信息

↓

开始修改代码
```

整个过程中：

Main Agent：

没有等待。

---

# 六、Workspace

新增：

```
workspace/

subtasks/

artifacts/

analysis/
```

例如：

```
analysis/

auth-summary.md

api-summary.md

database-summary.md
```

Sub-Agent：

全部写这里。

---

# 七、Supervisor

Supervisor：

负责：

```
创建任务

↓

启动 Sub-Agent

↓

监控

↓

收集结果

↓

通知 Main Agent
```

Main Agent：

不直接创建 Sub-Agent。

---

# 八、Sub-Agent 类型

## Explorer

职责：

理解项目。

输出：

```
模块

目录

入口

依赖

调用关系
```

---

## Search

职责：

搜索。

输出：

```
文件

函数

引用

关键词
```

---

## Review

职责：

分析代码。

输出：

```
风险

建议

可能影响
```

---

## Dependency

职责：

分析依赖。

输出：

```
Import

调用链

循环依赖
```

---

## Test Analysis

职责：

分析测试。

输出：

```
测试覆盖

失败原因

测试入口
```

---

# 九、异步原则

Main Agent：

永远不要等待。

例如：

错误：

```
Main

↓

调用 Search

↓

等待

↓

继续
```

正确：

```
Main

↓

启动 Search

↓

继续规划

↓

Search 返回

↓

融合结果
```

---

# 十、结果同步

Sub-Agent：

完成后：

写入：

```
Workspace
```

然后：

Supervisor：

发送：

```
AnalysisReady
```

事件。

Main Agent：

收到后：

决定：

```
立即读取

或

稍后读取
```

---

# 十一、什么时候等待？

只有：

Main Agent 即将做出关键决策时。

例如：

```
准备修改 Auth

↓

Explorer 还没完成

↓

等待

↓

读取分析

↓

继续
```

除此之外：

永远继续执行。

---

# 十二、事件流

```
Main

↓

RequestAnalysis

↓

Supervisor

↓

Start Explorer

↓

ExplorerFinished

↓

WorkspaceUpdated

↓

AnalysisReady

↓

Main Merge

↓

Continue
```

---

# 十三、权限

Sub-Agent：

默认：

ReadOnly。

权限：

```
Read

Search

Grep

Tree

Summary
```

禁止：

```
Edit

Delete

Git

Terminal

Commit
```

只有：

Main Agent：

拥有修改权限。

---

# 十四、优势

## 不阻塞

Main Agent：

继续工作。

---

## 利用等待时间

后台：

一直分析。

---

## 更低 Token

Explorer：

只分析局部。

Main：

无需读取整个仓库。

---

## 更高利用率

Supervisor：

自动触发。

而不是：

依赖 LLM 自己决定。

---

## 更稳定

Sub-Agent：

没有副作用。

全部：

ReadOnly。

---

# 十五、未来扩展

以后：

允许：

```
Explorer

Search

Dependency

Review

Test
```

并行运行。

例如：

```
Supervisor

↓

Explorer

Search

Review

Dependency

↓

Workspace

↓

Main Merge
```

整个 Runtime：

形成：

"一个主 Agent + 多个后台分析 Agent"。

---

# 十六、设计原则

## 1.

Main Agent：

负责：

决策。

---

## 2.

Sub-Agent：

负责：

分析。

---

## 3.

Supervisor：

负责：

调度。

---

## 4.

Workspace：

负责：

共享数据。

---

## 5.

Sub-Agent：

永远：

ReadOnly。

---

# 十七、核心思想

整个 Runtime 采用：

**Main Agent + Async ReadOnly Sub-Agent**

架构。

Main Agent：

负责：

- 推理
- 决策
- 合并
- 最终执行

Sub-Agent：

负责：

- 搜索
- 阅读
- 分析
- 总结

Supervisor：

统一管理：

- 创建
- 调度
- 生命周期
- 回收

Workspace：

作为唯一共享数据源。

最终目标：

让 Main Agent 永远保持思考，让 Sub-Agent 在后台持续提供高质量的信息支持，而不是让整个执行流程因为等待分析而停顿。








插一句话，prompt队列