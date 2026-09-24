import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolDefinition } from 'contracts';
import { openDatabase } from '../db';
import { createTask, getEvents, getTask } from '../services/taskService';
import { ToolRegistry } from '../tools';
import { DemoModel } from './model';
import type { ModelAction, ModelAdapter } from './model';
import { runTask, type RunnerDeps } from './runTask';

function makeRunner(overrides: Partial<RunnerDeps>): {
  deps: RunnerDeps;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-test-'));
  const db = openDatabase(path.join(dir, `${randomUUID()}.db`));
  const deps: RunnerDeps = {
    db,
    registry: new ToolRegistry(),
    model: new DemoModel(),
    maxSteps: 5,
    stepTimeoutMs: 1000,
    ...overrides,
  };
  return { deps, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** 用脚本编排的 fake 模型：actions 依次返回 */
function scriptedModel(actions: ModelAction[]): ModelAdapter {
  let index = 0;
  return {
    async nextStep() {
      return actions[Math.min(index++, actions.length - 1)]!;
    },
  };
}

test('demo 模型全链路：表达式任务 → completed，事件序列完整且含工具调用', async (t) => {
  const { deps, db, cleanup } = makeRunner({ model: new DemoModel(), maxSteps: 20 });
  t.after(cleanup);
  deps.registry.register((await import('../tools/calculate')).calculateTool);
  deps.registry.register((await import('../tools/textStats')).textStatsTool);

  const task = createTask(db, { prompt: '请计算 (2+3)*4 的结果' });
  await runTask(deps, task.id);

  const final = getTask(db, task.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.errorCode, null);

  const events = getEvents(db, task.id, 0);
  assert.deepEqual(
    events.map((e) => e.type),
    ['task.created', 'task.started', 'model.output', 'tool.started', 'tool.completed', 'model.output', 'task.completed'],
  );
  const toolEvent = events.find((e) => e.type === 'tool.completed')!;
  assert.equal((toolEvent.payload as { name: string }).name, 'calculate');
  assert.equal((toolEvent.payload as { output: number }).output, 20);
  const doneEvent = events.find((e) => e.type === 'task.completed')!;
  assert.equal((doneEvent.payload as { summary: string }).summary, '计算完成：(2+3)*4 = 20');
});

test('demo 模型：无表达式时调用 text_stats（至少一次工具调用不变量）', async (t) => {
  const { deps, db, cleanup } = makeRunner({ model: new DemoModel(), maxSteps: 20 });
  t.after(cleanup);
  deps.registry.register((await import('../tools/calculate')).calculateTool);
  deps.registry.register((await import('../tools/textStats')).textStatsTool);

  const task = createTask(db, { prompt: '你好，这是一段没有算式的文本' });
  await runTask(deps, task.id);

  const events = getEvents(db, task.id, 0);
  const toolEvent = events.find((e) => e.type === 'tool.completed')!;
  assert.equal((toolEvent.payload as { name: string }).name, 'text_stats');
  assert.equal(getTask(db, task.id).status, 'completed');
});

test('步数上限：模型不终止 → max_steps_exceeded 失败', async (t) => {
  const { deps, db, cleanup } = makeRunner({
    model: scriptedModel([{ kind: 'output', text: '无限输出' }]),
    maxSteps: 3,
  });
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x' });
  await runTask(deps, task.id);

  const final = getTask(db, task.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.errorCode, 'max_steps_exceeded');
  // 3 步 model.output + created/started/failed 事件
  assert.equal(getEvents(db, task.id, 0).filter((e) => e.type === 'model.output').length, 3);
  assert.equal(getEvents(db, task.id, 0).at(-1)!.type, 'task.failed');
});

test('未注册工具：写入 tool.failed，模型可容错并完成', async (t) => {
  const { deps, db, cleanup } = makeRunner({
    model: scriptedModel([
      { kind: 'tool_call', name: 'dangerous_tool', input: {} },
      { kind: 'finish', summary: '容错完成' },
    ]),
  });
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x' });
  await runTask(deps, task.id);

  const failedEvent = getEvents(db, task.id, 0).find((e) => e.type === 'tool.failed')!;
  assert.ok((failedEvent.payload as { error: string }).error.includes('未注册'));
  assert.equal(getTask(db, task.id).status, 'completed');
});

test('工具超时：超过 stepTimeoutMs → tool.failed(超时)', async (t) => {
  const slowTool: ToolDefinition<{ ms: number }> = {
    name: 'slow',
    description: '慢工具',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
      required: ['ms'],
    },
    async execute({ ms }, context) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(context.signal.reason); });
      });
      return { ok: true, data: null };
    },
  };
  const { deps, db, cleanup } = makeRunner({
    model: scriptedModel([
      { kind: 'tool_call', name: 'slow', input: { ms: 200 } },
      { kind: 'finish', summary: '结束' },
    ]),
    stepTimeoutMs: 30,
  });
  t.after(cleanup);
  deps.registry.register(slowTool);

  const task = createTask(db, { prompt: 'x' });
  await runTask(deps, task.id);

  const failedEvent = getEvents(db, task.id, 0).find((e) => e.type === 'tool.failed')!;
  assert.ok((failedEvent.payload as { error: string }).error.includes('超时'));
});

test('模型抛错 → task.failed(model_error)', async (t) => {
  const broken: ModelAdapter = {
    async nextStep() {
      throw new Error('模型内部故障');
    },
  };
  const { deps, db, cleanup } = makeRunner({ model: broken });
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x' });
  await runTask(deps, task.id);

  const final = getTask(db, task.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.errorCode, 'model_error');
});

test('runTask 幂等：终态任务重复执行不产生新事件', async (t) => {
  const { deps, db, cleanup } = makeRunner({
    model: scriptedModel([{ kind: 'finish', summary: '完成' }]),
  });
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x' });
  await runTask(deps, task.id);
  const eventsAfterFirst = getEvents(db, task.id, 0).length;

  await runTask(deps, task.id); // 重复执行：应直接返回
  assert.equal(getEvents(db, task.id, 0).length, eventsAfterFirst);
  assert.equal(getTask(db, task.id).status, 'completed');
});
