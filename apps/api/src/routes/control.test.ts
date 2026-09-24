import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Task, TaskEvent } from 'contracts';
import { makeApp, waitForTerminal } from '../testing';
import { createTask, getTask, transitionTask } from '../services/taskService';

/** 轮询任务直至出现目标状态（非终态也可用） */
async function waitStatus(app: Awaited<ReturnType<typeof makeApp>>['app'], id: string, status: Task['status']): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}` });
    if (((res.json() as Task).status) === status) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`任务 ${id} 未在预期时间内进入 ${status}`);
}

test('取消 queued 任务：直接落终态，事件包含 task.canceled', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);

  // 经服务层创建（不经路由触发执行），任务保持 queued
  const task = createTask(db, { prompt: '计算 1+1' });
  const res = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.id}/cancel` });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as Task).status, 'canceled');

  const final = getTask(db, task.id);
  assert.equal(final.status, 'canceled');
  assert.equal(final.errorCode, 'canceled');
  const eventsRes = await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}/events` });
  const { events } = eventsRes.json() as { events: TaskEvent[] };
  assert.ok(events.some((e) => e.type === 'task.canceled'));
});

test('取消 running 任务：202 受理 → 运行器协作终止，task.canceled 是最后一个事件', async (t) => {
  const { app, cleanup } = await makeApp({ demoStepDelayMs: 60 });
  t.after(cleanup);

  const createRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 (12+8)*3 的结果' },
  });
  const { id } = createRes.json() as Task;
  await waitStatus(app, id, 'running');

  const cancelRes = await app.inject({ method: 'POST', url: `/api/v1/tasks/${id}/cancel` });
  assert.equal(cancelRes.statusCode, 202);
  assert.equal((cancelRes.json() as Task).status, 'running'); // 受理时仍是 running，终态由事件流推送

  const final = await waitForTerminal(app, id);
  assert.equal(final.status, 'canceled');
  assert.equal(final.errorCode, 'canceled');

  const eventsRes = await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}/events` });
  const { events } = eventsRes.json() as { events: TaskEvent[] };
  assert.equal(events.at(-1)!.type, 'task.canceled'); // 终态事件之后不再有过程事件
});

test('取消幂等与终态冲突：canceled → 200；completed → 409', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  // completed 任务 → 409
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+1' },
  });
  const { id } = createRes.json() as Task;
  const done = await waitForTerminal(app, id);
  assert.equal(done.status, 'completed');
  const res409 = await app.inject({ method: 'POST', url: `/api/v1/tasks/${id}/cancel` });
  assert.equal(res409.statusCode, 409);
  assert.equal(res409.json().error.code, 'status_conflict');

  // canceled 任务 → 幂等 200
  const { app: app2, db: db2, cleanup: cleanup2 } = await makeApp();
  t.after(cleanup2);
  const canceled = createTask(db2, { prompt: 'x' });
  transitionTask(db2, canceled.id, { to: 'canceled' }); // queued → canceled 是合法迁移
  const res200 = await app2.inject({ method: 'POST', url: `/api/v1/tasks/${canceled.id}/cancel` });
  assert.equal(res200.statusCode, 200);
  assert.equal((res200.json() as Task).status, 'canceled');
});

test('重试已取消任务：201 新任务带 parentTaskId 并执行完成，原任务不被改写', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);

  const original = createTask(db, { prompt: '计算 (12+8)*3 的结果' });
  transitionTask(db, original.id, { to: 'canceled' });

  const res = await app.inject({ method: 'POST', url: `/api/v1/tasks/${original.id}/retry` });
  assert.equal(res.statusCode, 201);
  const retry = res.json() as Task;
  assert.equal(retry.parentTaskId, original.id);
  assert.equal(retry.prompt, original.prompt);
  assert.equal(retry.mode, original.mode);
  assert.notEqual(retry.id, original.id);

  const final = await waitForTerminal(app, retry.id);
  assert.equal(final.status, 'completed'); // 新任务正常执行完成
  assert.equal(getTask(db, original.id).status, 'canceled'); // 原任务历史不变
});

test('重试失败任务：201 并完成（failed 状态经服务层构造）', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);

  const original = createTask(db, { prompt: '计算 2+2' });
  transitionTask(db, original.id, { to: 'running' });
  transitionTask(db, original.id, { to: 'failed', errorCode: 'model_error', message: '构造失败' });

  const res = await app.inject({ method: 'POST', url: `/api/v1/tasks/${original.id}/retry` });
  assert.equal(res.statusCode, 201);
  const retry = res.json() as Task;
  assert.equal(retry.parentTaskId, original.id);
  assert.equal((await waitForTerminal(app, retry.id)).status, 'completed');
});

test('重试语义边界：completed / queued → 409；live 未配置 → 503', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);

  // completed → 409
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+1' },
  });
  const { id } = createRes.json() as Task;
  await waitForTerminal(app, id);
  const res409 = await app.inject({ method: 'POST', url: `/api/v1/tasks/${id}/retry` });
  assert.equal(res409.statusCode, 409);

  // queued → 409（任务尚未失败，重试无意义）
  const queued = createTask(db, { prompt: 'x' });
  const res409q = await app.inject({ method: 'POST', url: `/api/v1/tasks/${queued.id}/retry` });
  assert.equal(res409q.statusCode, 409);

  // live 失败任务 → 503（未配置真实模型）
  const liveTask = createTask(db, { prompt: 'x', mode: 'live' });
  transitionTask(db, liveTask.id, { to: 'running' });
  transitionTask(db, liveTask.id, { to: 'failed', errorCode: 'model_error', message: '构造失败' });
  const res503 = await app.inject({ method: 'POST', url: `/api/v1/tasks/${liveTask.id}/retry` });
  assert.equal(res503.statusCode, 503);
  assert.equal(res503.json().error.code, 'live_model_not_configured');
});

test('cancel / retry 不存在的任务返回 404（控制端点与资源端点语义一致）', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const missing = randomUUID();
  for (const url of [`/api/v1/tasks/${missing}/cancel`, `/api/v1/tasks/${missing}/retry`]) {
    const res = await app.inject({ method: 'POST', url });
    assert.equal(res.statusCode, 404);
  }
});
