import type { FastifyInstance } from 'fastify';
import { AVAILABLE_MODELS } from 'contracts';

/**
 * 模型目录路由：下发服务端受控模型列表。
 * 前端只能提交目录中的 id（创建任务时由 tasks 路由校验），价格与目录变动不依赖前端写死。
 */
export function registerModelRoutes(app: FastifyInstance): void {
  app.get('/api/v1/models', async () => {
    return { models: AVAILABLE_MODELS };
  });
}
