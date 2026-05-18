Implement iceCoder v2 Runtime Resilience Layer.

This is an additive runtime upgrade for long-duration engineering tasks.

Goal:

Improve stability for 30–60 minute coding sessions.

Focus on:

1. Step Review
2. Branch Budget
3. Enhanced Checkpoint Persistence

Do not redesign existing Harness.
Do not replace current task loop.
Integrate incrementally.

---

# Constraints

Strictly follow:

1. Preserve current Harness main loop.
2. Preserve TaskState existing schema.
3. Preserve RepoContext existing schema.
4. Preserve session snapshot compatibility.
5. Additive only.
6. Feature flag required.
7. No breaking change for CLI.
8. No memory subsystem refactor.
9. No LLM architecture changes.
10. No planner implementation.

---

# Phase Scope

Implement ONLY:

Phase A:
- step review
- branch budget
- checkpoint engine enhancement

Do not implement context tiering yet.

---

# Required Files

Create:

src/harness/step-review.ts
src/harness/branch-budget.ts
src/harness/checkpoint-engine.ts
src/types/runtime-checkpoint.ts

test/harness/step-review.test.ts
test/harness/branch-budget.test.ts
test/harness/checkpoint-engine.test.ts

---

# Part 1 — Step Review

Implement runtime step review.

Purpose:

After each execution step completes,
evaluate whether progress occurred.

This is internal runtime control.

Not user visible.

---

## Trigger

Run only when:

- step transition occurs
- tool failure occurs
- verification failure occurs

Do NOT run every loop.

---

## Behavior

Evaluate:

- was progress made
- same action repeated
- fallback required
- next step valid

---

## Interface

Create:

export interface StepReviewResult {
  progressMade: boolean;
  repeatedPattern: boolean;
  fallbackSuggested: boolean;
  reason: string;
}

---

## Implementation

Use lightweight LLM call.

Short prompt.

Max 1 small completion.

Use minimal context:
- current step
- recent tools
- last errors
- task goal

Must be bounded.

---

# Part 2 — Branch Budget

Implement branch execution budget.

Purpose:

Prevent repeated ineffective loops.

---

## Track

Budget dimensions:

1. file edit count
2. command retry count
3. error repetition count

---

## Example

Same file:

max 3 edits

Same shell:

max 2 retries

Same diagnostic signature:

max 3 retries

---

## Behavior

If exceeded:

force recovery signal.

---

## Interface

Create:

class BranchBudgetTracker

Methods:

recordFileEdit()
recordCommand()
recordError()
shouldBranchRecover()

---

## Recovery

When triggered:

inject runtime warning:

Current branch exhausted.
Switch strategy.

Do not hard abort.

---

# Part 3 — Enhanced Checkpoint Engine

Upgrade persistence.

Current snapshot remains compatible.

Add optional enhanced runtime state.

---

## Store

Persist:

- current execution step
- branch budget state
- recent tool history
- recent failures
- plan version
- verification pending
- recovery signals

---

## Schema

New versioned schema.

Backward compatible.

Use:

runtimeVersion: 2

---

## Save Trigger

Save automatically after:

- step completed
- tool failed
- verification started
- verification failed
- compaction
- final draft

---

## Restore

Restore automatically.

If missing:
fallback to current snapshot.

---

# Integration

Integrate into existing Harness.

Hook points:

1. after tool execution
2. after verification gate
3. before compaction
4. before final response

Minimal intrusion.

No loop redesign.

---

# Feature Flag

Required:

ICE_ENABLE_RESILIENCE_V2=1

If disabled:

zero behavior changes.

---

# Testing

Add tests.

---

## Step Review

Test:

- progress detection
- repeated detection
- fallback signal

---

## Branch Budget

Test:

- file count
- command count
- error count
- recovery trigger

---

## Checkpoint

Test:

- save
- restore
- backward compatibility
- invalid snapshot fallback

---

# Output Process

Work step by step.

Do not implement all at once.

Order:

1. inspect existing harness
2. inspect snapshot system
3. design interfaces
4. implement step review
5. implement branch budget
6. implement checkpoint
7. tests

After each step:

explain:

- files changed
- why
- compatibility considerations

Prefer smallest changes.

No unnecessary refactor.

---

# Important

This feature exists to improve runtime resilience.

Not UI.

Not planner.

Not multi-agent.

Do not expand scope.

Keep runtime focused.