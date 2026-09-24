import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { HealthInfo } from 'contracts';
import { APP_VERSION } from 'contracts';
import { queryOne } from '../db';

export function registerHealthRoutes(app: FastifyInstance, db: DatabaseSync): void {
  const startedAt = Date.now();

  // 健康检查只暴露服务状态与版本，不含配置或密钥
  app.get('/api/v1/health', async (_request, reply) => {
    try {
      queryOne(db, 'SELECT 1 AS ok'); // 验证数据库连通
    } catch {
      return reply.code(503).send({
        error: { code: 'db_unavailable', message: '数据库不可用', requestId: 'n/a' },
      });
    }
    const body: HealthInfo = {
      status: 'ok',
      db: 'ok',
      version: APP_VERSION,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    };
    return body;
  });
}
