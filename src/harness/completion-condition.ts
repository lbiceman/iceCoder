export type CompletionConditionStatus =
  | 'pending'
  | 'satisfied'
  | 'failed'
  | 'unverifiable';

export type CompletionConditionSource = 'user' | 'graph' | 'runtime';

/**
 * 领域无关的完成条件。核心门控只消费状态与证据引用，
 * 不感知条件来自哪种任务、工具或交付物。
 */
export interface CompletionCondition {
  id: string;
  label: string;
  required: boolean;
  status: CompletionConditionStatus;
  source: CompletionConditionSource;
  sourceRef: string;
  evidenceRefs: string[];
}

export class CompletionConditionLedger {
  private readonly conditions = new Map<string, CompletionCondition>();

  record(condition: CompletionCondition): void {
    const previous = this.conditions.get(condition.id);
    this.conditions.set(condition.id, {
      ...condition,
      // 已登记的硬条件不能被后续适配器静默降级。
      required: previous?.required === true ? true : condition.required,
      label: previous?.required === true ? previous.label : condition.label,
      source: previous?.required === true ? previous.source : condition.source,
      sourceRef: previous?.required === true ? previous.sourceRef : condition.sourceRef,
      evidenceRefs: [...new Set(condition.evidenceRefs)],
    });
  }

  replaceSource(source: CompletionConditionSource, conditions: readonly CompletionCondition[]): void {
    const nextIds = new Set(conditions.map(condition => condition.id));
    for (const [id, condition] of this.conditions) {
      if (condition.source === source && !condition.required && !nextIds.has(id)) {
        this.conditions.delete(id);
      }
    }
    for (const condition of conditions) this.record(condition);
  }

  list(): CompletionCondition[] {
    return [...this.conditions.values()].map(condition => ({
      ...condition,
      evidenceRefs: [...condition.evidenceRefs],
    }));
  }

  /** 返回可安全持久化的独立快照。 */
  snapshot(): CompletionCondition[] {
    return this.list();
  }

  /** 用快照完整替换账本；重复恢复同一快照不会累加状态。 */
  replace(snapshot: readonly CompletionCondition[]): void {
    const next = new Map<string, CompletionCondition>();
    for (const condition of snapshot) {
      const previous = next.get(condition.id);
      next.set(condition.id, {
        ...condition,
        required: previous?.required === true ? true : condition.required,
        label: previous?.required === true ? previous.label : condition.label,
        source: previous?.required === true ? previous.source : condition.source,
        sourceRef: previous?.required === true ? previous.sourceRef : condition.sourceRef,
        evidenceRefs: [...new Set(condition.evidenceRefs)],
      });
    }
    this.conditions.clear();
    for (const [id, condition] of next) this.conditions.set(id, condition);
  }

  restore(snapshot: readonly CompletionCondition[]): void {
    this.replace(snapshot);
  }
}
