# iceCoder Agent OS V3

> Architecture Specification
>
> Version: 3.0
>
> Status: Draft

---

# 00. 前言

- 为什么要做 Agent OS
- 设计理念
- 术语说明
- 阅读指南

---

# 01. 愿景（Vision）

## 1.1 为什么不是 Coding Agent

## 1.2 为什么不是 Multi-Agent Framework

## 1.3 什么是 Agent OS

## 1.4 最终目标

---

# 02. 设计原则（Design Principles）

## 2.1 Runtime First

## 2.2 Supervisor First

## 2.3 Shared Workspace

## 2.4 Stateless Agent

## 2.5 Event Driven

## 2.6 Progressive Execution

## 2.7 Recovery First

## 2.8 Long Running

---

# 03. 核心思想（三个铁律）

## 3.1 Supervisor 是唯一控制中心

## 3.2 Agent 永远无状态

## 3.3 Workspace 是唯一事实来源

---

# 04. 总体架构（Architecture）

## 4.1 Runtime 总览

## 4.2 架构图

## 4.3 数据流

## 4.4 生命周期

---

# 05. Runtime

## 5.1 Runtime 定义

## 5.2 Runtime 生命周期

## 5.3 Runtime 状态

## 5.4 Runtime Context

---

# 06. Session

## 6.1 Session

## 6.2 Session 生命周期

## 6.3 Session 状态

## 6.4 Session 恢复

---

# 07. Supervisor（核心）

## 7.1 Supervisor 定位

## 7.2 Runtime Controller

## 7.3 Risk Analysis

## 7.4 Decision Engine

## 7.5 Escalation

## 7.6 Recovery

## 7.7 Verification

## 7.8 Adaptive Runtime

---

# 08. Execution Mode

## 8.1 Free

## 8.2 Adaptive

## 8.3 Strict

## 8.4 Mode Switch

## 8.5 Dynamic Escalation

---

# 09. Shared Workspace

## 9.1 Workspace

## 9.2 Task

## 9.3 Context

## 9.4 Todo

## 9.5 Runtime

## 9.6 Artifact

## 9.7 Knowledge

---

# 10. Planner

## 10.1 Planning

## 10.2 TaskGraph

## 10.3 Task Split

## 10.4 Dependency

---

# 11. Scheduler

## 11.1 Scheduler

## 11.2 Queue

## 11.3 Parallel

## 11.4 Retry

## 11.5 Priority

---

# 12. Agent

## 12.1 Agent

## 12.2 Registry

## 12.3 Agent Lifecycle

## 12.4 Capability

## 12.5 Permission

---

# 13. Skill

## 13.1 Skill

## 13.2 Skill Package

## 13.3 Skill Install

## 13.4 Skill Version

---

# 14. Memory

## 14.1 Global

## 14.2 Project

## 14.3 Session

## 14.4 Agent

---

# 15. Tool Runtime

## 15.1 Tool

## 15.2 Permission

## 15.3 Execution

## 15.4 Retry

---

# 16. Recovery

## 16.1 Failure

## 16.2 Rollback

## 16.3 Checkpoint

## 16.4 Resume

---

# 17. Verification

## 17.1 Verification

## 17.2 Review

## 17.3 Test

## 17.4 Confidence

---

# 18. Container（Assistant）

## 18.1 Long Running Session

## 18.2 Timer

## 18.3 Watcher

## 18.4 Trigger

## 18.5 Auto Execution

---

# 19. Event Bus

## 19.1 Event

## 19.2 Event Flow

## 19.3 Subscriber

## 19.4 Replay

---

# 20. UI

## 20.1 Workspace

## 20.2 Timeline

## 20.3 Artifact

## 20.4 Runtime

## 20.5 Replay

---

# 21. API

## 21.1 Runtime API

## 21.2 Session API

## 21.3 Agent API

## 21.4 Workspace API

---

# 22. Plugin

## 22.1 Plugin

## 22.2 Extension

## 22.3 Marketplace

---

# 23. 开发路线（Roadmap）

## Phase 1 Runtime

## Phase 2 Adaptive

## Phase 3 Agent

## Phase 4 Assistant

## Phase 5 Plugin

---

# 24. 对比分析

## Claude Code

## Codex CLI

## OpenCode

## Cursor

## CrewAI

## LangGraph

---

# 25. 为什么不会失控

## 为什么不用 Agent 自治

## 为什么不用 Agent 对话

## 为什么 Supervisor 唯一

## 为什么 Workspace 唯一

---

# 26. 性能优化

## Token

## Context

## Cache

## Parallel

---

# 27. 安全设计

## Permission

## Sandbox

## Confirmation

## Windows Safety

---

# 28. 未来规划

## Cloud Runtime

## Distributed Agent

## Remote Container

## Team Collaboration

---

# 29. 总结

# 30. 非目标（Non-Goals）

## 明确说明当前不打算支持什么，例如：
## 
## Agent 自治协商
## Agent 自我复制
## Agent 自行创建流程
## 去中心化调度
## 
## 这样可以防止后续架构不断膨胀。

# 31. 设计决策（Architecture Decision Records，ADR）

## 记录关键设计为什么这么做，例如：
## 
## 为什么保留 Free / Adaptive / Strict？
## 为什么 Supervisor 是唯一控制中心？
## 为什么 Agent 必须无状态？
## 为什么采用 Shared Workspace 而不是 Agent 对话？