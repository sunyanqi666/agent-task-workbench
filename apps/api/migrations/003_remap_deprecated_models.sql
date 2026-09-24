-- 003 模型目录更新：供应商已停用旧名 deepseek-chat / deepseek-reasoner（2026-07-24 下线），
-- 历史任务的 model_id 迁移到现行名称，保证旧任务重试仍能执行：
--   deepseek-chat（非思考）→ deepseek-flash
--   deepseek-reasoner（思考）→ deepseek-v4-pro
UPDATE tasks SET model_id = 'deepseek-flash'  WHERE model_id = 'deepseek-chat';
UPDATE tasks SET model_id = 'deepseek-v4-pro' WHERE model_id = 'deepseek-reasoner';
