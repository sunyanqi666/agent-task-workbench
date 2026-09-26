import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db';
import {
  appendEvent,
  createTask,
  getEvents,
  getTask,
  listTasks,
  recordModelUsage,
  taskExists,
  transitionTask,
} from './taskService';
import { ConflictError, NotFoundError } from './errors';

/** 每个用例独立全新数据库 */
function makeDb(): { db: DatabaseSync; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'tasksvc-test-'));
  const db = openDatabase(path.join(dir, `${randomUUID()}.db`));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('createTask：初始 queued + task.created 事件（seq=1）', (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  const task = createTask(db, { prompt: '  计算任务  ' });
  assert.equal(task.status, 'queued');
  assert.equal(task.mode, 'demo');
  assert.equal(task.parentTaskId, null);
  assert.equal(task.startedAt, null);
  assert.equal(task.finishedAt, null);
  assert.equal(task.errorCode, null);
  assert.equal(task.prompt, '计算任务'); // 首尾空白已去除

  const events = getEvents(db, task.id, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'task.created');
  assert.equal(events[0]!.seq, 1);
  assert.deepEqual(events[0]!.payload, { prompt: '计算任务' });
});

test('状态机全链路：queued → running → completed，事件与时间戳同步写入', (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x' });
  const running = transitionTask(db, task.id, { to: 'running' });
  assert.equal(running.status, 'running');
  assert.ok(running.startedAt, 'startedAt 应在迁移到 running 时写入');

  const done = transitionTask(db, task.id, { to: 'completed', summary: '完成' });
  assert.equal(done.status, 'completed');
  assert.ok(done.finishedAt);
  assert.equal(done.errorCode, null);

  assert.deepEqual(
    getEvents(db, task.id, 0).map((e) => e.type),
    ['task.created', 'task.started', 'task.completed'],
  );
});

test('非法迁移抛 ConflictError 且不产生任何写入（事务回滚不变量）', (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x' });
  const eventsBefore = getEvents(db, task.id, 0).length;

  // queued 只能去 running / canceled
  assert.throws(() => transitionTask(db, task.id, { to: 'completed', summary: 's' }), ConflictError);
  assert.throws(() => transitionTask(db, task.id, { to: 'failed', errorCode: 'internal', message: 'm' }), ConflictError);

  // 失败迁移后：状态与事件数量均不变
  assert.equal(getTask(db, task.id).status, 'queued');
  assert.equal(getEvents(db, task.id, 0).length, eventsBefore);
});

test('终态不可迁移：completed → running 被拒绝', (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x' });
  transitionTask(db, task.id, { to: 'running' });
  transitionTask(db, task.id, { to: 'completed', summary: 'ok' });

  assert.throws(() => transitionTask(db, task.id, { to: 'running' }), ConflictError);
  assert.throws(() => transitionTask(db, task.id, { to: 'failed', errorCode: 'internal', message: 'm' }), ConflictError);
});

test('failed / canceled 迁移：errorCode 与事件载荷正确', (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  const a = createTask(db, { prompt: 'a' });
  transitionTask(db, a.id, { to: 'running' });
  const failed = transitionTask(db, a.id, { to: 'failed', errorCode: 'tool_error', message: '工具失败' });
  assert.equal(failed.errorCode, 'tool_error');
  const failedEvent = getEvents(db, a.id, 0).at(-1)!;
  assert.equal(failedEvent.type, 'task.failed');
  assert.deepEqual(failedEvent.payload, { errorCode: 'tool_error', message: '工具失败' });

  const b = createTask(db, { prompt: 'b' });
  const canceled = transitionTask(db, b.id, { to: 'canceled' });
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.errorCode, 'canceled');
  assert.equal(getEvents(db, b.id, 0).at(-1)!.type, 'task.canceled');
});

test('appendEvent：seq 单调递增；getEvents 的 afterSeq 增量过滤', (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x' });
  appendEvent(db, task.id, 'model.output', { text: 'a' });
  appendEvent(db, task.id, 'model.output', { text: 'b' });

  const all = getEvents(db, task.id, 0);
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(getEvents(db, task.id, 1).map((e) => e.payload), [
    { text: 'a' },
    { text: 'b' },
  ]);
  assert.deepEqual(getEvents(db, task.id, 2).map((e) => e.payload), [{ text: 'b' }]);
  assert.equal(getEvents(db, task.id, 3).length, 0);
});

test('listTasks：按创建时间倒序 + 分页与 total', async (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  // created_at 精度有限，错开创建时间保证倒序稳定
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const task = createTask(db, { prompt: `task-${i}` });
    ids.push(task.id);
    await new Promise((r) => setTimeout(r, 15));
  }

  const page = listTasks(db, { limit: 2, offset: 0, userId: null });
  assert.equal(page.total, 3);
  assert.deepEqual(page.items.map((task) => task.id), [ids[2], ids[1]]);

  const rest = listTasks(db, { limit: 2, offset: 2, userId: null });
  assert.deepEqual(rest.items.map((task) => task.id), [ids[0]]);
});

test('不存在 的任务：getTask 抛 NotFoundError，taskExists 返回 false', (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  const missing = randomUUID();
  assert.throws(() => getTask(db, missing), NotFoundError);
  assert.equal(taskExists(db, missing), false);
});

test('createTask 固化 modelId；recordModelUsage 逐次累加且不产生事件', (t) => {
  const { db, cleanup } = makeDb();
  t.after(cleanup);

  const task = createTask(db, { prompt: 'x', mode: 'demo', modelId: 'deepseek-v4-pro' });
  assert.equal(task.modelId, 'deepseek-v4-pro');
  assert.deepEqual(task.usage, { promptTokens: 0, completionTokens: 0 });

  recordModelUsage(db, task.id, { promptTokens: 12, completionTokens: 3 });
  recordModelUsage(db, task.id, { promptTokens: 5, completionTokens: 4 });
  const updated = getTask(db, task.id);
  assert.deepEqual(updated.usage, { promptTokens: 17, completionTokens: 7 });
  assert.equal(updated.modelId, 'deepseek-v4-pro');
  // 用量不是过程事件：不追加 task_events
  assert.equal(getEvents(db, task.id, 0).length, 1);
});
