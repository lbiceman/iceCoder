import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_PET_DEMO,
  HARNESS_PET_DEMO_EXTRAS,
  HARNESS_PET_EXPRESSIONS,
  IDLE_POSES,
  idlePoseHoldMs,
} from '../../src/public/js/session-pet-harness-expr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');

describe('Harness 候选表情（Canvas，未接入）', () => {
  const harnessTypes = readFileSync(path.join(root, 'src/types/harness-runtime-state.ts'), 'utf-8');
  const sessionPet = readFileSync(path.join(root, 'src/public/js/session-pet.js'), 'utf-8');

  it('九态都有 JS 绘制函数', () => {
    const states = [...harnessTypes.matchAll(/\| '([a-z_]+)'/g)].map((m) => m[1]);
    expect(states).toEqual([
      'idle', 'running', 'planning', 'executing', 'streaming',
      'tool_calling', 'recovering', 'restoring', 'cancelling',
    ]);
    const demoStates = HARNESS_PET_DEMO.map((x) => x.state);
    expect(demoStates).toContain('idle');
    expect(demoStates).toEqual(expect.arrayContaining([
      'planning', 'running', 'executing', 'streaming',
      'tool_calling', 'recovering', 'restoring', 'cancelling',
    ]));
    for (const item of HARNESS_PET_DEMO.concat(HARNESS_PET_DEMO_EXTRAS)) {
      expect(typeof HARNESS_PET_EXPRESSIONS[item.state]).toBe('function');
    }
    expect(typeof HARNESS_PET_EXPRESSIONS.memory).toBe('function');
    expect(HARNESS_PET_DEMO_EXTRAS.some((x) => x.state === 'memory')).toBe(true);
    expect(HARNESS_PET_EXPRESSIONS.executing).toBe(HARNESS_PET_EXPRESSIONS.tool_calling);
  });

  it('拧扳手时左下手握住柄，不对捏', () => {
    const exprSrc = readFileSync(path.join(root, 'src/public/js/session-pet-harness-expr.js'), 'utf-8');
    const fn = exprSrc.slice(
      exprSrc.indexOf('function expressionToolCalling'),
      exprSrc.indexOf('function expressionStreaming'),
    );
    expect(exprSrc).not.toContain('function drawPinchGrip');
    expect(fn).toContain('drawHand');
    const m = fn.match(/drawHand\(ctx,\s*([^,]+),\s*([^,]+),\s*([^,]+)/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeLessThan(0);
    expect(Math.abs(Number(m[3]))).toBeGreaterThan(0.8);
  });

  it('session-pet 眨眼时仍走完整表情（只闭眼，不丢掉手）', () => {
    expect(sessionPet).toContain('HARNESS_PET_EXPRESSIONS');
    expect(sessionPet).toContain('isBlinking && !HARNESS_PET_SKIP_BLINK[state]');
    expect(sessionPet).not.toMatch(/if \(isBlinking[\s\S]*expressionBlink/);
    const exprSrc = readFileSync(path.join(root, 'src/public/js/session-pet-harness-expr.js'), 'utf-8');
    expect(exprSrc).toContain('wrapExpr');
    expect(exprSrc).toContain('drawClosedEyes');
  });

  it('demo 页标明尚未接入，且不引用切图', () => {
    const html = readFileSync(path.join(root, 'src/public/pet-expressions-demo.html'), 'utf-8');
    const demoJs = readFileSync(path.join(root, 'src/public/js/pet-expressions-demo.js'), 'utf-8');
    expect(html).toContain('尚未接入 harness');
    expect(html).not.toContain('pet-nomi-preview');
    expect(demoJs).not.toContain('/img/pet-nomi/');
    expect(existsSync(path.join(root, 'src/public/js/session-pet-harness-expr.js'))).toBe(true);
  });

  it('空闲有多套动作，招手只是短动作之一', () => {
    expect(IDLE_POSES).toEqual(['rest', 'glance', 'doze', 'wave', 'peace']);
    expect(sessionPet).toContain('scheduleIdlePose');
    expect(sessionPet).toContain("idlePose = 'rest'");
    for (let i = 0; i < 20; i++) {
      const wave = idlePoseHoldMs('wave');
      const rest = idlePoseHoldMs('rest');
      expect(wave).toBeGreaterThanOrEqual(1600);
      expect(wave).toBeLessThan(3100);
      expect(rest).toBeGreaterThanOrEqual(3800);
    }
  });
});
