Design the next-generation task orchestration layer for iceCoder.

This document defines StepGraph Planner.

It is a planning/runtime coordination layer above Harness.

Do not implement code yet.
Only generate markdown design document.

Must inspect actual repository before writing.

Must inspect:

- src/harness/*
- src/types/*
- src/memory/*
- src/web/*
- src/public/*
- test/*
- docs/*

Must understand existing:

- Harness runtime
- TaskState
- RepoContext
- ExecutionPlan
- CheckpointEngine
- Session snapshot
- Sub-agent system
- Web execution panel
- Ice Bean pet system
- chat websocket bridge

Use actual repository structure.
Do not hallucinate files.
Do not rename existing modules.

---

# Document title

# Task Graph Planner Design

---

# Required Sections

---

## 1. Goal

Explain why StepGraph Planner is required.

Current limitation:

Harness is execution-driven but still model-led.

Planner converts task into deterministic execution graph.

Expected improvement:

- long task success rate
- reduced repeated loops
- stronger recovery
- better sub-agent dispatch
- clearer execution visibility
- stronger checkpoint persistence
- direct UI synchronization

---

## 2. Existing Runtime Analysis

Inspect actual implementation.

Analyze:

- harness execution loop
- task-state
- repo-context
- execution transparency
- checkpoint engine
- runtime snapshot
- sub-agent runner
- web socket event flow
- pet bridge
- execution plan panel

Must identify:

where task planning is currently missing.

Must identify:

which existing event channels can be reused.

---

## 3. Proposed Architecture

Describe new layer:

TaskGraph Planner.

Structure:

User Task
→ Planner
→ TaskGraph
→ Graph Executor
→ Review
→ Recovery

Explain:

Planner sits before Harness loop.

Harness becomes graph-driven executor.

---

## 4. Core Concepts

Define:

TaskNode
TaskEdge
ExecutionBranch
FallbackBranch
RecoverySignal
ExecutionCursor

Use TypeScript interfaces.

---

## 5. Graph Lifecycle

Describe:

1. task received
2. intent detect
3. graph build
4. node execute
5. node review
6. branch switch
7. checkpoint
8. final

Must include sequence diagram.

---

## 6. Node Types

Include:

- inspect
- search
- read
- edit
- verify
- summarize
- fallback
- delegate

Explain each.

---

## 7. Planner Rules

Must be deterministic.

No LLM planning in v1.

Rule-based generation.

Use:

- task intent
- repo context
- previous failures
- verification need
- changed files
- current branch budget

Examples:

debug
edit
refactor
implement
test

---

## 8. Graph Executor

Describe runtime execution.

How Harness consumes current node.

How current node constrains tool behavior.

How node status transitions.

States:

- pending
- running
- done
- failed
- skipped

---

## 9. Recovery Branching

Describe branch recovery.

When:

- retries exceeded
- repeated failure
- no progress
- invalid output
- verify fail

Fallback branches:

- alternate search path
- alternate file path
- alternate verification
- alternate sub-agent

Include examples.

---

## 10. Checkpoint Integration

Must align with current snapshot.

Additions:

- graph state
- current node
- branch id
- retry counters
- graph version
- node history
- branch history

Must preserve backward compatibility.

Existing sessions must still work.

---

## 11. Sub-Agent Integration

Describe delegated nodes.

Examples:

- repo exploration
- dependency trace
- test diagnosis
- broad search

Explain:

context isolation.

Explain:

result merge.

Must align existing async request_analysis sub-agent flow.

---

## 12. Execution Transparency Integration

Describe compatibility with current:

ExecutionPlanTracker.

TaskGraph must map into existing execution transparency layer.

Do not replace current layer.

Extend it.

Explain:

graph → execution plan projection.

Must preserve:

execution_plan_init
execution_plan_update
execution_plan_clear

Explain event extensions.

---

## 13. Web Execution Panel Integration

Must inspect existing front-end.

Analyze:

- src/public/js/chat-page.js
- session plan panel
- websocket updates

Design:

TaskGraph UI mapping.

Requirements:

Each TaskNode maps directly to panel item.

Must support:

- current node highlight
- completed node
- failed node
- skipped node
- fallback branch marker
- resumed state
- branch path indicator

Do not redesign UI from scratch.

Reuse existing panel.

---

## 14. Ice Bean Pet Integration

Must inspect:

- session-pet.js
- session-pet-palette.js
- chat-pet-bridge.js

Design:

TaskGraph → pet behavior mapping.

Requirements:

Pet reflects graph state.

Must include:

- current node state
- branch switching
- recovery mode
- delegate mode
- verification mode
- completion
- failure
- waiting

Describe mapping between graph signals and pet expressions.

Must reuse current websocket bridge.

Do not create separate pet protocol.

---

## 15. Failure Modes

Include:

- invalid graph
- dead branch
- repeated branch
- graph drift
- snapshot mismatch
- stale delegate result
- UI desync
- pet desync

For each:

suggest mitigation.

---

## 16. Migration Plan

Phase 1:
graph model

Phase 2:
executor integration

Phase 3:
checkpoint persistence

Phase 4:
execution panel integration

Phase 5:
pet integration

Phase 6:
adaptive planner

---

## 17. New Files

Use tree format.

Must include:

src/harness/task-graph.ts
src/harness/task-graph-builder.ts
src/harness/task-graph-executor.ts
src/harness/task-graph-review.ts
src/types/task-graph.ts

tests.

Must include front-end compatibility notes.

---

## 18. Open Questions

Examples:

- graph mutation
- nested branch
- branch compaction
- graph pruning
- graph replay
- graph visualization
- pet state override
- panel virtual branch rendering

---

## 19. Recommended Next Step

Suggest minimal rollout.

Prefer:

smallest viable integration.

Must preserve existing Harness behavior.

Graph must be optional in v1.

---

# Important

Before writing:

inspect actual code.

Must reference real files.

No assumptions.

No implementation.

Practical engineering design only.

Must be implementation-ready for later Cursor execution.