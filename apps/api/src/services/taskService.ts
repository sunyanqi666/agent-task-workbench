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
import { settleTask } from './ledgerService';

/**
 * 任务服务：唯一有权读写 tasks / task_events 的模块。
 * 核心不变量：任务状态更新与对应事件追加在同一事务中完成（见 transitionTask）。
 * 路由层与运行器都只能通过本模块操作数据，保证状态机不被绕过。
 */

interface TaskRow {
  id: string;
  user_id: string | null;
  prompt: string;
  status: TaskStatus;
  mode: ModelMode;
  model_id: string;
  price_version: string | null;
  reserved_cny: number;
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
    userId: row.user_id,
    prompt: row.prompt,
    status: row.status,
    mode: row.mode,
    modelId: row.model_id,
    priceVersion: row.price_version,
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
  const { task, settled, event } = transaction(db, () => {
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

    return {
      task: rowToTask(queryOne<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', taskId)!),
      settled: queryOne<{ mode: string; user_id: string | null; price_version: string | null; reserved_cny: number }>(
        db,
        'SELECT mode, user_id, price_version, reserved_cny FROM tasks WHERE id = ?',
        taskId,
      )!,
      event,
    };
  });
  publishTaskEvent(event); // 事务提交成功后再广播，订阅者读到的数据必然已持久化

  // 终态结算钩子（P5 账本）：live 任务到达终态即释放预留，biz_key 幂等。
  // 所有终态路径（完成 / 失败 / 取消 / 恢复落终态）都经过 transitionTask，此处是唯一结算入口。
  if (input.to !== 'running' && settled.mode === 'live' && settled.user_id !== null) {
    settleTask(db, {
      taskId,
      userId: settled.user_id,
      modelId: task.modelId,
      priceVersion: settled.price_version,
      reservedCny: settled.reserved_cny,
    });
  }
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

/**
 * 归属校验的读取：任务不存在或不属于该用户一律 404（不向非归属者泄露任务存在性）。
 * userId 为 null 表示匿名访问者——只能命中 user_id IS NULL 的匿名任务。
 */
export function getOwnedTask(db: DatabaseSync, taskId: string, userId: string | null): Task {
  const row =
    userId === null
      ? queryOne<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ? AND user_id IS NULL', taskId)
      : queryOne<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ? AND user_id = ?', taskId, userId);
  if (!row) throw new NotFoundError(`任务不存在：${taskId}`);
  return rowToTask(row);
}

/** 归属校验的存在性检查（SSE 流等只需判断可访问性的场景） */
export function taskOwnedBy(db: DatabaseSync, taskId: string, userId: string | null): boolean {
  const row =
    userId === null
      ? queryOne<{ '1': number }>(
          db,
          'SELECT 1 FROM tasks WHERE id = ? AND user_id IS NULL',
          taskId,
        )
      : queryOne<{ '1': number }>(
          db,
          'SELECT 1 FROM tasks WHERE id = ? AND user_id = ?',
          taskId,
          userId,
        );
  return row !== undefined;
}

export function taskExists(db: DatabaseSync, taskId: string): boolean {
  return queryOne<{ '1': number }>(db, 'SELECT 1 FROM tasks WHERE id = ?', taskId) !== undefined;
}

/** 按创建时间倒序分页；仅返回该归属者（用户或匿名）可见的任务，total 同口径 */
export function listTasks(
  db: DatabaseSync,
  options: { limit: number; offset: number; userId: string | null },
): { items: Task[]; total: number } {
  const where = options.userId === null ? 'user_id IS NULL' : 'user_id = ?';
  const ownerParam = options.userId === null ? [] : [options.userId];
  const rows = queryAll<TaskRow>(
    db,
    `SELECT * FROM tasks WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ...ownerParam,
    options.limit,
    options.offset,
  );
  const { total } = queryOne<{ total: number }>(
    db,
    `SELECT COUNT(*) AS total FROM tasks WHERE ${where}`,
    ...ownerParam,
  )!;
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

/** 创建任务：插入 queued 任务 + task.created 事件，同一事务；parentTaskId 用于重试关联，userId 为任务归属（null = 匿名），priceVersion 供 live 任务固化记账口径 */
export function createTask(
  db: DatabaseSync,
  input: CreateTaskInput & { parentTaskId?: string; userId?: string | null; priceVersion?: string | null },
): Task {
  const prompt = input.prompt.trim();
  const mode: ModelMode = input.mode ?? 'demo';
  const userId = input.userId ?? null;
  const priceVersion = mode === 'live' ? (input.priceVersion ?? null) : null;
  const now = new Date().toISOString();
  const id = randomUUID();

  const event = transaction(db, () => {
    db.prepare(
      'INSERT INTO tasks (id, user_id, prompt, status, mode, model_id, price_version, parent_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, userId, prompt, 'queued', mode, input.modelId ?? DEFAULT_MODEL_ID, priceVersion, input.parentTaskId ?? null, now, now);
    return insertEvent(db, id, 'task.created', { prompt });
  });
  publishTaskEvent(event);

  return getTask(db, id);
}

/**
 * 补偿删除：仅限仍为 queued 的任务（预留失败等同步补偿路径；无 await 间隔，不存在并发窗口）。
 * 返回是否删除。终态 / 进行中任务一律拒绝删除 —— 历史不可改写。
 */
export function deleteQueuedTask(db: DatabaseSync, taskId: string): boolean {
  return transaction(db, () => {
    const row = queryOne<{ status: TaskStatus }>(
      db,
      'SELECT status FROM tasks WHERE id = ?',
      taskId,
    );
    if (!row || row.status !== 'queued') return false;
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    return true;
  });
}

/** 该用户进行中 live 任务的预留合计（元）—— 余额展示用 */
export function sumReservedCny(db: DatabaseSync, userId: string): number {
  const { reserved } = queryOne<{ reserved: number }>(
    db,
    "SELECT COALESCE(SUM(reserved_cny), 0) AS reserved FROM tasks WHERE user_id = ? AND mode = 'live' AND status IN ('queued', 'running')",
    userId,
  )!;
  return Math.round(reserved * 1e6) / 1e6;
}

/** 固化单任务预留金额（元）；与账本 reserve 条目同 tick 写入（无 await 间隔） */
export function setReservedCny(db: DatabaseSync, taskId: string, amountCny: number): void {
  db.prepare('UPDATE tasks SET reserved_cny = ? WHERE id = ?').run(amountCny, taskId);
}

/** 累加供应商返回的用量（单条 UPDATE 原子；不产生事件 —— 用量是任务行事实，不是过程事件） */
export function recordModelUsage(db: DatabaseSync, taskId: string, usage: TaskUsage): void {
  db.prepare(
    'UPDATE tasks SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, updated_at = ? WHERE id = ?',
  ).run(usage.promptTokens, usage.completionTokens, new Date().toISOString(), taskId);
}
