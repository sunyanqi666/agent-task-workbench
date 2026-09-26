import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerEntryInfo, LedgerKind, TaskUsage } from 'contracts';
import {
  ESTIMATED_INPUT_TOKENS_PER_STEP,
  ESTIMATED_OUTPUT_TOKENS_PER_STEP,
} from 'contracts';
import { AVAILABLE_MODELS, MODEL_PRICE_VERSION } from 'contracts';
import { queryAll, queryOne, withTransaction } from '../db';
import { InsufficientBalanceError, QuotaExceededError } from './errors';

/**
 * 用量账本服务（P5）：唯一有权读写 ledger_entries 的模块。
 * 记账模型（净扣恒等于 Σactual，不重复扣费）：
 *   reserve  −R  创建 live 任务时扣预留（R = 预估费用上限）
 *   actual   −A  每次模型响应按真实用量扣费；用量缺失（解析失败/缺失）按每步估算兜底
 *   settle   +R  任务终态释放全部预留（transitionTask 提交后触发，biz_key 幂等）
 *   topup    +X  充值入账（仅服务端验证后的支付回调）
 *   refund   −X  退款出账
 * 每条记录固化 price_version 与 balance_after 快照；biz_key 唯一约束防重复记账。
 * 价格按 AVAILABLE_MODELS 当前目录取值；目录调价时递增 MODEL_PRICE_VERSION（当前单版本）。
 */

export type { LedgerEntryInfo as LedgerEntry, LedgerKind };

interface LedgerRow {
  id: string;
  user_id: string;
  kind: LedgerKind;
  task_id: string | null;
  amount_cny: number;
  balance_after: number;
  price_version: string | null;
  biz_key: string;
  memo: string | null;
  created_at: string;
}

function rowToEntry(row: LedgerRow): LedgerEntryInfo {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    taskId: row.task_id,
    amountCny: row.amount_cny,
    balanceAfterCny: row.balance_after,
    priceVersion: row.price_version,
    bizKey: row.biz_key,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

function getPricing(modelId: string): { prompt: number; completion: number } {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`模型不在受控目录：${modelId}`);
  return { prompt: model.pricing.promptCnyPerMillion, completion: model.pricing.completionCnyPerMillion };
}

/** 单步成本（元）：真实用量或（用量缺失时的）每步估算上限 */
function stepCostCny(modelId: string, usage: TaskUsage | null): number {
  const { prompt, completion } = getPricing(modelId);
  if (usage) {
    return (usage.promptTokens * prompt + usage.completionTokens * completion) / 1_000_000;
  }
  return (
    (ESTIMATED_INPUT_TOKENS_PER_STEP * prompt + ESTIMATED_OUTPUT_TOKENS_PER_STEP * completion) /
    1_000_000
  );
}

/**
 * 通用记账：在可重入事务内计算余额、插入条目（biz_key 冲突 = 已记账，直接跳过返回 false）。
 * 所有对外语义函数都经过它，保证 balance_after 与金额口径一致；
 * 被任务服务的外层事务（创建+预留 / 终态+释放）调用时直接参与外层事务。
 */
function insertEntry(
  db: DatabaseSync,
  input: {
    userId: string;
    kind: LedgerKind;
    taskId: string | null;
    amountCny: number;
    priceVersion: string | null;
    bizKey: string;
    memo?: string;
  },
): boolean {
  return withTransaction(db, () => {
    const existing = queryOne<{ id: string }>(
      db,
      'SELECT id FROM ledger_entries WHERE biz_key = ?',
      input.bizKey,
    );
    if (existing) return false; // 幂等：业务键已存在，不重复记账
    const { balance } = queryOne<{ balance: number }>(
      db,
      'SELECT COALESCE(SUM(amount_cny), 0) AS balance FROM ledger_entries WHERE user_id = ?',
      input.userId,
    )!;
    const balanceAfter = Math.round((balance + input.amountCny) * 1e6) / 1e6; // 消除浮点累加误差
    db.prepare(
      'INSERT INTO ledger_entries (id, user_id, kind, task_id, amount_cny, balance_after, price_version, biz_key, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      input.userId,
      input.kind,
      input.taskId,
      input.amountCny,
      balanceAfter,
      input.priceVersion,
      input.bizKey,
      input.memo ?? null,
      new Date().toISOString(),
    );
    return true;
  });
}

// ===== 查询 =====

/** 用户当前余额（元）= 全部账本条目代数和 */
export function getBalanceCny(db: DatabaseSync, userId: string): number {
  const { balance } = queryOne<{ balance: number }>(
    db,
    'SELECT COALESCE(SUM(amount_cny), 0) AS balance FROM ledger_entries WHERE user_id = ?',
    userId,
  )!;
  return Math.round(balance * 1e6) / 1e6;
}

export function getEntriesByTask(db: DatabaseSync, taskId: string): LedgerEntryInfo[] {
  return queryAll<LedgerRow>(
    db,
    'SELECT * FROM ledger_entries WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
    taskId,
  ).map(rowToEntry);
}

export function getEntriesByUser(db: DatabaseSync, userId: string): LedgerEntryInfo[] {
  return queryAll<LedgerRow>(
    db,
    'SELECT * FROM ledger_entries WHERE user_id = ? ORDER BY created_at ASC, rowid ASC',
    userId,
  ).map(rowToEntry);
}

// ===== 预留 / 实际 / 结算 =====

/** 结算 / 记账所需任务事实（由任务服务或运行器传入，账本不直接读 tasks） */
export interface TaskSettlementInfo {
  taskId: string;
  userId: string;
  modelId: string;
  priceVersion: string | null;
  /** 预留金额（元）；demo / 历史任务为 0。仅结算与余额展示使用 */
  reservedCny?: number;
}

/**
 * 创建 live 任务时扣预留。余额不足抛 402（路由层在创建任务前已预检，此处为事务内最终防线）。
 * 调用方保证与任务创建在同一事件循环 tick 内（无 await 间隔），无并发窗口。
 */
export function reserveForTask(db: DatabaseSync, info: TaskSettlementInfo, estimateCny: number): void {
  if (estimateCny <= 0) return;
  const balance = getBalanceCny(db, info.userId);
  if (balance < estimateCny) {
    throw new InsufficientBalanceError(
      `余额不足：需要预留 ${estimateCny.toFixed(2)} 元，当前余额 ${balance.toFixed(2)} 元`,
    );
  }
  insertEntry(db, {
    userId: info.userId,
    kind: 'reserve',
    taskId: info.taskId,
    amountCny: -estimateCny,
    priceVersion: info.priceVersion,
    bizKey: `reserve:${info.taskId}`,
    memo: `单任务预算预留（上限 ${estimateCny.toFixed(2)} 元）`,
  });
}

/**
 * 记录一次模型响应的实际成本（runTask 每步调用）。
 * usage 为 null 表示供应商成本已发生但用量缺失（解析失败/缺失）—— 按每步估算兜底扣费（预留制解法）。
 * biz_key = actual:{taskId}:{step}，每步恰好一条。
 */
export function recordActualUsage(
  db: DatabaseSync,
  info: TaskSettlementInfo,
  step: number,
  usage: TaskUsage | null,
): void {
  const cost = stepCostCny(info.modelId, usage);
  insertEntry(db, {
    userId: info.userId,
    kind: 'actual',
    taskId: info.taskId,
    amountCny: -cost,
    priceVersion: info.priceVersion ?? MODEL_PRICE_VERSION,
    bizKey: `actual:${info.taskId}:${step}`,
    memo: usage
      ? `第 ${step + 1} 步实际用量 ${usage.promptTokens}/${usage.completionTokens} tokens`
      : `第 ${step + 1} 步用量缺失，按每步估算上限兜底扣费`,
  });
}

/**
 * 任务终态结算：释放全部预留（净扣 = Σactual）。幂等 —— biz_key settle:{taskId} 唯一，
 * 重复迁移 / 恢复 / 重复调用只结算一次。返回是否发生了记账。
 */
export function settleTask(db: DatabaseSync, info: TaskSettlementInfo): boolean {
  const reserved = info.reservedCny ?? 0;
  if (reserved <= 0) return false;
  const released = insertEntry(db, {
    userId: info.userId,
    kind: 'settle',
    taskId: info.taskId,
    amountCny: reserved,
    priceVersion: info.priceVersion,
    bizKey: `settle:${info.taskId}`,
    memo: '任务终态，释放预算预留（实际成本已按步计入 actual）',
  });
  if (released) {
    // 运营保护：实际消耗超出预留属异常信号（估算公式失准），对账与告警关注点
    const actuals = queryAll<{ total: number }>(
      db,
      "SELECT COALESCE(SUM(amount_cny), 0) AS total FROM ledger_entries WHERE task_id = ? AND kind = 'actual'",
      info.taskId,
    )!;
    const actualTotal = -actuals[0]!.total;
    if (actualTotal > reserved) {
      console.warn(
        `[ledger] 任务 ${info.taskId} 实际成本 ${actualTotal.toFixed(4)} 元超过预留 ${reserved.toFixed(4)} 元`,
      );
    }
  }
  return released;
}

// ===== 支付入账（P5 mock 支付使用；充值只允许服务端验证后的回调调用） =====

/** 充值入账：biz_key = topup:{paymentId}，重复回调幂等。返回是否发生了记账。 */
export function recordTopup(
  db: DatabaseSync,
  userId: string,
  amountCny: number,
  paymentId: string,
  memo?: string,
): boolean {
  return insertEntry(db, {
    userId,
    kind: 'topup',
    taskId: null,
    amountCny,
    priceVersion: null,
    bizKey: `topup:${paymentId}`,
    memo: memo ?? '充值入账',
  });
}

/** 原充值金额（元）；不存在返回 null —— 退款引用校验用（退款只能引用本用户的充值） */
export function getTopupCny(db: DatabaseSync, userId: string, paymentId: string): number | null {
  const row = queryOne<{ amount_cny: number }>(
    db,
    'SELECT amount_cny FROM ledger_entries WHERE biz_key = ? AND user_id = ?',
    `topup:${paymentId}`,
    userId,
  );
  return row ? row.amount_cny : null;
}

/** 该充值已累计退款金额（元）；分笔退款以 biz_key 前缀 refund:{paymentId}: 归集 */
export function getRefundedCny(db: DatabaseSync, userId: string, paymentId: string): number {
  const { total } = queryOne<{ total: number }>(
    db,
    "SELECT COALESCE(SUM(-amount_cny), 0) AS total FROM ledger_entries WHERE kind = 'refund' AND user_id = ? AND biz_key LIKE ?",
    userId,
    `refund:${paymentId}:%`,
  )!;
  return Math.round(total * 1e6) / 1e6;
}

/** 是否已记录过该退款单（同 paymentId 同 refundId）—— 重放幂等判定，先于累计校验 */
export function hasRefundEntry(
  db: DatabaseSync,
  userId: string,
  paymentId: string,
  refundId: string,
): boolean {
  return (
    queryOne<{ id: string }>(
      db,
      'SELECT id FROM ledger_entries WHERE biz_key = ? AND user_id = ?',
      `refund:${paymentId}:${refundId}`,
      userId,
    ) !== undefined
  );
}

/**
 * 退款出账（分笔支持）：biz_key = refund:{paymentId}:{refundId}，
 * refundId 为退款单号（真实支付场景由服务商下发，如微信支付 out_refund_no）——
 * 同一退款单重放幂等；分笔退相同金额是不同 refundId，不会误判为重放；
 * 累计退款不得超过原充值（调用方校验）。返回是否发生了记账。
 */
export function recordRefund(
  db: DatabaseSync,
  userId: string,
  amountCny: number,
  paymentId: string,
  refundId: string,
  memo?: string,
): boolean {
  return insertEntry(db, {
    userId,
    kind: 'refund',
    taskId: null,
    amountCny: -amountCny,
    priceVersion: null,
    bizKey: `refund:${paymentId}:${refundId}`,
    memo: memo ?? `退款出账（原充值 ${paymentId}，退款单 ${refundId}）`,
  });
}

// ===== 运营保护 =====

/**
 * 平台风险敞口（元）= 当日实际消耗（Σactual）+ 当前仍未释放的预留（Σreserve − Σsettle，不限创建日期）。
 * 口径说明（预留制）：reserve 是占用、settle 是释放、actual 才是真实成本——
 * 已终态任务的预留不计入支出（完成任务的当日成本只有 actual），进行中任务的预留
 * 在占用期间持续计入敞口（跨日任务不因日期切换漏算）。全部基于账本条目，与余额同源。
 */
export function getPlatformExposureCny(db: DatabaseSync): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const { actual } = queryOne<{ actual: number }>(
    db,
    "SELECT COALESCE(SUM(-amount_cny), 0) AS actual FROM ledger_entries WHERE kind = 'actual' AND created_at >= ?",
    start.toISOString(),
  )!;
  const { occupied } = queryOne<{ occupied: number }>(
    db,
    "SELECT COALESCE(SUM(-amount_cny), 0) AS occupied FROM ledger_entries WHERE kind = 'reserve'",
  )!;
  const { released } = queryOne<{ released: number }>(
    db,
    "SELECT COALESCE(SUM(amount_cny), 0) AS released FROM ledger_entries WHERE kind = 'settle'",
  )!;
  return Math.round((actual + occupied - released) * 1e6) / 1e6;
}

/**
 * 平台总预算告警（P5 运营保护）：平台风险敞口超过阈值时打告警日志。
 * 阈值 <= 0 表示关闭告警。仅告警不阻断 —— 阻断由单任务预算与用户限额负责。
 */
export function warnIfPlatformBudgetExceeded(db: DatabaseSync, dailyBudgetCny: number): void {
  if (dailyBudgetCny <= 0) return;
  const exposure = getPlatformExposureCny(db);
  if (exposure > dailyBudgetCny) {
    console.warn(
      `[ledger] 平台支出敞口 ${exposure.toFixed(2)} 元已超过预算告警阈值 ${dailyBudgetCny.toFixed(2)} 元，请关注对账`,
    );
  }
}

/**
 * 平台费用硬上限（账本可靠性加固）：平台风险敞口 + 本次预估超过硬上限时，
 * 拒绝创建/重试 live 任务（429）。硬上限为平台级兜底，优先级高于用户限额；
 * <= 0 表示关闭（测试环境默认关闭）。
 */
export function assertPlatformDailyBudget(
  db: DatabaseSync,
  hardLimitCny: number,
  additionalCny: number,
): void {
  if (hardLimitCny <= 0) return;
  const exposure = getPlatformExposureCny(db);
  if (exposure + additionalCny > hardLimitCny) {
    throw new QuotaExceededError(
      `平台支出敞口 ${exposure.toFixed(2)} 元，加上本次预估 ${additionalCny.toFixed(2)} 元将超过硬上限 ${hardLimitCny.toFixed(2)} 元，请明日再试`,
      'platform_daily_budget_exceeded',
    );
  }
}
