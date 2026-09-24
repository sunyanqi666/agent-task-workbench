import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, type AppConfig } from './config';
import { openDatabase, queryAll } from './db';
import { buildServer } from './app';

/** 每个用例使用独立的全新数据库：同时验证迁移可在新数据库上执行 */
async function makeApp(): Promise<{
  app: FastifyInstance;
  db: DatabaseSync;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-test-'));
  const config: AppConfig = loadConfig({
    databaseUrl: path.join(dir, `${randomUUID()}.db`),
    logger: false,
  });
  const db = openDatabase(config.databaseUrl);
  const app = await buildServer(db, config);
  return {
    app,
    db,
    cleanup: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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

test('任务端点为 501 占位，返回统一错误结构', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: 'x' },
  });
  assert.equal(res.statusCode, 501);
  const body = res.json();
  assert.equal(body.error.code, 'not_implemented');
  assert.ok(body.error.requestId.length > 0);
});

test('未知 API 路径返回 404 并带 requestId', async (t) => {
  const { app, cleanup } = await makeApp();
  t.after(cleanup);

  const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.error.code, 'not_found');
  assert.ok(body.error.requestId.length > 0);
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
  const body = res.json();
  assert.equal(body.error.code, 'bad_request');
});
