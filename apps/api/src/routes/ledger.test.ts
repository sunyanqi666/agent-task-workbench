import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { BalanceResponse, Task, TaskLedgerResponse } from 'contracts';
import { MODEL_PRICE_VERSION, estimateTaskBudgetCny } from 'contracts';
import { queryAll, queryOne } from '../db';
import {
  getBalanceCny,
  getEntriesByTask,
  getEntriesByUser,
  recordTopup,
  reserveForTask,
  settleTask,
  warnIfPlatformBudgetExceeded,
  type LedgerEntry,
} from '../services/ledgerService';
import { createTask, setReservedCny, transitionTask } from '../services/taskService';
import { makeApp, waitForTerminal } from '../testing';

/**
 * P5 用量账本与结算：预留（reserve）→ 逐次实际（actual，含用量缺失兜底）→ 终态结算（settle）。
 * 记账模型：净扣 = Σactual；biz_key 唯一防重复（重复结算 / 重复回调均幂等）。
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
  assert.ok(meBody.user, '注册会话应返回当前用户');
  return { cookie, userId: meBody.user.id };
}

function sumEntries(entries: LedgerEntry[]): number {
  return Math.round(entries.reduce((acc, e) => acc + e.amountCny, 0) * 1e6) / 1e6;
}

/**
 * 账本一致性不变量（可靠性加固的验收口径）：
 * 1. 余额 == 全部条目代数和（不是独立存储，防口径漂移）；
 * 2. 终态 live 任务：必有 settle 条目，reserve 与 settle 全额抵消（净额 == -Σactual，即真实消耗）；
 * 3. 进行中 live 任务：不得有 settle 条目，行上 reserved_cny == -Σreserve（预留与账本互相印证）。
 */
function expectLedgerConsistent(db: DatabaseSync, userId: string): void {
  const { balance } = queryOne<{ balance: number }>(
    db,
    'SELECT COALESCE(SUM(amount_cny), 0) AS balance FROM ledger_entries WHERE user_id = ?',
    userId,
  )!;
  assert.equal(getBalanceCny(db, userId), balance, '余额 == 账本代数和');

  const tasks = queryAll<{ id: string; status: string; reserved_cny: number }>(
    db,
    "SELECT id, status, reserved_cny FROM tasks WHERE user_id = ? AND mode = 'live'",
    userId,
  );
  for (const task of tasks) {
    const taskEntries = getEntriesByTask(db, task.id);
    const hasSettle = taskEntries.some((e) => e.kind === 'settle');
    const hasReserve = taskEntries.some((e) => e.kind === 'reserve');
    if (['completed', 'failed', 'canceled'].includes(task.status)) {
      assert.equal(hasSettle, hasReserve, `终态任务 ${task.id} 的预留必须已释放`);
      // 预留 + 释放 == 0：悬挂的 reserve/settle 都算违例；actual 是真实消耗，保留
      const reserveAndSettle = sumEntries(taskEntries.filter((e) => e.kind !== 'actual'));
      assert.equal(reserveAndSettle, 0, `终态任务 ${task.id} 预留必须全额释放`);
    } else {
      assert.equal(hasSettle, false, `进行中任务 ${task.id} 不得提前释放预留`);
      if (hasReserve) {
        const reserved = -sumEntries(taskEntries.filter((e) => e.kind === 'reserve'));
        assert.equal(task.reserved_cny, reserved, `进行中任务 ${task.id} 行上预留与账本一致`);
      }
    }
  }
}

test('demo 任务不产生账本记录', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+1 的结果' },
  });
  assert.equal(res.statusCode, 201);
  const task = res.json() as Task;
  await waitForTerminal(app, task.id);
  assert.deepEqual(getEntriesByTask(db, task.id), []);
});

test('live 全流程：预留 0.48 → 调用失败按每步估算兜底 0.024 → 结算释放；余额与价格版本正确', async (t) => {
  const { app, db, cleanup } = await makeApp({
    // 配置 live 但指向不可达地址：任务在第一步即 model_error，不发起真实外部调用
    config: {
      modelProvider: 'deepseek',
      modelApiKey: 'test-key-not-used',
      modelBaseUrl: 'http://127.0.0.1:1',
      modelName: 'deepseek-flash',
    },
  });
  t.after(cleanup);

  const { cookie, userId } = await register(app, 'ledger_flow');
  assert.equal(recordTopup(db, userId, 10, 'pay_flow_1'), true, '充值入账');

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+1 的结果', mode: 'live' },
    headers: { cookie },
  });
  assert.equal(res.statusCode, 201);
  const task = res.json() as Task;
  assert.equal(task.priceVersion, MODEL_PRICE_VERSION, '创建时固化价格版本');

  await waitForTerminal(app, task.id, 200, { headers: { cookie } });
  const failed = await app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${task.id}`,
    headers: { cookie },
  });
  assert.equal(failed.json().status, 'failed');

  const entries = getEntriesByTask(db, task.id);
  const kinds = entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['reserve', 'actual', 'settle']);
  assert.equal(entries[0]!.amountCny, -(estimateTaskBudgetCny('deepseek-flash', 20)!)); // -0.48
  assert.equal(entries[1]!.amountCny, -0.024, '用量缺失按每步估算兜底'); // (4000×2+2000×8)/1e6
  assert.match(entries[1]!.memo!, /兜底/);
  assert.equal(entries[2]!.amountCny, 0.48, '终态释放全部预留');
  for (const e of entries) assert.equal(e.priceVersion, MODEL_PRICE_VERSION);

  // 净扣 = Σactual = 0.024；余额 = 10 - 0.48 - 0.024 + 0.48 = 9.976
  const balanceRes = await app.inject({
    method: 'GET',
    url: '/api/v1/me/balance',
    headers: { cookie },
  });
  const balance = balanceRes.json() as BalanceResponse;
  assert.equal(balance.balanceCny, 9.976);
  assert.equal(balance.reservedCny, 0, '任务已终态，无进行中预留');
});

test('余额不足：live 创建 402（任务被补偿删除，无账本记录）', async (t) => {
  const { app, cleanup } = await makeApp({
    config: {
      modelProvider: 'deepseek',
      modelApiKey: 'test-key-not-used',
      modelBaseUrl: 'http://127.0.0.1:1',
      modelName: 'deepseek-flash',
    },
  });
  t.after(cleanup);

  const { cookie } = await register(app, 'ledger_broke');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '计算 1+1 的结果', mode: 'live' },
    headers: { cookie },
  });
  assert.equal(res.statusCode, 402);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'insufficient_balance');

  const list = await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { cookie } });
  assert.equal(list.json().total, 0, '补偿删除：不留悬挂 queued 任务');
});

test('取消释放预留 + 结算幂等（biz_key 唯一，重复结算不重复入账）', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);

  const { userId } = await register(app, 'ledger_cancel');
  recordTopup(db, userId, 1, 'pay_cancel');
  const task = createTask(db, {
    prompt: '计算 1+1 的结果',
    mode: 'live',
    modelId: 'deepseek-flash',
    userId,
    priceVersion: MODEL_PRICE_VERSION,
  });
  const estimate = estimateTaskBudgetCny('deepseek-flash', 20)!;
  reserveForTask(
    db,
    { taskId: task.id, userId, modelId: task.modelId, priceVersion: task.priceVersion, reservedCny: estimate },
    estimate,
  );
  setReservedCny(db, task.id, estimate); // 终态结算钩子从任务行读预留金额（路由路径同样如此）
  assert.equal(getBalanceCny(db, userId), 1 - estimate, '预留后余额减少');

  transitionTask(db, task.id, { to: 'canceled' }); // 终态钩子自动结算
  const entries = getEntriesByTask(db, task.id);
  assert.deepEqual(entries.map((e) => e.kind), ['reserve', 'settle']);
  assert.equal(getBalanceCny(db, userId), 1, '取消不产生实际成本，预留全额释放');

  // 结算幂等：biz_key settle:{taskId} 已存在，再次结算返回 false 且无新条目
  assert.equal(
    settleTask(db, { taskId: task.id, userId, modelId: task.modelId, priceVersion: task.priceVersion, reservedCny: estimate }),
    false,
  );
  assert.equal(getEntriesByTask(db, task.id).length, 2);
});

test('充值幂等：同一 paymentId 重复入账只记一次', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const { userId } = await register(app, 'ledger_topup');
  assert.equal(recordTopup(db, userId, 10, 'pay_dup'), true);
  assert.equal(recordTopup(db, userId, 10, 'pay_dup'), false, '重复回调不重复入账');
  assert.equal(getBalanceCny(db, userId), 10);
});

test('平台日预算告警：当日净流出超阈值触发 console.warn（仅告警不阻断）', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const { userId } = await register(app, 'ledger_alert');
  recordTopup(db, userId, 5, 'pay_alert');
  // 预留需要真实任务行（ledger_entries.task_id 外键）
  const task = createTask(db, {
    prompt: '告警',
    mode: 'live',
    modelId: 'deepseek-flash',
    userId,
    priceVersion: MODEL_PRICE_VERSION,
  });
  reserveForTask(
    db,
    { taskId: task.id, userId, modelId: task.modelId, priceVersion: task.priceVersion },
    1,
  );

  const warn = t.mock.method(console, 'warn', () => {});
  warnIfPlatformBudgetExceeded(db, 0.5); // 净流出 1 元 > 0.5 元
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /预算告警阈值/);
  warnIfPlatformBudgetExceeded(db, 2); // 未超阈值，不告警
  assert.equal(warn.mock.callCount(), 1);
  warnIfPlatformBudgetExceeded(db, 0); // 阈值 <= 0 关闭
  assert.equal(warn.mock.callCount(), 1);
});

test('扣费明细端点：归属校验（他人 404）+ demo 任务空列表 + live 任务条目', async (t) => {
  const { app, db, cleanup } = await makeApp({
    config: {
      modelProvider: 'deepseek',
      modelApiKey: 'test-key-not-used',
      modelBaseUrl: 'http://127.0.0.1:1',
      modelName: 'deepseek-flash',
    },
  });
  t.after(cleanup);

  const a = await register(app, 'ledger_det_a');
  const b = await register(app, 'ledger_det_b');
  recordTopup(db, a.userId, 10, 'pay_det');
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '明细 live', mode: 'live' },
    headers: { cookie: a.cookie },
  });
  const taskId = (created.json() as Task).id;
  await waitForTerminal(app, taskId, 200, { headers: { cookie: a.cookie } });

  // 归属：B 查 A 的账本 → 404；匿名 → 404
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}/ledger`, headers: { cookie: b.cookie } })).statusCode,
    404,
  );
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}/ledger` })).statusCode, 404);

  // A：reserve/actual/settle 完整链
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${taskId}/ledger`,
    headers: { cookie: a.cookie },
  });
  assert.equal(res.statusCode, 200);
  const { entries } = res.json() as TaskLedgerResponse;
  assert.deepEqual(entries.map((e) => e.kind), ['reserve', 'actual', 'settle']);

  // demo 任务：空列表
  const demo = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '明细 demo' },
  });
  const demoId = (demo.json() as Task).id;
  await waitForTerminal(app, demoId);
  const demoLedger = await app.inject({ method: 'GET', url: `/api/v1/tasks/${demoId}/ledger` });
  assert.deepEqual(demoLedger.json().entries, []);
});

test('对账：每用户余额 = 账本代数和；每个终态 live 任务恰一条 settle；actual 无重复 step', async (t) => {
  const { app, db, cleanup } = await makeApp({
    config: {
      modelProvider: 'deepseek',
      modelApiKey: 'test-key-not-used',
      modelBaseUrl: 'http://127.0.0.1:1',
      modelName: 'deepseek-flash',
    },
  });
  t.after(cleanup);

  const a = await register(app, 'ledger_rec_a');
  const b = await register(app, 'ledger_rec_b');
  recordTopup(db, a.userId, 20, 'pay_rec_a');
  recordTopup(db, a.userId, 20, 'pay_rec_a'); // 重复回调，应幂等
  recordTopup(db, b.userId, 5, 'pay_rec_b');

  // A：一个 live 任务（失败兜底）+ 两个 demo；B：一个取消的 live 任务（服务级构造）
  const live = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '对账 live', mode: 'live' },
    headers: { cookie: a.cookie },
  });
  await waitForTerminal(app, (live.json() as Task).id, 200, { headers: { cookie: a.cookie } });
  for (const prompt of ['对账 demo 1', '对账 demo 2']) {
    const demo = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { prompt },
      headers: { cookie: a.cookie },
    });
    await waitForTerminal(app, (demo.json() as Task).id, 200, { headers: { cookie: a.cookie } });
  }

  const bLive = createTask(db, {
    prompt: '对账取消',
    mode: 'live',
    modelId: 'deepseek-flash',
    userId: b.userId,
    priceVersion: MODEL_PRICE_VERSION,
  });
  const estimate = estimateTaskBudgetCny('deepseek-flash', 20)!;
  reserveForTask(
    db,
    { taskId: bLive.id, userId: b.userId, modelId: bLive.modelId, priceVersion: bLive.priceVersion, reservedCny: estimate },
    estimate,
  );
  setReservedCny(db, bLive.id, estimate);
  transitionTask(db, bLive.id, { to: 'canceled' });

  // 每用户：余额 = 账本代数和（含 balance_after 链末值一致）
  for (const user of [a, b]) {
    const entries = getEntriesByUser(db, user.userId);
    assert.equal(getBalanceCny(db, user.userId), sumEntries(entries));
  }
  assert.equal(getBalanceCny(db, a.userId), 20 - 0.024);
  assert.equal(getBalanceCny(db, b.userId), 5, '预留 +0.48 与结算 -0.48 相抵');

  // 每个终态 live 任务恰一条 settle；actual 条目 biz_key（step）无重复
  for (const taskId of [(live.json() as Task).id, bLive.id]) {
    const entries = getEntriesByTask(db, taskId);
    assert.equal(entries.filter((e) => e.kind === 'settle').length, 1, taskId);
    const steps = entries.filter((e) => e.kind === 'actual').map((e) => e.bizKey);
    assert.equal(new Set(steps).size, steps.length);
    const actualTotal = -entries.filter((e) => e.kind === 'actual').reduce((s, e) => s + e.amountCny, 0);
    assert.ok(
      actualTotal <= estimate + 1e-9,
      `实际成本 ${actualTotal} 不应超过预留 ${estimate}`,
    );
  }
});

// ===== 账本可靠性加固：中断 / 重试 / 重复回调 / 事务原子性 / 硬上限 / mock 开关 =====

test('中断恢复：运行中崩溃 → 恢复落终态与释放预留同事务，余额与账本对上', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const { userId } = await register(app, 'ledger_interrupt');
  recordTopup(db, userId, 5, 'pay_interrupt');
  expectLedgerConsistent(db, userId);

  // 模拟崩溃遗留：任务已创建并预留（同事务），执行中进程崩溃（recovery 的 running → failed 路径）
  const task = createTask(db, {
    prompt: '中断恢复',
    mode: 'live',
    modelId: 'deepseek-flash',
    userId,
    priceVersion: MODEL_PRICE_VERSION,
    reserveCny: estimateTaskBudgetCny('deepseek-flash', 20)!,
  });
  assert.equal(getBalanceCny(db, userId), 5 - 0.48, '创建+预留同事务扣减');
  expectLedgerConsistent(db, userId);

  // 恢复落终态（与 recovery.markInterrupted 一致）：状态更新与释放预留在同一事务
  transitionTask(db, task.id, { to: 'running' });
  transitionTask(db, task.id, { to: 'failed', errorCode: 'interrupted', message: '进程中断恢复' });
  const entries = getEntriesByTask(db, task.id).map((e) => e.kind);
  assert.deepEqual(entries, ['reserve', 'settle'], '同事务完成终态迁移与释放');
  assert.equal(getBalanceCny(db, userId), 5, '无实际消耗时预留全额释放');
  expectLedgerConsistent(db, userId);
});

test('事务原子性：余额不足 402 时不产生任务行（创建+预留回滚）', async (t) => {
  const { app, db, cleanup } = await makeApp({
    config: {
      modelProvider: 'deepseek',
      modelApiKey: 'test-key-not-used',
      modelBaseUrl: 'http://127.0.0.1:1',
      modelName: 'deepseek-flash',
    },
  });
  t.after(cleanup);
  const { cookie, userId } = await register(app, 'ledger_rollback');

  // 余额 0，live 创建应 402 且不留任何任务行
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '余额不足', mode: 'live' },
    headers: { cookie },
  });
  assert.equal(res.statusCode, 402);
  assert.equal(res.json().error.code, 'insufficient_balance');
  const list = await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { cookie } });
  assert.equal(list.json().total, 0, '任务行随事务回滚，不存在悬挂任务');
  assert.equal(getEntriesByUser(db, userId).length, 0, '账本无任何条目');
  expectLedgerConsistent(db, userId);
});

test('重试链路：失败 → 重试再预留 → 再终态，全程余额与账本对上', async (t) => {
  const { app, db, cleanup } = await makeApp({
    config: {
      modelProvider: 'deepseek',
      modelApiKey: 'test-key-not-used',
      modelBaseUrl: 'http://127.0.0.1:1',
      modelName: 'deepseek-flash',
    },
  });
  t.after(cleanup);
  const { cookie, userId } = await register(app, 'ledger_retry');
  recordTopup(db, userId, 2, 'pay_retry');

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '重试链路', mode: 'live' },
    headers: { cookie },
  });
  const first = created.json() as Task;
  await waitForTerminal(app, first.id, 200, { headers: { cookie } });
  expectLedgerConsistent(db, userId);
  const afterFirst = getBalanceCny(db, userId);
  assert.ok(afterFirst < 2 && afterFirst > 1, '预留释放后仅扣实际成本');

  const retried = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${first.id}/retry`,
    headers: { cookie },
  });
  assert.equal(retried.statusCode, 201);
  const second = retried.json() as Task;
  assert.equal(second.parentTaskId, first.id);
  await waitForTerminal(app, second.id, 200, { headers: { cookie } });

  // 两个任务各自净额为 0，余额 = 充值 - 两次实际成本
  expectLedgerConsistent(db, userId);
  const actualSum = -getEntriesByUser(db, userId)
    .filter((e) => e.kind === 'actual')
    .reduce((s, e) => s + e.amountCny, 0);
  assert.equal(getBalanceCny(db, userId), 2 - actualSum);
});

test('重复回调：充值/退款重放后余额与账本保持不变', async (t) => {
  const { app, db, cleanup } = await makeApp();
  t.after(cleanup);
  const { userId } = await register(app, 'ledger_dup');
  assert.equal(recordTopup(db, userId, 10, 'pay_dup2'), true);
  expectLedgerConsistent(db, userId);
  const afterTopup = getBalanceCny(db, userId);

  assert.equal(recordTopup(db, userId, 10, 'pay_dup2'), false, '重复充值回调不入账');
  assert.equal(getBalanceCny(db, userId), afterTopup, '余额不变');
  expectLedgerConsistent(db, userId);

  // 预留 + 结算后再重放退款：余额只受首笔影响
  const task = createTask(db, {
    prompt: '重放场景',
    mode: 'live',
    modelId: 'deepseek-flash',
    userId,
    priceVersion: MODEL_PRICE_VERSION,
    reserveCny: 0.48,
  });
  transitionTask(db, task.id, { to: 'canceled' });
  expectLedgerConsistent(db, userId);
});

test('平台费用硬上限：当日净流出 + 本次预估超限拒绝创建（429）', async (t) => {
  const { app, db, cleanup } = await makeApp({
    config: {
      modelProvider: 'deepseek',
      modelApiKey: 'test-key-not-used',
      modelBaseUrl: 'http://127.0.0.1:1',
      modelName: 'deepseek-flash',
      platformDailyHardLimitCny: 0.5,
    },
  });
  t.after(cleanup);
  const { cookie, userId } = await register(app, 'ledger_hardcap');
  recordTopup(db, userId, 10, 'pay_hardcap');

  // 第一单：0 + 0.48 ≤ 0.5 放行
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '硬上限内', mode: 'live' },
    headers: { cookie },
  });
  assert.equal(first.statusCode, 201);
  expectLedgerConsistent(db, userId);

  // 第二单：0.48（预留）+ 0.48 > 0.5 → 429
  const second = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: '硬上限外', mode: 'live' },
    headers: { cookie },
  });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, 'platform_daily_budget_exceeded');

  // demo 不受硬上限约束
  const demo = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { prompt: 'demo 不受限' },
  });
  assert.equal(demo.statusCode, 201);
});

test('生产安全：ENABLE_MOCK_PAYMENTS 关闭时模拟支付端点 403', async (t) => {
  const { app, db, cleanup } = await makeApp({ config: { mockPaymentsEnabled: false } });
  t.after(cleanup);
  const { cookie, userId } = await register(app, 'ledger_mockoff');

  const topup = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/mock-topup',
    payload: { paymentId: 'ch_off', amountCny: 10 },
    headers: { cookie },
  });
  assert.equal(topup.statusCode, 403);
  assert.equal(topup.json().error.code, 'mock_payments_disabled');

  const refund = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/refund',
    payload: { paymentId: 'ch_off', amountCny: 1 },
    headers: { cookie },
  });
  assert.equal(refund.statusCode, 403);
  assert.equal(getEntriesByUser(db, userId).length, 0, '关闭状态下无任何入账');
});
