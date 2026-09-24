import type {
  ApiError,
  CreateTaskInput,
  HealthInfo,
  Task,
  TaskEvent,
  TaskListResponse,
} from 'contracts';

/** API 客户端错误：保留服务端的 code / message 语义 */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let code = 'network_error';
    let message = `请求失败（${res.status}）`;
    try {
      const body = (await res.json()) as ApiError;
      code = body.error.code;
      message = body.error.message;
    } catch {
      // 非 JSON 错误体：保留默认文案
    }
    throw new ApiClientError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export async function fetchHealth(): Promise<HealthInfo> {
  return request<HealthInfo>('/api/v1/health');
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  return request<Task>('/api/v1/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function fetchTasks(limit = 20, offset = 0): Promise<TaskListResponse> {
  return request<TaskListResponse>(`/api/v1/tasks?limit=${limit}&offset=${offset}`);
}

export async function fetchTask(id: string): Promise<Task> {
  return request<Task>(`/api/v1/tasks/${id}`);
}

export async function fetchTaskEvents(id: string, afterSeq = 0): Promise<TaskEvent[]> {
  const { events } = await request<{ events: TaskEvent[] }>(
    `/api/v1/tasks/${id}/events?afterSeq=${afterSeq}`,
  );
  return events;
}

/**
 * 订阅任务 SSE 实时流：服务端先回放 afterSeq 之后的持久化事件，再推送新事件直至终态后关闭。
 * onEvent 收到的数据按 seq 幂等合并即可（EventSource 自动重连可能重复投递）。
 * 返回关闭函数。
 */
export function streamTaskEvents(
  id: string,
  afterSeq: number,
  onEvent: (event: TaskEvent) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/v1/tasks/${id}/stream?afterSeq=${afterSeq}`);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as TaskEvent);
    } catch {
      // 忽略无法解析的帧（如心跳注释不会进入 onmessage）
    }
  };
  source.onerror = () => {
    // 浏览器内建自动重连；连接终态任务时服务端正常关闭会触发一次 error，随后关闭
    onError?.();
  };
  return () => source.close();
}
