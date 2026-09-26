import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { MeResponse, Task, UserInfo } from 'contracts';
import { createTask, transitionTask } from '../services/taskService';
import { makeApp, waitForTerminal } from '../testing';

/**
 * P5 账号与归属：注册/登录/登出/me + 任务归属校验（列表/详情/事件/流/取消/重试）+ 匿名 live 401。
 * 归属语义：不存在与无权访问一律 404（不泄露他人任务存在性）。
 */

/** 从 Set-Cookie 响应头提取会话 Cookie（wb_session=...），供后续请求携带 */
function extractSessionCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
  const match = /wb_session=[^;]+/.exec(joined);
  assert.ok(match, `应设置会话 Cookie，实际：${joined}`);
  return match[0];
}

/** 注册并返回 { cookie, user }；用户名缺省按序号生成避免用例间冲突 */
async function registerUser(
  app: FastifyInstance,
  username = `user_${Math.random().toString(36).slice(2, 8)}`,
  password = 'password123',
): Promise<{ cookie: string; user: UserInfo }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 201, `注册 ${username} 应成功：${res.body}`);
  return {
    cookie: extractSessionCookie(res.headers),
    user: (res.json() as { user: UserInfo }).user,
  };
}

async function createTaskViaApi(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  cookie?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload,
    ...(cookie ? { headers: { cookie } } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

test('注册 → 201 + HttpOnly 会话 Cookie；me 返回当前用户', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username: 'alice', password: 'password123' },
  });
  assert.equal(res.statusCode, 201);
  const { user } = res.json() as { user: UserInfo };
  assert.equal(user.username, 'alice');
  assert.ok(user.id);

  const cookieHeader = String(res.headers['set-cookie']);
  assert.match(cookieHeader, /HttpOnly/i, '会话 Cookie 必须 HttpOnly');
  assert.doesNotMatch(cookieHeader, /wb_session=;/, 'Cookie 值非空');

  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie: extractSessionCookie(res.headers) },
  });
  assert.equal(me.statusCode, 200);
  const { user: meUser } = me.json() as MeResponse;
  assert.equal(meUser?.id, user.id);
});

test('匿名访问 me 返回 { user: null }（200，非错误）', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
  assert.equal(me.statusCode, 200);
  assert.equal((me.json() as MeResponse).user, null);
});

test('注册校验：重复用户名 409、非法用户名 400、密码过短 400、非字符串字段 400', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username: 'bob', password: 'password123' },
  });
  const dup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username: 'bob', password: 'password456' },
  });
  assert.equal(dup.statusCode, 409);
  assert.equal((dup.json() as { error: { code: string } }).error.code, 'username_taken');

  for (const bad of [
    { username: 'ab', password: 'password123' }, // 用户名过短
    { username: '有中文!', password: 'password123' }, // 非法字符
    { username: 'carol', password: 'short' }, // 密码过短
    { username: 'carol', password: 123 }, // 类型错误
  ]) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: bad });
    assert.equal(res.statusCode, 400, `非法输入应 400：${JSON.stringify(bad)}`);
  }
});

test('登录：成功 200 + 新会话；密码错误与不存在用户均 401；登录后旧会话仍有效', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const reg = await registerUser(app, 'dave', 'password123');

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'dave', password: 'password123' },
  });
  assert.equal(login.statusCode, 200);
  const cookie = extractSessionCookie(login.headers);
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  assert.equal((me.json() as MeResponse).user?.username, 'dave');

  // 注册时的会话仍然有效（多会话并存）
  const meOld = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: reg.cookie } });
  assert.equal((meOld.json() as MeResponse).user?.id, reg.user.id);

  for (const bad of [
    { username: 'dave', password: 'wrong-password' },
    { username: 'ghost', password: 'password123' },
  ]) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: bad });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'unauthorized');
  }
});

test('登出：204 + 清除 Cookie；会话失效；重复登出幂等', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const { cookie } = await registerUser(app, 'erin');
  const logout = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { cookie },
  });
  assert.equal(logout.statusCode, 204);

  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  assert.equal((me.json() as MeResponse).user, null);

  const again = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
  assert.equal(again.statusCode, 204);
});

test('任务归属：登录用户只见自己的任务；他人任务所有读接口 404', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const alice = await registerUser(app, 'alice_t');
  const bob = await registerUser(app, 'bob_t');

  const created = await createTaskViaApi(app, { prompt: '计算 1+1 的结果' }, alice.cookie);
  assert.equal(created.status, 201);
  const aliceTaskId = created.body.id as string;
  await waitForTerminal(app, aliceTaskId, 200, { headers: { cookie: alice.cookie } });

  // Alice 的列表可见且归属正确
  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/tasks',
    headers: { cookie: alice.cookie },
  });
  const listBody = list.json() as { items: Task[]; total: number };
  assert.equal(listBody.total, 1);
  assert.equal(listBody.items[0]!.userId, alice.user.id);
  assert.equal(listBody.items[0]!.status, 'completed');

  // Bob：列表为空；详情 / 事件 / 流 / 取消 / 重试一律 404（不泄露存在性）
  const bobId = bob.user.id;
  assert.notEqual(bobId, alice.user.id);
  for (const req of [
    { method: 'GET', url: `/api/v1/tasks/${aliceTaskId}` },
    { method: 'GET', url: `/api/v1/tasks/${aliceTaskId}/events` },
    { method: 'GET', url: `/api/v1/tasks/${aliceTaskId}/stream` },
    { method: 'POST', url: `/api/v1/tasks/${aliceTaskId}/cancel` },
    { method: 'POST', url: `/api/v1/tasks/${aliceTaskId}/retry` },
  ] as const) {
    const res = await app.inject({ ...req, headers: { cookie: bob.cookie } });
    assert.equal(res.statusCode, 404, `${req.method} ${req.url} 应 404`);
  }
  const bobList = await app.inject({
    method: 'GET',
    url: '/api/v1/tasks',
    headers: { cookie: bob.cookie },
  });
  assert.equal((bobList.json() as { total: number }).total, 0);

  // Alice 自己一切正常（详情可达）
  const own = await app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${aliceTaskId}`,
    headers: { cookie: alice.cookie },
  });
  assert.equal(own.statusCode, 200);
});

test('匿名任务：匿名可见可操作；登录用户不可见（404 / 列表不含）', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const created = await createTaskViaApi(app, { prompt: '计算 2+2 的结果' });
  assert.equal(created.status, 201);
  const taskId = created.body.id as string;
  assert.equal(created.body.userId, null);
  await waitForTerminal(app, taskId);

  // 匿名：详情 / 事件 / 列表正常
  const detail = await app.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}` });
  assert.equal(detail.statusCode, 200);
  const events = await app.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}/events` });
  assert.equal(events.statusCode, 200);
  const list = await app.inject({ method: 'GET', url: '/api/v1/tasks' });
  const listBody = list.json() as { items: Task[]; total: number };
  assert.equal(listBody.total, 1);
  assert.equal(listBody.items[0]!.userId, null);

  // 登录用户：不可见
  const alice = await registerUser(app, 'alice_anon');
  const hidden = await app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${taskId}`,
    headers: { cookie: alice.cookie },
  });
  assert.equal(hidden.statusCode, 404);
  const aliceList = await app.inject({
    method: 'GET',
    url: '/api/v1/tasks',
    headers: { cookie: alice.cookie },
  });
  assert.equal((aliceList.json() as { total: number }).total, 0);
});

test('匿名创建 live 任务 → 401；登录后创建 live（未配置模型）→ 503', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const anon = await createTaskViaApi(app, { prompt: '计算 3+3 的结果', mode: 'live' });
  assert.equal(anon.status, 401);
  assert.equal((anon.body.error as { code: string }).code, 'unauthorized');

  const { cookie } = await registerUser(app, 'frank');
  const authed = await createTaskViaApi(app, { prompt: '计算 3+3 的结果', mode: 'live' }, cookie);
  assert.equal(authed.status, 503, '登录但未配置模型密钥 → 503');
});

test('重试归属：A 重试自己的已取消任务 → 新任务仍归属 A；B 无权重试（404）', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);

  const alice = await registerUser(app, 'alice_retry');
  const bob = await registerUser(app, 'bob_retry');

  // 服务层直接构造 Alice 的已取消任务（无异步执行，避免竞态）
  const original = createTask(db, { prompt: '计算 4+4 的结果', userId: alice.user.id });
  transitionTask(db, original.id, { to: 'canceled' });

  const retryBob = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${original.id}/retry`,
    headers: { cookie: bob.cookie },
  });
  assert.equal(retryBob.statusCode, 404);

  const retry = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${original.id}/retry`,
    headers: { cookie: alice.cookie },
  });
  assert.equal(retry.statusCode, 201);
  const retried = retry.json() as Task;
  assert.equal(retried.userId, alice.user.id);
  assert.equal(retried.parentTaskId, original.id);
  const final = await waitForTerminal(app, retried.id, 200, { headers: { cookie: alice.cookie } });
  assert.equal(final.status, 'completed');
});
