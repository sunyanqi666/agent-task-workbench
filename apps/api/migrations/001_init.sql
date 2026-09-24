-- 001 初始结构：任务与任务事件
-- 状态取值：queued | running | completed | failed | canceled（见 packages/contracts）
-- 不变量：任务状态更新与对应事件追加必须在同一事务中完成（P1 任务服务执行）
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',
  mode           TEXT NOT NULL DEFAULT 'demo',
  parent_task_id TEXT REFERENCES tasks(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  error_code     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

CREATE TABLE IF NOT EXISTS task_events (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, seq);
