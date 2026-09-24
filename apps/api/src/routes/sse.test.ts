import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Task, TaskEvent } from 'contracts';
import { makeApp, parseSseEvents, waitForTerminal } from '../testing';
import { subscribeTaskEvents, publishTaskEvent } from '../services/eventBus';

test('eventBus：订阅 / 取消 / 广播隔离', () => {
  const received: TaskEvent[] = [];
  const fake = (seq: number): TaskEvent => ({
    id: randomUUID(),
    taskId: 't1',
    seq,
    type: 'model.output',
    payload: { text: `x${seq}` },
    createdAt: new Date().toISOString(),
  });

  const unsubscribe = subscribeTaskEvents('t1', (e) => received.push(e));
  publishTaskEvent(fake(1));
  publishTaskEvent(fake(2));
  unsubscribe();
  publishTaskEvent(fake(3)); // 取消后不再接收

  assert.equal(received.length, 2);
  assert.deepEqual(received.map((e) => e.seq), [1, 2]);

  // 不同任务互不干扰
  const other: TaskEvent[] = [];
  const off = subscribeTaskEvents('t2', (e) => other.push(e));
  publishTaskEvent(fake(4));
  off();
  assert.equal(other.length, 0);
});

test('SSE：已完成任务回放全部事件后正常结束（headers 与格式）', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const createRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+2 的值' },
  });
  const { id } = createRes.json() as Task;
  await waitForTerminal(app, id);

  const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}/stream` });
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['content-type']!.startsWith('text/event-stream'));

  const events = parseSseEvents(res.body);
  assert.equal(events.length, 7);
  assert.deepEqual(
    events.map((e) => e.type),
    ['task.created', 'task.started', 'model.output', 'tool.started', 'tool.completed', 'model.output', 'task.completed'],
  );
  // SSE 事件 ID 使用 seq
  assert.ok(res.body.includes('id: 7\n'), '最后一帧的 SSE id 应为 7');
});

test('SSE：afterSeq 续接只发送增量事件', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const createRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 3*3 的值' },
  });
  const { id } = createRes.json() as Task;
  await waitForTerminal(app, id);

  const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}/stream?afterSeq=5` });
  const events = parseSseEvents(res.body);
  assert.deepEqual(events.map((e) => e.seq), [6, 7]);
});

test('SSE：不存在的任务返回 404 JSON（不升级为流）', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${randomUUID()}/stream` });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'not_found');
});

test('SSE 实时流：创建后连接，逐条接收事件直至终态结束', async (t) => {
  // 使用真实端口：inject 无法消费不结束的流
  const { app, cleanup } = await makeApp({ demoStepDelayMs: 60 });
  t.after(cleanup);
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  // 先建任务（queued），立刻连接流：回放 + 实时订阅混合路径
  const createRes = await fetch(`${base}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '计算 (10-4)/2 的结果' }),
  });
  assert.equal(createRes.status, 201);
  const { id } = (await createRes.json()) as Task;

  const streamRes = await fetch(`${base}/api/v1/tasks/${id}/stream`);
  assert.ok(streamRes.headers.get('content-type')!.startsWith('text/event-stream'));

  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  let body = '';
  // 终态事件后服务端关闭流，read() 返回 done
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    body += decoder.decode(value, { stream: true });
  }

  const events = parseSseEvents(body);
  assert.deepEqual(
    events.map((e) => e.type),
    ['task.created', 'task.started', 'model.output', 'tool.started', 'tool.completed', 'model.output', 'task.completed'],
  );
  // seq 严格递增且事件 ID 与 seq 一致
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
});
