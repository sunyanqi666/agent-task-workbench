-- 005 任务归属用户（P5 账号与归属）
-- user_id 为空 = 匿名任务（历史任务与未登录 demo 任务）；
-- 归属规则：登录用户只见/操作自己的任务，匿名只操作 user_id IS NULL 的任务。
ALTER TABLE tasks ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
