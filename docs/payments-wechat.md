# 微信支付接入：按单支付设计与商户资格清单（P6）

> 核实时间：2026-09-26，依据微信支付商户平台/商户文档（普通商户直连模式）。
> **模式已定案（2026-09-26）：按单支付** —— 不做余额充值池，每个 live 任务单独支付、单独结算、差额自动退款。规避《单用途商业预付卡》备案要求。

## 0. 按单支付模式（定案）

资金闭环（每单独立，账本契约复用）：

```
创建 live 任务 → 生成支付订单（金额 = 预估费用上限 R）
  → 用户扫码支付（Native）→ 回调验签+金额校验 → 入账 topup(+R) → 创建任务并执行
  → 任务终态结算 settle(+R) → 差额自动退款 refund(−(R−A))，A=Σactual
净效果：用户实付 = 实际消耗 A，差额原路退回，平台不留资金池
```

- `topup` 条目来源从「主动充值」变为「任务订单支付」；`biz_key = topup:{out_trade_no}` 幂等不变。
- 预留制（reserve/actual/settle）与余额校验照旧：支付成功的钱恰好覆盖预估上限，402 分支只防并发开销导致的超付。
- 任务终态钩子在 settle 后追加**差额退款**：`(R − A) > 0` 时自动 `recordRefund`（mock 记账 / 真实调微信退款 API，`out_refund_no = diff:{taskId}`）。
- `mock-topup` 保留：仅测试环境（`ENABLE_MOCK_PAYMENTS`），用于开发调试。

## 1. 商户资格核实清单（线下办理，先于开发）

| 事项 | 要求 / 结论 | 状态 |
| --- | --- | --- |
| 主体类型 | 线上 SaaS 不适用小微商户（仅限线下行业）；需 **个体工商户**（营业执照+经营者身份证）或 **企业**（营业执照+法人身份证） | 待定 |
| 经营类目 | 「软件/建站/技术开发」等 IT 服务类目，标准费率一般 0.6%（以签约页对照表为准） | 待核实 |
| 入驻流程 | pay.weixin.qq.com 普通商户入驻 → 提交资料 → 账户验证（法人微信授权或对公打款 0.01~1 元）→ 审核 48h 内 → 在线签约 | 待办 |
| 场景绑定 | 商户号绑定 APPID（本项目 Web 端用 **Native 扫码**，无需 openid）；需一个已认证的开放平台/公众号 APPID | 待办 |
| 开发参数 | 商户号 `mchid`、APIv3 密钥、商户 API 证书序列号 + 私钥、HTTPS 回调域名 | 待办 |
| 结算 | T+1 自动结算；可下载资金账单对账 | 了解 |

## 2. 技术实施设计

### 2.1 配置项（.env，全部服务端保密）

```
PAYMENT_PROVIDER=wxpay          # 空=关闭真实支付（mock 测试不受影响）
WXPAY_MCHID=1900000000
WXPAY_APPID=wx8888888888888888
WXPAY_API_V3_KEY=<32位 APIv3 密钥>
WXPAY_CERT_SERIAL=<商户证书序列号>
WXPAY_PRIVATE_KEY_PATH=./certs/apiclient_key.pem
WXPAY_NOTIFY_URL=https://<域名>/api/v1/payments/wxpay/notify
```

### 2.2 订单模型（迁移 007 `payment_orders`）

```sql
CREATE TABLE payment_orders (
  id TEXT PRIMARY KEY,              -- out_trade_no，同账本 paymentId
  user_id TEXT NOT NULL REFERENCES users(id),
  task_spec TEXT NOT NULL,          -- {prompt, modelId} JSON（支付成功后创建任务）
  amount_cny REAL NOT NULL,         -- 预估费用上限 R（分精度）
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|closed
  task_id TEXT REFERENCES tasks(id),       -- 支付成功后落任务 id
  created_at TEXT NOT NULL,
  paid_at TEXT,
  closed_at TEXT
);
```

- 流程采用「**支付成功后创建任务**」：订单只存任务参数，回调成功才 `createTask + runTask`——不改任务状态机，恢复逻辑零改动；任务创建+预留仍同一事务。
- `pending` 订单 15 分钟未支付自动关单（调微信关单 API + 本地 `closed`）；关单任务参数作废，用户重新发起。

### 2.3 充值链路

1. **下单**：`POST /api/v1/payments/wxpay/orders`（登录后）→ 校验任务参数与限额（复用 `assertCanCreateTask`、硬上限）→ 建订单（pending）→ 调微信 `POST /v3/pay/transactions/native`（金额分，`out_trade_no` = 订单 id）→ 返回 `code_url` + 订单 id，前端展示二维码并轮询订单状态。
2. **回调**：`POST /api/v1/payments/wxpay/notify` —— 验签（`Wechatpay-Signature` + 微信支付公钥）→ AES-256-GCM 解密 → 金额校验（回调 `amount.total` == 订单 `amount_cny`）→ 幂等（订单已 `paid` 直接返回 SUCCESS）→ `recordTopup`（+R）→ 订单落 `paid` → `createTask(reserveCny=R) + runTask`。返回 `200 {"code":"SUCCESS"}`。
3. **兜底对账**：定时查单 `GET /v3/pay/transactions/out-trade-no/{id}` 补回调丢失；日终 `GET /v3/bill/fundflowbill` 与账本逐笔核对。

### 2.4 差额退款与退款链路

- 任务终态钩子：settle 后计算差额，`>0` 时 `recordRefund(db, userId, R−A, outTradeNo, 'diff:{taskId}')`；真实模式再调 `POST /v3/refund/domestic/refunds`（`out_refund_no = diff:{taskId}`），退款成功回调/查单确认后不改账本（入账已在发起时记，失败则冲正重试）。
- 幂等键 `refund:{paymentId}:{refundId}` 已为 `out_refund_no` 语义就绪。

### 2.5 上线前核对单

- [ ] 真实支付 1 元试单：下单 → 扫码 → 回调入账 → 任务执行 → 差额退款到账
- [ ] 同一 `out_trade_no` 重放回调不重复入账、不重复建任务
- [ ] 金额不一致的伪造回调被拒绝（验签/金额校验留痕）
- [ ] pending 超时关单：不产生任务、微信侧关单成功
- [ ] 回调丢失演练：查单兜底任务能补账
- [ ] 日终资金账单与 `ledger_entries` 全量核对一致
