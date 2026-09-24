import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolDefinition } from 'contracts';
import { ToolRegistry, validateToolInput } from './registry';
import { evaluateExpression } from './calculate';
import { textStatsTool } from './textStats';
import { createDefaultToolRegistry } from './index';

// ===== calculate：求值正确性 =====

test('evaluateExpression：基础运算与优先级', () => {
  const ok = (expr: string, expected: number) => {
    const result = evaluateExpression(expr);
    assert.equal(result.ok, true, expr);
    assert.equal(result.data, expected, expr);
  };
  ok('2+3*4', 14);
  ok('(5-3)/2', 1);
  ok('10%3', 1);
  ok('-4+10', 6); // 一元负号
  ok('2.5*4', 10);
  ok('0.1+0.2', 0.3); // 浮点尾差修正
  ok('2 + 3', 5); // 空白容忍
  ok('((1+2)*(3+4))', 21); // 嵌套括号
});

test('evaluateExpression：受控失败（不抛异常）', () => {
  const fail = (expr: string, keyword: string) => {
    const result = evaluateExpression(expr);
    assert.equal(result.ok, false, expr);
    assert.ok(result.error!.includes(keyword), `${expr} 应包含 "${keyword}"`);
  };
  fail('1/0', '除数为零');
  fail('5%0', '除数为零');
  fail('1+', '表达式');
  fail('abc', '非法字符');
  fail('(1+2', '括号');
  fail('1 2', '多余内容');
  fail('', '空');
});

// ===== text_stats =====

test('text_stats：统计字符 / 词 / 行', async () => {
  const result = await textStatsTool.execute({ text: 'hello world' }, { taskId: 't', signal: AbortSignal.timeout(1000) });
  assert.deepEqual(result.data, { characters: 11, words: 2, lines: 1 });

  const multi = await textStatsTool.execute(
    { text: '第一行\nsecond line\n' },
    { taskId: 't', signal: AbortSignal.timeout(1000) },
  );
  assert.deepEqual(multi.data, { characters: 16, words: 3, lines: 3 });
});

// ===== 输入校验 =====

const demoTool: ToolDefinition<{ a: string; b?: number }> = {
  name: 'demo',
  description: '测试用',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'number' },
    },
    required: ['a'],
  },
  async execute() {
    return { ok: true };
  },
};

test('validateToolInput：通过 / 缺必填 / 多余参数 / 类型错误', () => {
  assert.equal(validateToolInput(demoTool, { a: 'x' }), null);
  assert.equal(validateToolInput(demoTool, { a: 'x', b: 1 }), null);

  assert.ok(validateToolInput(demoTool, {})!.includes('缺少必填参数'));
  assert.ok(validateToolInput(demoTool, { a: 'x', c: 1 })!.includes('未声明'));
  assert.ok(validateToolInput(demoTool, { a: 1 })!.includes('类型'));
  assert.ok(validateToolInput(demoTool, 'not-object')!.includes('对象'));
  assert.ok(validateToolInput(demoTool, null)!.includes('对象'));
});

test('validateToolInput：字符串长度上限（安全边界）', () => {
  const long = 'x'.repeat(10_001);
  const violation = validateToolInput(demoTool, { a: long });
  assert.ok(violation!.includes('长度上限'));
});

// ===== 注册表 =====

test('ToolRegistry：注册 / 查询 / 重复与非法定义', () => {
  const registry = new ToolRegistry();
  registry.register(demoTool);
  assert.equal(registry.get('demo')!.name, 'demo');
  assert.equal(registry.get('missing'), undefined);
  assert.throws(() => registry.register(demoTool), /已注册/);

  const bad = { ...demoTool, name: 'bad', inputSchema: undefined } as unknown as ToolDefinition;
  assert.throws(() => registry.register(bad), /inputSchema/);
});

test('createDefaultToolRegistry：包含 calculate 与 text_stats，且仅限白名单工具', () => {
  const registry = createDefaultToolRegistry();
  assert.deepEqual(
    registry.list().map((t) => t.name).sort(),
    ['calculate', 'text_stats'],
  );
});
