import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CreateTaskInput,
  ModelMode,
  Task,
  TaskErrorCode,
  TaskEvent,
  TaskEventType,
  TaskEventPayloads,
  TaskStatus,
  TaskUsage,
} from 'contracts';
import { DEFAULT_MODEL_ID, TASK_STATUS_TRANSITIONS } from 'contracts';
import { queryAll, queryOne } from '../db';
import { ConflictError, NotFoundError } from './errors';
import { publishTaskEvent } from './eventBus';

/**
 * 任务服务：唯一有权读写 tasks / task_events 的模块。
 * 核心不变量：任务状态更新与对应事件追加在同一事务中完成（见 transitionTask）。
 * 路由层与运行器都只能通过本模块操作数据，保证状态机不被绕过。
 */

interface TaskRow {
  id: string;
  prompt: string;
  status: TaskStatus;
  mode: ModelMode;
  model_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  parent_task_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: TaskErrorCode | null;
}

interface EventRow {
  id: string;
  task_id: string;
  seq: number;
  type: TaskEventType;
  payload: string;
  created_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    mode: row.mode,
    modelId: row.model_id,
    usage: { promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens },
    parentTaskId: row.parent_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
  };
}

function rowToEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

/** 在当前事务内追加事件：seq = 任务内 max(seq) + 1（SQLite 写锁保证原子）；返回构造好的事件对象 */
function insertEvent(
  db: DatabaseSync,
  taskId: string,
  type: TaskEventType,
  payload: TaskEventPayloads[TaskEventType],
): TaskEvent {
  const { next } = queryOne<{ next: number }>(
    db,
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM task_events WHERE task_id = ?',
    taskId,
  )!;
  const event: TaskEvent = {
    id: randomUUID(),
    taskId,
    seq: next,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    'INSERT INTO task_events (id, task_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(event.id, taskId, event.seq, event.type, JSON.stringify(event.payload), event.createdAt);
  return event;
}

/** 包裹事务：异常时回滚并原样抛出 */
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ===== 状态迁移 =====

/** 判别联合：目标状态决定事件类型与载荷（task.started / task.completed / task.failed / task.canceled） */
export type TransitionInput =
  | { to: 'running' }
  | { to: 'completed'; summary: string }
  | { to: 'failed'; errorCode: TaskErrorCode; message: string }
  | { to: 'canceled' };

/**
 * 状态迁移：校验状态机 → 更新任务 → 追加对应事件，三步在同一事务。
 * 非法迁移抛 ConflictError(409) 且不产生任何写入（事务回滚）。
 */
export function transitionTask(db: DatabaseSync, taskId: string, input: TransitionInput): Task {
  const { task, event } = transaction(db, () => {
    const row = queryOne<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', taskId);
    if (!row) throw new NotFoundError(`任务不存在：${taskId}`);

    const from = row.status;
    const to = input.to;
    if (!TASK_STATUS_TRANSITIONS[from].includes(to)) {
      throw new ConflictError(`非法状态迁移：${from} → ${to}`);
    }

    const now = new Date().toISOString();
    let event: TaskEvent;
    if (to === 'running') {
      db.prepare(
        "UPDATE tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
      ).run(now, now, taskId);
      event = insertEvent(db, taskId, 'task.started', {});
    } else if (to === 'completed') {
      db.prepare(
        "UPDATE tasks SET status = 'completed', finished_at = ?, updated_at = ?, error_code = NULL WHERE id = ?",
      ).run(now, now, taskId);
      event = insertEvent(db, taskId, 'task.completed', { summary: input.summary });
    } else if (to === 'failed') {
      db.prepare(
        'UPDATE tasks SET status = ?, finished_at = ?, updated_at = ?, error_code = ? WHERE id = ?',
      ).run(to, now, now, input.errorCode, taskId);
      event = insertEvent(db, taskId, 'task.failed', {
        errorCode: input.errorCode,
        message: input.message,
      });
    } else {
      db.prepare(
        "UPDATE tasks SET status = 'canceled', finished_at = ?, updated_at = ?, error_code = 'canceled' WHERE id = ?",
      ).run(now, now, taskId);
      event = insertEvent(db, taskId, 'task.canceled', {});
    }

    return { task: rowToTask(queryOne<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', taskId)!), event };
  });
  publishTaskEvent(event); // 事务提交成功后再广播，订阅者读到的数据必然已持久化
  return task;
}

/** 运行中过程事件（model.output / tool.*）：不改变状态，独立事务追加 */
export function appendEvent<P extends TaskEventType>(
  db: DatabaseSync,
  taskId: string,
  type: P,
  payload: TaskEventPayloads[P],
): void {
  const event = transaction(db, () => insertEvent(db, taskId, type, payload));
  publishTaskEvent(event);
}

// ===== 查询 =====

export function getTask(db: DatabaseSync, taskId: string): Task {
  const row = queryOne<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', taskId);
  if (!row) throw new NotFoundError(`任务不存在：${taskId}`);
  return rowToTask(row);
}

export function taskExists(db: DatabaseSync, taskId: string): boolean {
  return queryOne<{ '1': number }>(db, 'SELECT 1 FROM tasks WHERE id = ?', taskId) !== undefined;
}

/** 按创建时间倒序分页；total 为任务总数 */
export function listTasks(
  db: DatabaseSync,
  options: { limit: number; offset: number },
): { items: Task[]; total: number } {
  const rows = queryAll<TaskRow>(
    db,
    'SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    options.limit,
    options.offset,
  );
  const { total } = queryOne<{ total: number }>(db, 'SELECT COUNT(*) AS total FROM tasks')!;
  return { items: rows.map(rowToTask), total };
}

/** 事件按 seq 升序；afterSeq 用于增量拉取（回放与 SSE 续接共用） */
export function getEvents(db: DatabaseSync, taskId: string, afterSeq: number): TaskEvent[] {
  const rows = queryAll<EventRow>(
    db,
    'SELECT * FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC',
    taskId,
    afterSeq,
  );
  return rows.map(rowToEvent);
}

/** 列出未到达终态的任务（queued / running），按创建时间升序 —— 启动恢复识别孤儿任务用 */
export function listUnfinishedTasks(
  db: DatabaseSync,
): Array<{ id: string; status: Extract<TaskStatus, 'queued' | 'running'> }> {
  return queryAll<{ id: string; status: 'queued' | 'running' }>(
    db,
    "SELECT id, status FROM tasks WHERE status IN ('queued', 'running') ORDER BY created_at ASC",
  );
}

// ===== 创建 =====

/** 创建任务：插入 queued 任务 + task.created 事件，同一事务；parentTaskId 用于重试关联 */
export function createTask(db: DatabaseSync, input: CreateTaskInput & { parentTaskId?: string }): Task {
  const prompt = input.prompt.trim();
  const mode: ModelMode = input.mode ?? 'demo';
  const now = new Date().toISOString();
  const id = randomUUID();

  const event = transaction(db, () => {
    db.prepare(
      'INSERT INTO tasks (id, prompt, status, mode, model_id, parent_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, prompt, 'queued', mode, input.modelId ?? DEFAULT_MODEL_ID, input.parentTaskId ?? null, now, now);
    return insertEvent(db, id, 'task.created', { prompt });
  });
  publishTaskEvent(event);

  return getTask(db, id);
}

/** 累加供应商返回的用量（单条 UPDATE 原子；不产生事件 —— 用量是任务行事实，不是过程事件） */
export function recordModelUsage(db: DatabaseSync, taskId: string, usage: TaskUsage): void {
  db.prepare(
    'UPDATE tasks SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, updated_at = ? WHERE id = ?',
  ).run(usage.promptTokens, usage.completionTokens, new Date().toISOString(), taskId);
}
