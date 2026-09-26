import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Task, TaskEvent } from 'contracts';
import { PROMPT_MAX_LENGTH } from 'contracts';
import { queryAll } from './db';
import { makeApp, waitForTerminal } from './testing';

/** 从 Set-Cookie 响应头提取会话 Cookie（与 auth.test.ts 相同约定） */
function extractSessionCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
  const match = /wb_session=[^;]+/.exec(joined);
  assert.ok(match, `应设置会话 Cookie，实际：${joined}`);
  return match[0];
}

test('健康检查返回预期结构，迁移在新数据库上成功执行', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);

  const tables = queryAll<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks', 'task_events')",
  );
  assert.equal(tables.length, 2, '应有 tasks 与 task_events 两张表');

  const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'ok');
  assert.ok(typeof body.version === 'string');
  assert.ok(Number.isInteger(body.uptimeSec));
});

test('端到端：创建表达式任务 → 异步执行 → 完整事件回放', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const createRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 (2+3)*4 的值' },
  });
  assert.equal(createRes.statusCode, 201);
  const created = createRes.json() as Task;
  assert.equal(created.status, 'queued');
  assert.equal(created.mode, 'demo');
  assert.ok(created.id);

  const final = await waitForTerminal(app, created.id);
  assert.equal(final.status, 'completed');
  assert.ok(final.startedAt && final.finishedAt);

  const eventsRes = await app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${created.id}/events`,
  });
  const { events } = eventsRes.json() as { events: TaskEvent[] };
  assert.deepEqual(
    events.map((e) => e.type),
    ['task.created', 'task.started', 'model.output', 'tool.started', 'tool.completed', 'model.output', 'task.completed'],
  );
  // seq 从 1 连续递增
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  // 工具调用真实发生
  const tool = events.find((e) => e.type === 'tool.completed')!;
  assert.equal((tool.payload as { name: string }).name, 'calculate');
  assert.equal((tool.payload as { output: number }).output, 20);

  // afterSeq 增量拉取（P2 SSE 续接的契约基础）
  const incRes = await app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${created.id}/events?afterSeq=5`,
  });
  const { events: inc } = incRes.json() as { events: TaskEvent[] };
  assert.deepEqual(inc.map((e) => e.seq), [6, 7]);
});

test('demo 确定性：相同 prompt 产生相同的事件序列（忽略时间戳与耗时）', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const runOnce = async (): Promise<TaskEvent[]> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { prompt: '统计一下这段文本：hello deterministic world' },
    });
    const { id } = res.json() as Task;
    await waitForTerminal(app, id);
    const eventsRes = await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}/events` });
    return (eventsRes.json() as { events: TaskEvent[] }).events;
  };

  // 剥离 durationMs：工具执行耗时是环境相关的毫秒数，不属于确定性契约
  const normalize = (e: TaskEvent) => {
    const payload = { ...(e.payload as Record<string, unknown>) };
    delete payload.durationMs;
    return [e.seq, e.type, payload];
  };

  const [a, b] = await Promise.all([runOnce(), runOnce()]);
  assert.deepEqual(a.map(normalize), b.map(normalize));
});

test('任务列表：按创建时间倒序分页', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  for (let i = 0; i < 3; i++) {
    await app.inject({ method: 'POST', url: '/api/v1/tasks', payload: { prompt: `任务 ${i}` } });
    await new Promise((r) => setTimeout(r, 15)); // 错开创建时间
  }

  const pageRes = await app.inject({ method: 'GET', url: '/api/v1/tasks?limit=2' });
  assert.equal(pageRes.statusCode, 200);
  const page = pageRes.json();
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.equal(page.limit, 2);
  assert.deepEqual(
    page.items.map((task: Task) => task.prompt),
    ['任务 2', '任务 1'],
  );

  const restRes = await app.inject({ method: 'GET', url: '/api/v1/tasks?limit=2&offset=2' });
  const rest = restRes.json();
  assert.deepEqual(rest.items.map((task: Task) => task.prompt), ['任务 0']);
});

test('输入校验：空 / 超长 prompt 与非法 mode 返回 400', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const bad = async (payload: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: payload as Record<string, unknown>,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'bad_request');
    assert.ok(res.json().error.requestId.length > 0);
  };
  await bad({ prompt: '' });
  await bad({ prompt: '   ' });
  await bad({});
  await bad({ prompt: 'x'.repeat(PROMPT_MAX_LENGTH + 1) });
  await bad({ prompt: 'ok', mode: 'invalid' });
});

test('live 未配置真实模型：匿名创建 401，登录后创建 503 与明确提示（而非假成功）', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  // P5 归属规则：live 消耗平台额度，匿名一律 401（先于 503 能力检查）
  const anon = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: 'x', mode: 'live' },
  });
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.json().error.code, 'unauthorized');

  // 登录用户在 live 未配置时得到 503 明确提示
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username: 'live_user', password: 'password123' },
  });
  const cookie = extractSessionCookie(reg.headers);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: 'x', mode: 'live' },
    headers: { cookie },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'live_model_not_configured');
  assert.ok(res.json().error.message.includes('MODEL_API_KEY'));
});

test('不存在的任务：详情与事件均返回 404', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const missing = randomUUID();
  for (const url of [`/api/v1/tasks/${missing}`, `/api/v1/tasks/${missing}/events`]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'not_found');
    assert.ok(res.json().error.requestId.length > 0);
  }
});

test('列表参数越界返回 400', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  for (const url of ['/api/v1/tasks?limit=0', '/api/v1/tasks?limit=101', '/api/v1/tasks?offset=-1', '/api/v1/tasks?limit=abc']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().error.code, 'bad_request', url);
  }
});

test('未知 API 路径返回 404 并带 requestId', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'not_found');
  assert.ok(res.json().error.requestId.length > 0);
});

test('无效 JSON 请求体返回 400', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: { 'content-type': 'application/json' },
    payload: '{oops',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'bad_request');
});

test('cancel / retry 不存在的任务返回 404', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const missing = randomUUID();
  for (const url of [`/api/v1/tasks/${missing}/cancel`, `/api/v1/tasks/${missing}/retry`]) {
    const res = await app.inject({ method: 'POST', url });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'not_found');
  }
});
