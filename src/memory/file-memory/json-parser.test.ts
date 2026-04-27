/**
 * json-parser 单元测试。
 * 覆盖多层回退策略：直接解析、markdown 代码块、正则提取、格式修复、数组/对象互转。
 */

import { describe, it, expect } from 'vitest';
import { parseLLMJson, parseLLMJsonObject, parseLLMJsonArray } from './json-parser.js';

describe('parseLLMJsonObject', () => {
  it('直接解析纯 JSON 对象', () => {
    const result = parseLLMJsonObject('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('解析带前后空白的 JSON', () => {
    const result = parseLLMJsonObject('  \n{"a": 1}\n  ');
    expect(result).toEqual({ a: 1 });
  });

  it('从 markdown 代码块中提取 JSON', () => {
    const input = 'Here is the result:\n```json\n{"selected": ["a.md"]}\n```\nDone.';
    const result = parseLLMJsonObject<{ selected: string[] }>(input);
    expect(result?.selected).toEqual(['a.md']);
  });

  it('从无语言标记的代码块中提取', () => {
    const input = '```\n{"x": 42}\n```';
    const result = parseLLMJsonObject(input);
    expect(result).toEqual({ x: 42 });
  });

  it('从混合文本中正则提取第一个 {...}', () => {
    const input = 'The answer is {"result": true} and that is all.';
    const result = parseLLMJsonObject(input);
    expect(result).toEqual({ result: true });
  });

  it('修复尾部逗号', () => {
    const input = '{"a": 1, "b": 2,}';
    const result = parseLLMJsonObject(input);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('无法解析时返回 null', () => {
    expect(parseLLMJsonObject('not json at all')).toBeNull();
    expect(parseLLMJsonObject('')).toBeNull();
  });

  it('传入数组字符串时返回数组（typeof [] === "object"）', () => {
    // 注意：parseLLMJsonObject 不区分数组和对象，因为 typeof [] === 'object'
    // 如果需要严格区分，应使用 parseLLMJsonArray
    const result = parseLLMJsonObject('[]');
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('parseLLMJsonArray', () => {
  it('直接解析纯 JSON 数组', () => {
    const result = parseLLMJsonArray('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('解析空数组', () => {
    const result = parseLLMJsonArray('[]');
    expect(result).toEqual([]);
  });

  it('从 markdown 代码块中提取数组', () => {
    const input = '```json\n[{"name": "a"}, {"name": "b"}]\n```';
    const result = parseLLMJsonArray(input);
    expect(result).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('从对象中提取第一个数组字段（策略5）', () => {
    const input = '{"memories": [{"file": "a.md"}], "count": 1}';
    const result = parseLLMJsonArray(input);
    expect(result).toEqual([{ file: 'a.md' }]);
  });

  it('无法解析时返回 null', () => {
    expect(parseLLMJsonArray('not json')).toBeNull();
    expect(parseLLMJsonArray('{"key": "value"}')).toBeNull(); // 对象中无数组字段
  });
});

describe('parseLLMJson 边界情况', () => {
  it('处理嵌套对象', () => {
    const input = '{"a": {"b": {"c": 1}}}';
    const result = parseLLMJson(input);
    expect(result).toEqual({ a: { b: { c: 1 } } });
  });

  it('处理包含特殊字符的字符串值', () => {
    const input = '{"msg": "hello \\"world\\""}';
    const result = parseLLMJson(input);
    expect(result).toEqual({ msg: 'hello "world"' });
  });

  it('处理 LLM 常见的前缀文本', () => {
    const input = 'Sure! Here is the JSON:\n\n{"selected": ["user_role.md"]}';
    const result = parseLLMJsonObject<{ selected: string[] }>(input);
    expect(result?.selected).toEqual(['user_role.md']);
  });
});
