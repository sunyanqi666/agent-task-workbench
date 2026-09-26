import type { FastifyInstance } from 'fastify';
import { AVAILABLE_MODELS, estimateTaskBudgetCny } from 'contracts';

/**
 * 模型目录路由：下发服务端受控模型列表。
 * 前端只能提交目录中的 id（创建任务时由 tasks 路由校验），价格与目录变动不依赖前端写死。
 * estimateMaxCny 按服务端当前 MAX_STEPS 计算 —— 预估口径与服务端预留完全一致，前端不自行估算。
 */
export function registerModelRoutes(app: FastifyInstance, maxSteps: number): void {
  app.get('/api/v1/models', async () => {
    const estimateMaxCny: Record<string, number> = {};
    for (const model of AVAILABLE_MODELS) {
      estimateMaxCny[model.id] = estimateTaskBudgetCny(model.id, maxSteps) ?? 0;
    }
    return { models: AVAILABLE_MODELS, estimateMaxCny };
  });
}
