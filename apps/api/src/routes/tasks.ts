import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError } from 'contracts';

/**
 * 任务端点契约见 docs/api.md；P0 只开放健康检查，
 * 占位端点统一返回 501，不用假成功误导开发。
 */
export function registerTaskRoutes(app: FastifyInstance): void {
  const notImplemented = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ApiError> => {
    reply.code(501);
    return {
      error: {
        code: 'not_implemented',
        message: '契约已定义，将在后续阶段实现',
        requestId: request.id,
      },
    };
  };

  app.post('/api/v1/tasks', notImplemented); // 创建任务，P1
  app.get('/api/v1/tasks', notImplemented); // 按创建时间倒序分页，P1
  app.get('/api/v1/tasks/:id', notImplemented); // 任务快照，P1
  app.get('/api/v1/tasks/:id/events', notImplemented); // 回放事件（afterSeq），P1
  app.get('/api/v1/tasks/:id/stream', notImplemented); // SSE，事件 ID 使用 seq，P2
  app.post('/api/v1/tasks/:id/cancel', notImplemented); // 取消，终态幂等，P3
  app.post('/api/v1/tasks/:id/retry', notImplemented); // 重试生成新任务，P3
}
