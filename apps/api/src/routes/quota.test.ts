import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Task } from 'contracts';
import { estimateTaskBudgetCny } from 'contracts';
import { makeApp, waitForTerminal } from '../testing';

/**
 * P5 额度与限额：每用户并发上限 / 每分钟创建频率 / 单任务预算上限。
 * 配额只约束登录用户；匿名只能 demo（无成本）且 live 已被 401 拦截。
 */

async function register(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password: 'password123' },
  });
  assert.equal(res.statusCode, 201);
  const raw = res.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
  const match = /wb_session=[^;]+/.exec(joined);
  assert.ok(match);
  return match[0];
}

test('预算估算公式：flash 0.48 元 / pro 4.8 元（20 步），未知模型 null', () => {
  assert.equal(estimateTaskBudgetCny('deepseek-flash', 20), 0.48);
  assert.equal(estimateTaskBudgetCny('deepseek-v4-pro', 20), 4.8);
  assert.equal(estimateTaskBudgetCny('no-such-model', 20), null);
});

test('并发上限：登录用户第 2 个进行中任务被拒（429），完成后可再创建；匿名不受限', async (t) => {
  const { app, cleanup } = await makeApp({
    demoStepDelayMs: 300, // 拉长执行窗口，制造并发重叠
    config: { maxUserConcurrentTasks: 1 },
  });
  t.after(cleanup);

  const cookie = await register(app, 'quota_conc');
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+1 的结果' },
    headers: { cookie },
  });
  assert.equal(first.statusCode, 201);
  const firstId = (first.json() as Task).id;

  const second = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 2+2 的结果' },
    headers: { cookie },
  });
  assert.equal(second.statusCode, 429);
  assert.equal((second.json() as { error: { code: string } }).error.code, 'user_concurrency_limit');

  // 完成后释放并发额度
  await waitForTerminal(app, firstId, 600, { headers: { cookie } });
  const third = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 3+3 的结果' },
    headers: { cookie },
  });
  assert.equal(third.statusCode, 201);

  // 匿名用户不受并发限制
  for (let i = 0; i < 2; i++) {
    const anon = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { prompt: `匿名并发 ${i}` },
    });
    assert.equal(anon.statusCode, 201);
  }
});

test('频率上限：登录用户 60s 内第 3 个创建被拒（429 rate_limited）；匿名不受限', async (t) => {
  const { app, cleanup } = await makeApp({ config: { userCreateRatePerMinute: 2 } });
  t.after(cleanup);

  const cookie = await register(app, 'quota_rate');
  for (let i = 0; i < 2; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { prompt: `频率任务 ${i}` },
      headers: { cookie },
    });
    assert.equal(res.statusCode, 201);
  }
  const third = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '频率任务 3' },
    headers: { cookie },
  });
  assert.equal(third.statusCode, 429);
  assert.equal((third.json() as { error: { code: string } }).error.code, 'rate_limited');

  // 匿名不受频率限制
  for (let i = 0; i < 3; i++) {
    const anon = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { prompt: `匿名频率 ${i}` },
    });
    assert.equal(anon.statusCode, 201);
  }
});

test('单任务预算上限：预估超限的 live 任务 400 拒绝（同步拒绝，不启动执行）', async (t) => {
  const { app, cleanup } = await makeApp({
    config: {
      maxTaskBudgetCny: 0.1, // flash 预估 0.48 元 > 0.1 → 拒绝
      // 配置 live 使配额检查在 503 之前可被触达；任务被同步拒绝，不会发起真实模型调用
      modelProvider: 'deepseek',
      modelApiKey: 'test-key-not-used',
      modelBaseUrl: 'http://127.0.0.1:1',
      modelName: 'deepseek-flash',
    },
  });
  t.after(cleanup);

  const cookie = await register(app, 'quota_budget');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+1 的结果', mode: 'live' },
    headers: { cookie },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'task_budget_exceeded');
  assert.ok(body.error.message.includes('0.48'), '错误信息应包含预估费用');

  // demo 任务不参与预算校验（无供应商成本）
  const demo = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+1 的结果' },
    headers: { cookie },
  });
  assert.equal(demo.statusCode, 201);
});
