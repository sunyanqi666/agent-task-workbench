import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Task, TaskEvent } from 'contracts';
import { loadConfig, type AppConfig } from './config';
import { openDatabase } from './db';
import { buildServer } from './app';

/** 测试用应用组装：独立全新数据库 + 关闭日志 + demo 立即执行（delay=0） */
export async function makeApp(
  options: { demoStepDelayMs?: number; config?: Partial<AppConfig> } = {},
): Promise<{
  app: FastifyInstance;
  db: DatabaseSync;
  config: AppConfig;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-test-'));
  const config: AppConfig = loadConfig({
    databaseUrl: path.join(dir, `${randomUUID()}.db`),
    logger: false,
    demoStepDelayMs: options.demoStepDelayMs ?? 0,
    // 测试隔离：显式固定模型配置，避免开发者本地 .env 泄入测试（CI 无 .env，两端结果保持一致）；
    // 需要 live 配置的测试经 options.config 显式声明
    modelProvider: '',
    modelApiKey: undefined,
    modelBaseUrl: 'https://api.deepseek.com',
    modelName: 'deepseek-flash',
    ...options.config,
  });
  const db = openDatabase(config.databaseUrl);
  const app = await buildServer(db, config);
  return {
    app,
    db,
    config,
    cleanup: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 轮询任务直至终态；headers 用于携带认证 Cookie（P5 归属后匿名读不到他人任务） */
export async function waitForTerminal(
  app: FastifyInstance,
  id: string,
  tries = 200,
  init?: { headers?: Record<string, string> },
): Promise<Task> {
  for (let i = 0; i < tries; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}`, ...init });
    if (res.statusCode === 404) throw new Error(`任务 ${id} 不存在或无权访问（404）`);
    const task = res.json() as Task;
    if (['completed', 'failed', 'canceled'].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`任务 ${id} 未在预期时间内到达终态`);
}

/** 解析 SSE 文本中的 data 事件（`: ping` 注释与 id: 行被忽略） */
export function parseSseEvents(body: string): TaskEvent[] {
  return [...body.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!) as TaskEvent);
}
