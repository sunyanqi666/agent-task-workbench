-- 006 用量账本与预算预留（P5 用量账本与结算）
-- 记账模型：reserve 扣预留 → actual 逐次扣真实成本 → settle 释放全部预留（净扣 = Σactual）；
-- topup 充值入账；refund 退款出账（P5 支付）。余额 = SUM(amount_cny)。
-- biz_key 唯一：reserve:{taskId} / actual:{taskId}:{step} / settle:{taskId} / topup:{paymentId} / refund:{paymentId}:{amount}，
-- 重复回调、重复结算、重启恢复均不会重复记账。
ALTER TABLE tasks ADD COLUMN price_version TEXT;
ALTER TABLE tasks ADD COLUMN reserved_cny REAL NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL, -- reserve | actual | settle | topup | refund
  task_id       TEXT REFERENCES tasks(id),
  amount_cny    REAL NOT NULL, -- 正 = 入账（余额增加），负 = 出账（余额减少）
  balance_after REAL NOT NULL, -- 记账后余额快照（审计用）
  price_version TEXT,          -- 记账时固化的价格版本（topup / refund 可空）
  biz_key       TEXT NOT NULL UNIQUE,
  memo          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_task ON ledger_entries(task_id);
