import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CreateTaskInput, TaskEvent, TaskEventType } from 'contracts';
import { AVAILABLE_MODELS, PROMPT_MAX_LENGTH } from 'contracts';
import { AppError, ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../services/errors';
import {
  createTask,
  getEvents,
  getOwnedTask,
  listTasks,
  taskOwnedBy,
  transitionTask,
} from '../services/taskService';
import { getUserFromRequest } from '../services/authService';
import { subscribeTaskEvents } from '../services/eventBus';
import { getCancelController } from '../runner/cancelRegistry';
import { runTask, type RunnerDeps } from '../runner/runTask';

/**
 * 任务路由：只做输入校验与响应组装；状态与事务归任务服务，模型与工具循环归运行器。
 * 服务层抛出的 AppError 由 app.ts 的统一错误处理器转换为 ApiError 格式。
 * 归属规则（P5）：登录用户只见/操作自己的任务，匿名只操作 user_id IS NULL 的任务；
 * 不存在与无权访问一律 404，不泄露他人任务的存在性。
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
  const { prompt, mode, modelId } = body as Record<string, unknown>;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ValidationError('prompt 不能为空');
  }
  if (prompt.length > PROMPT_MAX_LENGTH) {
    throw new ValidationError(`prompt 长度不能超过 ${PROMPT_MAX_LENGTH} 字符`);
  }
  if (mode !== undefined && mode !== 'demo' && mode !== 'live') {
    throw new ValidationError('mode 只能为 demo 或 live');
  }
  // modelId 受控白名单：前端只能提交目录（GET /api/v1/models）中的 id
  if (modelId !== undefined) {
    if (typeof modelId !== 'string' || !AVAILABLE_MODELS.some((m) => m.id === modelId)) {
      const ids = AVAILABLE_MODELS.map((m) => m.id).join(' / ');
      throw new ValidationError(`modelId 必须是受控模型目录中的 id（可选：${ids}）`);
    }
  }
  return {
    prompt,
    mode: mode === 'live' ? 'live' : 'demo',
    ...(typeof modelId === 'string' ? { modelId } : {}),
  };
}

export function registerTaskRoutes(app: FastifyInstance, deps: RunnerDeps): void {
  // 创建任务：201 返回 queued 快照，执行在后台异步进行（事件与状态随之持久化）
  app.post('/api/v1/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseCreateInput(request.body);
    const user = getUserFromRequest(deps.db, request);
    if (input.mode === 'live' && !user) {
      // live 消耗平台额度，仅登录用户可用；匿名仍可免费使用 demo
      throw new UnauthorizedError('live 任务需要登录后使用平台额度，请先注册或登录');
    }
    if (input.mode === 'live' && !deps.liveModel) {
      // live 依赖真实模型密钥；未配置返回 503 明确提示，不返回假成功
      throw new AppError(
        '真实模型未配置（需设置 MODEL_PROVIDER=deepseek 与 MODEL_API_KEY），暂无法创建 live 任务',
        503,
        'live_model_not_configured',
      );
    }
    const task = createTask(deps.db, { ...input, userId: user?.id ?? null });
    void runTask(deps, task.id); // 异步执行，不阻塞 201 响应
    reply.code(201);
    return task;
  });

  // 任务列表：按创建时间倒序分页；只返回当前归属者可见的任务
  app.get('/api/v1/tasks', async (request: FastifyRequest) => {
    const user = getUserFromRequest(deps.db, request);
    const query = request.query as Record<string, string | undefined>;
    const limit = parseIntParam(query.limit, 20, 1, 100, 'limit');
    const offset = parseIntParam(query.offset, 0, 0, 1_000_000, 'offset');
    const { items, total } = listTasks(deps.db, { limit, offset, userId: user?.id ?? null });
    return { items, total, limit, offset };
  });

  // 任务快照（归属校验：他人任务一律 404）
  app.get('/api/v1/tasks/:id', async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const user = getUserFromRequest(deps.db, request);
    return getOwnedTask(deps.db, id, user?.id ?? null);
  });

  // 持久化事件：afterSeq 增量拉取（回放与 P2 SSE 续接共用）
  app.get('/api/v1/tasks/:id/events', async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const afterSeq = parseIntParam(query.afterSeq, 0, 0, 1_000_000, 'afterSeq');
    const user = getUserFromRequest(deps.db, request);
    if (!taskOwnedBy(deps.db, id, user?.id ?? null)) throw new NotFoundError(`任务不存在：${id}`);
    return { events: getEvents(deps.db, id, afterSeq) };
  });

  // SSE 实时事件流：先回放 afterSeq 之后的持久化事件，再订阅新事件直至终态。
  // 事件 ID 使用 seq；data 为完整 TaskEvent JSON（前端按 seq 幂等合并）。
  app.get('/api/v1/tasks/:id/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const afterSeq = parseIntParam(query.afterSeq, 0, 0, 1_000_000, 'afterSeq');
    const user = getUserFromRequest(deps.db, request);
    if (!taskOwnedBy(deps.db, id, user?.id ?? null)) throw new NotFoundError(`任务不存在：${id}`);

    const TERMINAL_EVENT_TYPES = new Set<TaskEventType>([
      'task.completed',
      'task.failed',
      'task.canceled',
    ]);

    reply.hijack(); // 直接控制底层 socket，Fastify 不再托管该响应
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // 反向代理禁用缓冲
    });

    let lastSeq = afterSeq;
    let closed = false;
    const writeEvent = (event: TaskEvent): void => {
      raw.write(`id: ${event.seq}\n`);
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      raw.end();
    };

    // 先订阅再回放：订阅期间到达的事件进缓冲，回放完成后按 seq 排序补发，避免与回放交错乱序
    let replaying = true;
    const buffered: TaskEvent[] = [];
    const unsubscribe = subscribeTaskEvents(id, (event) => {
      if (replaying) {
        buffered.push(event);
        return;
      }
      if (event.seq <= lastSeq) return;
      writeEvent(event);
      lastSeq = event.seq;
      if (TERMINAL_EVENT_TYPES.has(event.type)) finish();
    });

    const heartbeat = setInterval(() => {
      if (!closed) raw.write(': ping\n\n');
    }, 15_000);

    for (const event of getEvents(deps.db, id, afterSeq)) {
      writeEvent(event);
      lastSeq = event.seq;
    }
    replaying = false;
    buffered.sort((a, b) => a.seq - b.seq);
    for (const event of buffered) {
      if (event.seq > lastSeq) {
        writeEvent(event);
        lastSeq = event.seq;
        if (TERMINAL_EVENT_TYPES.has(event.type)) {
          finish();
          return;
        }
      }
    }

    // afterSeq 已覆盖全部事件（如客户端重连）时按快照判断是否终态
    const snapshot = getOwnedTask(deps.db, id, user?.id ?? null);
    if (['completed', 'failed', 'canceled'].includes(snapshot.status)) {
      finish();
      return;
    }

    request.raw.on('close', finish);
  });

  // 取消任务：queued 直接落终态；running 经注册表发协作式取消信号（202，终态由运行器写入）；
  // 已取消幂等返回 200；completed / failed 返回 409。
  app.post('/api/v1/tasks/:id/cancel', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const user = getUserFromRequest(deps.db, request);
    const task = getOwnedTask(deps.db, id, user?.id ?? null);

    if (task.status === 'canceled') return task; // 幂等：重复取消返回当前快照
    if (task.status === 'completed' || task.status === 'failed') {
      throw new ConflictError(`任务已${task.status === 'completed' ? '完成' : '失败'}，无法取消`);
    }
    if (task.status === 'queued') {
      return transitionTask(deps.db, id, { to: 'canceled' });
    }
    // running：优先通知运行器协作式取消；无控制器（如重启后的孤儿任务）直接落终态
    const controller = getCancelController(id);
    if (controller) {
      controller.abort();
      reply.code(202); // 取消请求已受理，终态由运行器经事件流推送
      return task;
    }
    return transitionTask(deps.db, id, { to: 'canceled' });
  });

  // 重试：仅失败 / 已取消任务可重试；生成新任务（parentTaskId 指向原任务），不改写历史。
  // 重复重试会产生多个新任务，各自独立执行 —— 关联关系明确，不产生混乱记录。
  app.post('/api/v1/tasks/:id/retry', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const user = getUserFromRequest(deps.db, request);
    const task = getOwnedTask(deps.db, id, user?.id ?? null);

    if (task.status !== 'failed' && task.status !== 'canceled') {
      throw new ConflictError(`仅失败或已取消的任务可重试（当前状态：${task.status}）`);
    }
    if (task.mode === 'live' && !deps.liveModel) {
      throw new AppError('真实模型未配置，无法重试 live 任务', 503, 'live_model_not_configured');
    }

    const retry = createTask(deps.db, {
      prompt: task.prompt,
      mode: task.mode,
      modelId: task.modelId, // 重试沿用原任务创建时固化的模型选择
      parentTaskId: task.id,
      userId: task.userId, // 归属随原任务（请求者必为归属者，见上方归属校验）
    });
    void runTask(deps, retry.id);
    reply.code(201);
    return retry;
  });
}
