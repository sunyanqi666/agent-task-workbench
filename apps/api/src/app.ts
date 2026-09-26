import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from './config';
import { registerHealthRoutes } from './routes/health';
import { registerModelRoutes } from './routes/models';
import { registerTaskRoutes } from './routes/tasks';
import { registerAuthRoutes } from './routes/auth';
import { createDefaultToolRegistry } from './tools';
import { DemoModel } from './runner/model';
import { LiveModel } from './runner/liveModel';
import type { RunnerDeps } from './runner/runTask';
import { recoverInterruptedTasks } from './runner/recovery';
import { AppError } from './services/errors';

const pkgRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const webDist = path.resolve(pkgRoot, '../../apps/web/dist');

/**
 * 组装 API 服务：路由只做校验与响应；任务服务管状态与事务，运行器管模型与工具循环。
 * 独立于 listen，便于测试用 inject() 直接调用。
 */
export async function buildServer(
  db: DatabaseSync,
  config: AppConfig,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logger,
    bodyLimit: 1024 * 1024, // 请求体大小上限（安全边界）
    genReqId: () => randomUUID(), // requestId 贯穿日志与错误响应
  });

  // live 模型：仅支持 deepseek（OpenAI 兼容 chat completions）；
  // 未配置（无提供方或无密钥）时为 null —— 创建与重试入口返回 503，绝不下发假成功
  const registry = createDefaultToolRegistry();
  const liveModel =
    config.modelProvider === 'deepseek' && config.modelApiKey
      ? new LiveModel({
          apiKey: config.modelApiKey,
          baseUrl: config.modelBaseUrl,
          modelName: config.modelName,
          registry,
          timeoutMs: config.stepTimeoutMs,
        })
      : null;
  if (config.modelProvider && config.modelProvider !== 'deepseek') {
    app.log.warn(`未支持的 MODEL_PROVIDER=${config.modelProvider}，live 任务不可用`);
  }

  const runner: RunnerDeps = {
    db,
    registry,
    model: new DemoModel(config.demoStepDelayMs),
    liveModel,
    maxSteps: config.maxSteps,
    maxToolCallsPerTurn: config.maxToolCallsPerTurn,
    stepTimeoutMs: config.stepTimeoutMs,
    maxUserConcurrentTasks: config.maxUserConcurrentTasks,
    userCreateRatePerMinute: config.userCreateRatePerMinute,
    maxTaskBudgetCny: config.maxTaskBudgetCny,
  };

  // 启动恢复：处理上次进程中断遗留的 queued / running 任务，保证不永久停留进行中状态
  const recovery = recoverInterruptedTasks(runner);
  if (recovery.resumed.length > 0) {
    app.log.info(`启动恢复：${recovery.resumed.length} 个中断前排队任务已重新执行`);
  }
  if (recovery.interrupted.length > 0) {
    app.log.warn(`启动恢复：${recovery.interrupted.length} 个中断前运行中任务已标记失败（interrupted）`);
  }

  registerHealthRoutes(app, db);
  registerModelRoutes(app);
  registerAuthRoutes(app, db);
  registerTaskRoutes(app, runner);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: '路径不存在', requestId: request.id },
    });
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    // 服务层业务错误：使用自带的状态码与机器可读 code
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
      return;
    }
    const status = error.statusCode ?? 500;
    request.log.warn({ err: error, status }, 'request failed'); // 详情只进日志，不返回客户端
    reply.status(status).send({
      error: {
        code: status >= 500 ? 'internal' : 'bad_request',
        message: error.message,
        requestId: request.id,
      },
    });
  });

  // 演示/生产：若前端已构建（pnpm build），由 API 直接托管。
  // 注意：必须在设置路由与错误处理之后注册（await 的插件边界会让后设的 handler 失效）。
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
  }

  return app;
}
