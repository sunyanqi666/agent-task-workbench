import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { UserInfo } from 'contracts';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  USERNAME_PATTERN,
} from 'contracts';
import { queryOne } from '../db';
import { AppError, UnauthorizedError, ValidationError } from './errors';

/**
 * 认证服务：唯一有权读写 users / sessions 的模块。
 * 密码用 node:crypto scrypt 哈希（不引第三方依赖）；会话 token 只落库 SHA-256 摘要，
 * Cookie 泄露或数据库泄露都不直接等同对方泄露。归属判断（tasks.user_id）在任务服务。
 */

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

function rowToUser(row: UserRow): UserInfo {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

// ===== 密码哈希（scrypt$N$r$p$salt$hash） =====

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  try {
    const expected = Buffer.from(hashHex!, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex!, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validateRegistration(username: string, password: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new ValidationError('用户名需为 3..32 个字母、数字、下划线或连字符');
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError(`密码长度需为 ${PASSWORD_MIN_LENGTH}..${PASSWORD_MAX_LENGTH} 字符`);
  }
}

// ===== 注册 / 登录 =====

/** 注册：用户名唯一（冲突 409），成功返回新用户 */
export function registerUser(
  db: DatabaseSync,
  input: { username: string; password: string },
): UserInfo {
  if (typeof input.username !== 'string' || typeof input.password !== 'string') {
    throw new ValidationError('请求体必须是 JSON 对象');
  }
  const username = input.username.trim();
  validateRegistration(username, input.password);
  const id = randomBytes(16).toString('hex');
  const createdAt = new Date().toISOString();
  try {
    db.prepare(
      'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, username, hashPassword(input.password), createdAt);
  } catch (err) {
    // UNIQUE 约束冲突 → 409（不区分大小写由 UNIQUE COLLATE 决定，此处按精确值）
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new AppError(`用户名已被占用：${username}`, 409, 'username_taken');
    }
    throw err;
  }
  return { id, username, createdAt };
}

/** 登录校验：成功返回用户，失败一律 401（不区分「用户不存在」与「密码错误」） */
export function verifyLogin(
  db: DatabaseSync,
  input: { username: string; password: string },
): UserInfo {
  if (typeof input.username !== 'string' || typeof input.password !== 'string') {
    throw new ValidationError('请求体必须是 JSON 对象');
  }
  const row = queryOne<UserRow>(
    db,
    'SELECT * FROM users WHERE username = ?',
    input.username.trim(),
  );
  if (!row || !verifyPassword(input.password, row.password_hash)) {
    throw new UnauthorizedError('用户名或密码错误');
  }
  return rowToUser(row);
}

// ===== 会话 =====

/** token 随机 256bit；库中只存其 SHA-256 摘要 */
function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 创建会话：返回原始 token（写入 Cookie）与过期时间 */
export function createSession(
  db: DatabaseSync,
  userId: string,
): { token: string; maxAgeSeconds: number } {
  const token = randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(
    tokenDigest(token),
    userId,
    new Date().toISOString(),
    new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
  );
  return { token, maxAgeSeconds: SESSION_TTL_SECONDS };
}

/** 校验会话 token：命中且未过期返回用户；过期视为未登录并惰性删除 */
export function getUserBySessionToken(db: DatabaseSync, token: string): UserInfo | null {
  const row = queryOne<{ user_id: string; expires_at: string; username: string; created_at: string }>(
    db,
    `SELECT s.user_id, s.expires_at, u.username, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    tokenDigest(token),
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenDigest(token));
    return null;
  }
  return { id: row.user_id, username: row.username, createdAt: row.created_at };
}

/** 登出：删除会话记录（幂等，token 不存在也无害） */
export function deleteSession(db: DatabaseSync, token: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenDigest(token));
}

/** 清理全部过期会话（可在登录等低频路径顺手调用） */
export function pruneExpiredSessions(db: DatabaseSync): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

// ===== 请求上下文 =====

/** 解析 Cookie 头（不引依赖；只需读取会话 Cookie） */
function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

/** 从请求解析当前用户：无 Cookie / 会话无效 / 已过期一律返回 null（匿名） */
export function getUserFromRequest(db: DatabaseSync, request: FastifyRequest): UserInfo | null {
  const token = getSessionTokenFromRequest(request);
  if (!token) return null;
  return getUserBySessionToken(db, token);
}

/** 从请求中提取会话 token（登出等需要原始 token 的场景） */
export function getSessionTokenFromRequest(request: FastifyRequest): string | undefined {
  return parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
}

/** 构造 Set-Cookie 值：HttpOnly + SameSite=Lax；生产经反向代理提供 HTTPS 后可追加 Secure */
export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** 登出时的清除 Cookie 值 */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 供归属校验等场景按 id 反查用户（不存在返回 null） */
export function getUserById(db: DatabaseSync, userId: string): UserInfo | null {
  const row = queryOne<UserRow>(db, 'SELECT * FROM users WHERE id = ?', userId);
  return row ? rowToUser(row) : null;
}
