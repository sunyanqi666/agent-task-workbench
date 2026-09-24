import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError, CreateTaskInput } from 'contracts';
import { PROMPT_MAX_LENGTH } from 'contracts';
import { NotFoundError, ValidationError } from '../services/errors';
import {
  createTask,
  getEvents,
  getTask,
  listTasks,
  taskExists,
} from '../services/taskService';
import { runTask, type RunnerDeps } from '../runner/runTask';

/**
 * 任务路由：只做输入校验与响应组装；状态与事务归任务服务，模型与工具循环归运行器。
 * 服务层抛出的 AppError 由 app.ts 的统一错误处理器转换为 ApiError 格式。
 */

/** 解析 query 中的整数参数：缺省用默认值，越界或非整数返回 400 */
function parseIntParam(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`查询参数 ${name} 应为 ${min}..${max} 的整数`);
  }
  return value;
}

function parseCreateInput(body: unknown): CreateTaskInput {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('请求体必须是 JSON 对象');
  }
  const { prompt, mode } = body as Record<string, unknown>;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ValidationError('prompt 不能为空');
  }
  if (prompt.length > PROMPT_MAX_LENGTH) {
    throw new ValidationError(`prompt 长度不能超过 ${PROMPT_MAX_LENGTH} 字符`);
  }
  if (mode !== undefined && mode !== 'demo' && mode !== 'live') {
    throw new ValidationError('mode 只能为 demo 或 live');
  }
  return { prompt, mode: mode === 'live' ? 'live' : 'demo' };
}

export function registerTaskRoutes(app: FastifyInstance, deps: RunnerDeps): void {
  // 创建任务：201 返回 queued 快照，执行在后台异步进行（事件与状态随之持久化）
  app.post('/api/v1/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseCreateInput(request.body);
    if (input.mode === 'live') {
      // live 依赖真实模型密钥与适配，在 P3 接入；不返回假成功
      reply.code(501);
      return {
        error: { code: 'not_implemented', message: 'live 模式将在 P3 接入', requestId: request.id },
      } satisfies ApiError;
    }
    const task = createTask(deps.db, input);
    void runTask(deps, task.id); // 异步执行，不阻塞 201 响应
    reply.code(201);
    return task;
  });

  // 任务列表：按创建时间倒序分页
  app.get('/api/v1/tasks', async (request: FastifyRequest) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = parseIntParam(query.limit, 20, 1, 100, 'limit');
    const offset = parseIntParam(query.offset, 0, 0, 1_000_000, 'offset');
    const { items, total } = listTasks(deps.db, { limit, offset });
    return { items, total, limit, offset };
  });

  // 任务快照
  app.get('/api/v1/tasks/:id', async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    if (!taskExists(deps.db, id)) throw new NotFoundError(`任务不存在：${id}`);
    return getTask(deps.db, id);
  });

  // 持久化事件：afterSeq 增量拉取（回放与 P2 SSE 续接共用）
  app.get('/api/v1/tasks/:id/events', async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const afterSeq = parseIntParam(query.afterSeq, 0, 0, 1_000_000, 'afterSeq');
    if (!taskExists(deps.db, id)) throw new NotFoundError(`任务不存在：${id}`);
    return { events: getEvents(deps.db, id, afterSeq) };
  });

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

  app.get('/api/v1/tasks/:id/stream', notImplemented); // SSE 实时事件流，事件 ID 使用 seq，P2
  app.post('/api/v1/tasks/:id/cancel', notImplemented); // 取消，终态幂等，P3
  app.post('/api/v1/tasks/:id/retry', notImplemented); // 重试生成新任务，P3
}
