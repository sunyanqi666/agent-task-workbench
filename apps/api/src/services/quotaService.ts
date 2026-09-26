import type { DatabaseSync } from 'node:sqlite';
import { estimateTaskBudgetCny } from 'contracts';
import { queryOne } from '../db';
import { AppError, QuotaExceededError } from './errors';

/**
 * 额度与限额服务（P5）：创建 / 重试任务前对登录用户做三重校验。
 * 计数基于 tasks 表（单写者 SQLite，读-写间隔极小；多实例部署需外部分布式计数，与 eventBus 同一边界）。
 * 匿名用户不经过本模块 —— 匿名只能 demo（无成本），live 已在路由层被 401 拦截。
 */

export interface QuotaLimits {
  /** 每用户并发上限（queued + running） */
  maxConcurrent: number;
  /** 每分钟创建数上限（滚动 60s 窗口） */
  ratePerMinute: number;
  /** 单任务预估费用上限（元） */
  maxTaskBudgetCny: number;
}

/**
 * 三重校验，任一超限即抛错（429 并发 / 429 频率 / 400 预算上限）：
 * 1. 并发：该用户 queued + running 任务数已达上限；
 * 2. 频率：该用户最近 60 秒创建的任务数已达上限（含已完成任务 —— 保护的是创建速率本身）；
 * 3. 单任务预算：live 任务预估费用上限（估算公式见 contracts.estimateTaskBudgetCny）超过平台上限。
 * demo 任务无供应商成本，不参与预算校验，但受并发与频率约束。
 */
export function assertCanCreateTask(
  db: DatabaseSync,
  userId: string,
  input: { mode: 'demo' | 'live'; modelId: string; maxSteps: number; limits: QuotaLimits },
): number | null {
  const { active } = queryOne<{ active: number }>(
    db,
    "SELECT COUNT(*) AS active FROM tasks WHERE user_id = ? AND status IN ('queued', 'running')",
    userId,
  )!;
  if (active >= input.limits.maxConcurrent) {
    throw new QuotaExceededError(
      `并发任务数已达上限（${active}/${input.limits.maxConcurrent}），请等待任务完成后再创建`,
      'user_concurrency_limit',
    );
  }

  const since = new Date(Date.now() - 60_000).toISOString();
  const { recent } = queryOne<{ recent: number }>(
    db,
    'SELECT COUNT(*) AS recent FROM tasks WHERE user_id = ? AND created_at > ?',
    userId,
    since,
  )!;
  if (recent >= input.limits.ratePerMinute) {
    throw new QuotaExceededError(
      `创建频率超限（每分钟最多 ${input.limits.ratePerMinute} 个任务），请稍后再试`,
      'rate_limited',
    );
  }

  if (input.mode === 'live') {
    const estimate = estimateTaskBudgetCny(input.modelId, input.maxSteps);
    if (estimate === null) {
      throw new AppError(`模型不在受控目录：${input.modelId}`, 400, 'bad_request');
    }
    if (estimate > input.limits.maxTaskBudgetCny) {
      throw new AppError(
        `预估费用上限 ${estimate.toFixed(2)} 元超过单任务预算上限（${input.limits.maxTaskBudgetCny} 元）`,
        400,
        'task_budget_exceeded',
      );
    }
    return estimate;
  }
  return null;
}
