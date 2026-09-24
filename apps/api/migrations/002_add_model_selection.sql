-- 002 模型选择与用量记录（P4）：创建任务时固化所选模型 id；供应商返回的用量累计在任务行
-- model_id 取值受服务端受控目录（contracts AVAILABLE_MODELS）约束；历史行回填默认 deepseek-chat
ALTER TABLE tasks ADD COLUMN model_id TEXT NOT NULL DEFAULT 'deepseek-chat';
ALTER TABLE tasks ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
