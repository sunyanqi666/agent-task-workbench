import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { PaymentResponse } from 'contracts';
import { getBalanceCny, getEntriesByUser } from '../services/ledgerService';
import { makeApp } from '../testing';

/**
 * P5 支付测试环境（第 5 步）：充值回调 / 退款 / 失败路径 / 重复回调幂等。
 * 安全边界：入账只发生在受信回调（当前以登录会话模拟）；biz_key 唯一防重复。
 */

async function register(app: FastifyInstance, username: string): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password: 'password123' },
  });
  assert.equal(res.statusCode, 201);
  const raw = res.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
  const cookie = /wb_session=[^;]+/.exec(joined)?.[0];
  assert.ok(cookie);
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  const meBody = me.json() as { user: { id: string } | null };
  assert.ok(meBody.user);
  return { cookie, userId: meBody.user.id };
}

test('充值：成功入账；同一 paymentId 重复回调幂等不重复入账', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const { cookie, userId } = await register(app, 'pay_topup');

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/mock-topup',
    payload: { paymentId: 'ch_001', amountCny: 10.5 },
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const first = res.json() as PaymentResponse;
  assert.equal(first.recorded, true);
  assert.equal(first.balanceCny, 10.5);

  const dup = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/mock-topup',
    payload: { paymentId: 'ch_001', amountCny: 10.5 },
    headers: { cookie },
  });
  assert.equal(dup.json().recorded, false, '重复回调幂等');
  assert.equal(dup.json().balanceCny, 10.5, '余额不变');
  assert.equal(getEntriesByUser(db, userId).length, 1, '账本仍只有一条');
});

test('充值失败路径：未登录 401；非法金额 / 缺 paymentId 400 且不入账', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const { cookie, userId } = await register(app, 'pay_fail');

  const anon = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/mock-topup',
    payload: { paymentId: 'ch_x', amountCny: 10 },
  });
  assert.equal(anon.statusCode, 401);

  for (const payload of [
    { paymentId: 'ch_bad', amountCny: 0 },
    { paymentId: 'ch_bad', amountCny: -5 },
    { paymentId: 'ch_bad', amountCny: '10' },
    { paymentId: 'ch_bad', amountCny: 10_001 }, // 超单笔上限
    { amountCny: 10 },
    { paymentId: 'x'.repeat(129), amountCny: 10 },
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/mock-topup',
      payload,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(getBalanceCny(db, userId), 0, '失败路径均不入账');
});

test('退款：分笔累计不超原充值；重放幂等；超退 400；未知 paymentId 404；未登录 401', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const { cookie, userId } = await register(app, 'pay_refund');
  await app.inject({
    method: 'POST',
    url: '/api/v1/payments/mock-topup',
    payload: { paymentId: 'ch_ref', amountCny: 10 },
    headers: { cookie },
  });

  // 分笔退款 4 + 6 = 全额（不同退款单号）
  const partial = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/refund',
    payload: { paymentId: 'ch_ref', refundId: 're_001', amountCny: 4 },
    headers: { cookie },
  });
  assert.equal(partial.json().recorded, true);
  assert.equal(partial.json().balanceCny, 6);

  const rest = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/refund',
    payload: { paymentId: 'ch_ref', refundId: 're_002', amountCny: 6 },
    headers: { cookie },
  });
  assert.equal(rest.json().recorded, true);
  assert.equal(rest.json().balanceCny, 0);

  // 同一退款单重放（同 paymentId 同 refundId）幂等跳过，不再出账
  const replay = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/refund',
    payload: { paymentId: 'ch_ref', refundId: 're_001', amountCny: 4 },
    headers: { cookie },
  });
  assert.equal(replay.json().recorded, false);
  assert.equal(replay.json().balanceCny, 0);

  // 累计退款超过原充值（新充值 2，再退 1 后试图退 2）
  await app.inject({
    method: 'POST',
    url: '/api/v1/payments/mock-topup',
    payload: { paymentId: 'ch_small', amountCny: 2 },
    headers: { cookie },
  });
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/refund',
    payload: { paymentId: 'ch_small', refundId: 're_101', amountCny: 1 },
    headers: { cookie },
  });
  assert.equal(first.json().recorded, true);
  const over = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/refund',
    payload: { paymentId: 'ch_small', refundId: 're_102', amountCny: 2 },
    headers: { cookie },
  });
  assert.equal(over.statusCode, 400);
  assert.equal(over.json().error.code, 'refund_exceeds_topup');

  // 未知 paymentId 404
  const unknown = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/refund',
    payload: { paymentId: 'ch_missing', refundId: 're_201', amountCny: 1 },
    headers: { cookie },
  });
  assert.equal(unknown.statusCode, 404);

  // 未登录 401
  const anon = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/refund',
    payload: { paymentId: 'ch_ref', refundId: 're_301', amountCny: 1 },
  });
  assert.equal(anon.statusCode, 401);

  // 缺 refundId 400
  const noId = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/refund',
    payload: { paymentId: 'ch_small', amountCny: 1 },
    headers: { cookie },
  });
  assert.equal(noId.statusCode, 400);

  // 对账：入账 10 + 2，出账 4 + 6 + 1 → 余额 1
  assert.equal(getBalanceCny(db, userId), 1);
  const kinds = getEntriesByUser(db, userId).map((e) => e.kind);
  assert.deepEqual(kinds, ['topup', 'refund', 'refund', 'topup', 'refund']);
});

test('退款幂等键：同一充值分两次退相同金额（不同 refundId）均入账，不误判为重放', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const { cookie, userId } = await register(app, 'pay_refund_id');
  await app.inject({
    method: 'POST',
    url: '/api/v1/payments/mock-topup',
    payload: { paymentId: 'ch_same', amountCny: 10 },
    headers: { cookie },
  });

  // 旧实现 biz_key = refund:{paymentId}:{amount}，第二笔会被误判为重放
  for (const refundId of ['re_a', 're_b']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/refund',
      payload: { paymentId: 'ch_same', refundId, amountCny: 3 },
      headers: { cookie },
    });
    assert.equal(res.json().recorded, true, `退款单 ${refundId} 应入账`);
  }
  assert.equal(getBalanceCny(db, userId), 4, '两笔同金额退款均生效（10 - 3 - 3）');

  const refunds = getEntriesByUser(db, userId).filter((e) => e.kind === 'refund');
  assert.equal(refunds.length, 2);
  assert.deepEqual(
    refunds.map((e) => e.bizKey).sort(),
    ['refund:ch_same:re_a', 'refund:ch_same:re_b'],
  );
});
