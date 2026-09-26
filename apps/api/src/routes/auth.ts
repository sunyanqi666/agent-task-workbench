import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthResponse, BalanceResponse, MeResponse } from 'contracts';
import { getBalanceCny } from '../services/ledgerService';
import { sumReservedCny } from '../services/taskService';
import { UnauthorizedError } from '../services/errors';
import {
  clearSessionCookieHeader,
  createSession,
  deleteSession,
  getSessionTokenFromRequest,
  getUserFromRequest,
  pruneExpiredSessions,
  registerUser,
  sessionCookieHeader,
  verifyLogin,
} from '../services/authService';
import { ValidationError } from '../services/errors';

/**
 * 认证路由：注册 / 登录 / 登出 / 当前用户。
 * 会话用 HttpOnly Cookie（wb_session），前端不可读；只做输入校验与响应，凭证与会话逻辑归 authService。
 */

function parseAuthBody(body: unknown): { username: string; password: string } {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('请求体必须是 JSON 对象');
  }
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new ValidationError('username 与 password 必须是字符串');
  }
  return { username, password };
}

function setSessionCookie(
  reply: FastifyReply,
  db: DatabaseSync,
  userId: string,
  secure: boolean,
): void {
  pruneExpiredSessions(db); // 低频路径顺手清理过期会话
  const { token, maxAgeSeconds } = createSession(db, userId);
  reply.header('set-cookie', sessionCookieHeader(token, maxAgeSeconds, secure));
}

export function registerAuthRoutes(app: FastifyInstance, db: DatabaseSync, secureCookies: boolean): void {
  // 注册：成功即建立会话（201 + Set-Cookie）
  app.post('/api/v1/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = registerUser(db, parseAuthBody(request.body));
    setSessionCookie(reply, db, user.id, secureCookies);
    reply.code(201);
    return { user } satisfies AuthResponse;
  });

  // 登录：校验凭证并建立会话（200 + Set-Cookie）；凭证错误 401
  app.post('/api/v1/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = verifyLogin(db, parseAuthBody(request.body));
    setSessionCookie(reply, db, user.id, secureCookies);
    return { user } satisfies AuthResponse;
  });

  // 登出：删除服务端会话并清除 Cookie（幂等，未登录也返回 204）
  app.post('/api/v1/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = getSessionTokenFromRequest(request);
    if (token) deleteSession(db, token);
    reply.header('set-cookie', clearSessionCookieHeader(secureCookies));
    reply.code(204);
    return null;
  });

  // 当前用户：未登录返回 { user: null }（前端据此展示登录栏），不作为错误
  app.get('/api/v1/auth/me', async (request: FastifyRequest) => {
    const user = getUserFromRequest(db, request);
    return { user } satisfies MeResponse;
  });

  // 余额（P5 账本）：需登录；余额 = 账本代数和（已扣预留与实际消耗），reservedCny 为进行中 live 任务预留合计
  app.get('/api/v1/me/balance', async (request: FastifyRequest) => {
    const user = getUserFromRequest(db, request);
    if (!user) throw new UnauthorizedError('查询余额需要登录');
    return {
      balanceCny: getBalanceCny(db, user.id),
      reservedCny: sumReservedCny(db, user.id),
    } satisfies BalanceResponse;
  });
}
