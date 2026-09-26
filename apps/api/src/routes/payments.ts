import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { PaymentResponse } from 'contracts';
import {
  getBalanceCny,
  getRefundedCny,
  getTopupCny,
  hasRefundEntry,
  recordRefund,
  recordTopup,
} from '../services/ledgerService';
import { getUserFromRequest } from '../services/authService';
import { AppError, NotFoundError, UnauthorizedError, ValidationError } from '../services/errors';

/**
 * 支付测试环境（P5 第 5 步）：mock 支付的充值回调与退款，供账本闭环演练。
 * 安全边界：入账只发生在「服务端验证后的回调」—— 真实接入时本路由替换为
 * 带签名验证的服务端对服务端回调（当前以登录会话模拟受信调用方）。
 * 幂等由账本 biz_key 保证：topup:{paymentId} / refund:{paymentId}，重复通知不重复入账。
 */

/** 单笔支付金额上限（元）：测试环境的合理边界 */
const MAX_PAYMENT_CNY = 10_000;
/** paymentId 长度上限 */
const MAX_PAYMENT_ID_LENGTH = 128;

function parseAmountCny(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ValidationError('amountCny 必须是数字');
  }
  const rounded = Math.round(raw * 100) / 100; // 仅支持分精度
  if (rounded <= 0) throw new ValidationError('amountCny 必须大于 0（支付失败/无效金额不入账）');
  if (rounded > MAX_PAYMENT_CNY) throw new ValidationError(`单笔金额不能超过 ${MAX_PAYMENT_CNY} 元`);
  return rounded;
}

function parsePaymentId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new ValidationError('paymentId 不能为空');
  const id = raw.trim();
  if (id.length > MAX_PAYMENT_ID_LENGTH) {
    throw new ValidationError(`paymentId 最长 ${MAX_PAYMENT_ID_LENGTH} 字符`);
  }
  return id;
}

interface PaymentBody {
  paymentId?: unknown;
  amountCny?: unknown;
}

export function registerPaymentRoutes(app: FastifyInstance, db: DatabaseSync): void {
  // 模拟充值回调：等价于第三方支付成功通知。重复 paymentId 幂等（recorded=false，不重复入账）。
  app.post('/api/v1/payments/mock-topup', async (request: FastifyRequest) => {
    const user = getUserFromRequest(db, request);
    if (!user) throw new UnauthorizedError('充值需要登录');
    const body = (request.body ?? {}) as PaymentBody;
    const paymentId = parsePaymentId(body.paymentId);
    const amountCny = parseAmountCny(body.amountCny);
    const recorded = recordTopup(db, user.id, amountCny, paymentId);
    return { recorded, balanceCny: getBalanceCny(db, user.id) } satisfies PaymentResponse;
  });

  // 退款：必须引用本用户的一笔充值；分笔退款累计不得超过原充值；
  // 同一通知重放（同 paymentId 同金额）幂等跳过（biz_key = refund:{paymentId}:{amount}）。
  app.post('/api/v1/payments/refund', async (request: FastifyRequest) => {
    const user = getUserFromRequest(db, request);
    if (!user) throw new UnauthorizedError('退款需要登录');
    const body = (request.body ?? {}) as PaymentBody;
    const paymentId = parsePaymentId(body.paymentId);
    const amountCny = parseAmountCny(body.amountCny);
    // 重放幂等先行：同一通知（同 paymentId 同金额）已入账过则直接跳过（累计校验可能已不通过）
    if (hasRefundEntry(db, user.id, paymentId, amountCny)) {
      return { recorded: false, balanceCny: getBalanceCny(db, user.id) } satisfies PaymentResponse;
    }
    const topupCny = getTopupCny(db, user.id, paymentId);
    if (topupCny === null) {
      throw new NotFoundError(`未找到本用户的充值记录：${paymentId}`);
    }
    const refundedCny = getRefundedCny(db, user.id, paymentId);
    if (Math.round((refundedCny + amountCny) * 100) > Math.round(topupCny * 100)) {
      throw new AppError(
        `累计退款 ${(refundedCny + amountCny).toFixed(2)} 元将超过原充值 ${topupCny.toFixed(2)} 元（已退 ${refundedCny.toFixed(2)} 元）`,
        400,
        'refund_exceeds_topup',
      );
    }
    const recorded = recordRefund(db, user.id, amountCny, paymentId);
    return { recorded, balanceCny: getBalanceCny(db, user.id) } satisfies PaymentResponse;
  });
}
