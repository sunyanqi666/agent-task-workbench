import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db';
import { buildServer } from '../app';
import { loadConfig } from '../config';
import { createTask, getEvents, getTask, transitionTask } from '../services/taskService';
import { ToolRegistry } from '../tools';
import { DemoModel } from './model';
import type { RunnerDeps } from './runTask';
import { runTask } from './runTask';
import { recoverInterruptedTasks } from './recovery';

/** 与 runTask.test.ts 的 makeRunner 同构：默认无工具、demo 模型零延迟 */
function makeDeps(overrides: Partial<RunnerDeps> = {}): {
  deps: RunnerDeps;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'recovery-test-'));
  const db = openDatabase(path.join(dir, `${randomUUID()}.db`));
  const deps: RunnerDeps = {
    db,
    registry: new ToolRegistry(),
    model: new DemoModel(0),
    liveModel: null,
    maxSteps: 5,
    maxToolCallsPerTurn: 10,
    stepTimeoutMs: 1000,
    maxUserConcurrentTasks: 5,
    userCreateRatePerMinute: 10,
    maxTaskBudgetCny: 10,
    ...overrides,
  };
  return { deps, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** 轮询等待任务到达终态（恢复是异步执行，返回时任务可能仍在跑） */
async function waitForTerminal(db: DatabaseSync, taskId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (['completed', 'failed', 'canceled'].includes(getTask(db, taskId).status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务未在预期时间内到达终态：${taskId}`);
}

test('启动恢复：running 孤儿任务落终态 failed(interrupted)，事件留痕且可重试', (t) => {
  const { deps, db, cleanup } = makeDeps();
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x' });
  transitionTask(db, task.id, { to: 'running' }); // 模拟进程中断时正在执行

  const recovery = recoverInterruptedTasks(deps);
  assert.deepEqual(recovery, { resumed: [], interrupted: [task.id] });

  const final = getTask(db, task.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.errorCode, 'interrupted');
  const events = getEvents(db, task.id, 0);
  const last = events.at(-1)!;
  assert.equal(last.type, 'task.failed');
  assert.equal((last.payload as { errorCode: string }).errorCode, 'interrupted');
});

test('启动恢复：queued 任务重新入队执行至终态；已终态任务不受影响', async (t) => {
  const { deps, db, cleanup } = makeDeps();
  t.after(cleanup);
  deps.registry.register((await import('../tools/calculate')).calculateTool);

  const completed = createTask(db, { prompt: '计算 1+1 的结果' });
  await runTask(deps, completed.id); // 中断前已完成
  const queued = createTask(db, { prompt: '计算 2+2 的结果' }); // 中断时仍在排队

  const recovery = recoverInterruptedTasks(deps);
  assert.deepEqual(recovery, { resumed: [queued.id], interrupted: [] });

  await waitForTerminal(db, queued.id);
  assert.equal(getTask(db, queued.id).status, 'completed');
  assert.equal(getTask(db, completed.id).status, 'completed'); // 终态任务不被触碰
  // 重新执行产生完整事件序列（原 queued 任务照常走完状态机）
  const types = getEvents(db, queued.id, 0).map((e) => e.type);
  assert.ok(types.includes('task.started') && types.includes('task.completed'));
});

test('buildServer 启动即执行恢复：遗留 queued / running 任务被处理，服务可正常请求', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'recovery-boot-'));
  const db = openDatabase(path.join(dir, `${randomUUID()}.db`));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const running = createTask(db, { prompt: '中断前运行中' });
  transitionTask(db, running.id, { to: 'running' });
  const queued = createTask(db, { prompt: '计算 2+3 的结果' });

  // 真实启动路径：恢复发生在 buildServer 内、注册路由前
  const app = await buildServer(db, loadConfig({ logger: false, demoStepDelayMs: 0 }));
  t.after(() => app.close());

  assert.equal(getTask(db, running.id).status, 'failed');
  assert.equal(getTask(db, running.id).errorCode, 'interrupted');
  await waitForTerminal(db, queued.id);
  assert.equal(getTask(db, queued.id).status, 'completed');

  // 服务本身可用：健康检查与任务列表正常响应
  const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(health.statusCode, 200);
  const list = await app.inject({ method: 'GET', url: '/api/v1/tasks' });
  assert.equal(list.statusCode, 200);
  assert.equal((list.json<{ total: number }>().total), 2);
});
