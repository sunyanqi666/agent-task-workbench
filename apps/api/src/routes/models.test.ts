import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelListResponse, Task } from 'contracts';
import { AVAILABLE_MODELS } from 'contracts';
import { makeApp, waitForTerminal } from '../testing';
import { createTask, transitionTask } from '../services/taskService';

test('模型目录：GET /api/v1/models 返回受控列表（两个 DeepSeek 模型）', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const res = await app.inject({ method: 'GET', url: '/api/v1/models' });
  assert.equal(res.statusCode, 200);
  const { models } = res.json() as ModelListResponse;
  assert.deepEqual(models, [
    {
      id: 'deepseek-flash',
      label: 'DeepSeek Flash（通用 · 快）',
      pricing: { promptCnyPerMillion: 2, completionCnyPerMillion: 8 },
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro（旗舰 · 强推理）',
      pricing: { promptCnyPerMillion: 20, completionCnyPerMillion: 80 },
    },
  ]);
  assert.deepEqual(models, AVAILABLE_MODELS);
});

test('创建任务：合法 modelId 固化到任务；缺省为 deepseek-flash', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '统计这段文本：model selection', mode: 'demo', modelId: 'deepseek-v4-pro' },
  });
  assert.equal(res.statusCode, 201);
  const created = res.json() as Task;
  assert.equal(created.modelId, 'deepseek-v4-pro');
  assert.deepEqual(created.usage, { promptTokens: 0, completionTokens: 0 });

  const final = await waitForTerminal(app, created.id);
  assert.equal(final.modelId, 'deepseek-v4-pro'); // 执行后仍保留创建时选择
  assert.deepEqual(final.usage, { promptTokens: 0, completionTokens: 0 }); // demo 无用量

  // 缺省 modelId
  const defaultRes = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+1' },
  });
  assert.equal((defaultRes.json() as Task).modelId, 'deepseek-flash');
});

test('创建任务：不在目录中的 modelId 返回 400（白名单校验，含已停用旧名）', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  for (const modelId of ['gpt-4o', '', 42, null, 'deepseek-chat', 'deepseek-reasoner']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { prompt: 'x', mode: 'demo', modelId },
    });
    assert.equal(res.statusCode, 400, `modelId=${String(modelId)}`);
    assert.equal(res.json().error.code, 'bad_request');
    assert.ok(res.json().error.message.includes('受控模型目录'));
  }
});

test('重试：新任务沿用原任务创建时固化的模型选择', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);

  const original = createTask(db, { prompt: '计算 2+2', mode: 'demo', modelId: 'deepseek-v4-pro' });
  transitionTask(db, original.id, { to: 'canceled' }); // queued → canceled，允许重试

  const res = await app.inject({ method: 'POST', url: `/api/v1/tasks/${original.id}/retry` });
  assert.equal(res.statusCode, 201);
  const retry = res.json() as Task;
  assert.equal(retry.modelId, 'deepseek-v4-pro');
  assert.equal(retry.parentTaskId, original.id);
});
