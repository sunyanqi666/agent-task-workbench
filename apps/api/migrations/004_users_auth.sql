-- 004 用户账号与会话（P5 账号与归属）
-- 密码用 node:crypto scrypt 哈希（格式 scrypt$N$r$p$salt$hash），不存明文；
-- 会话 token 只存 SHA-256 哈希（数据库泄露不等于会话泄露），过期由服务端校验并惰性清理。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY, -- 会话 token 的 SHA-256 十六进制摘要
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
