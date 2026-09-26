# 微信支付接入：商户资格核实清单与接入设计（P6）

> 核实时间：2026-09-26，依据微信支付商户平台/商户文档（普通商户直连模式）。
> 目标：以最小改动把 `mock-topup` 替换为带签名验证的服务商回调，账本入账语义（`biz_key` 幂等）不变。

## 1. 商户资格核实清单（线下办理，先于开发）

| 事项 | 要求 / 结论 | 状态 |
| --- | --- | --- |
| 主体类型 | 线上 SaaS 不适用小微商户（仅限线下行业）；需 **个体工商户**（营业执照+经营者身份证）或 **企业**（营业执照+法人身份证） | 待定 |
| 经营类目 | 「软件/建站/技术开发」等 IT 服务类目，标准费率一般 0.6%（以签约页对照表为准） | 待核实 |
| 入驻流程 | pay.weixin.qq.com 普通商户入驻 → 提交资料 → 账户验证（法人微信授权或对公打款 0.01~1 元）→ 审核 48h 内 → 在线签约 | 待办 |
| 场景绑定 | 商户号需绑定 APPID（公众号 / 小程序 / 开放平台应用之一）——本项目 Web 端建议 **Native 扫码支付**（无需 openid），需一个已认证的开放平台/公众号 APPID | 待办 |
| 开发参数 | 商户号 `mchid`、APIv3 密钥、商户 API 证书序列号 + 私钥（apiclient_key.pem）、设置 HTTPS 回调域名 | 待办 |
| 结算 | T+1 自动结算至对公/对私结算账户；可下载资金账单对账 | 了解 |
| 合规风险 | **「充值余额」模式可能被认定为预付费/预付卡业务**（《单用途商业预付卡管理办法》要求备案）。两个选项：(a) 按单支付（每次创建任务直接支付该单预估，余额仅作记录）；(b) 保留余额制并评估备案要求。**接微信支付前必须先定** | **待决策** |

## 2. 技术接入设计（代码侧，资格就绪后实施）

### 2.1 配置项（.env，全部服务端保密）

```
PAYMENT_PROVIDER=wxpay          # 空=关闭真实支付（仍可用 mock 测试）
WXPAY_MCHID=1900000000
WXPAY_APPID=wx8888888888888888
WXPAY_API_V3_KEY=<32位 APIv3 密钥>
WXPAY_CERT_SERIAL=<商户证书序列号>
WXPAY_PRIVATE_KEY_PATH=./certs/apiclient_key.pem
WXPAY_NOTIFY_URL=https://<域名>/api/v1/payments/wxpay/notify
```

### 2.2 充值链路（替换 mock-topup 的生产路径）

1. **下单**：`POST /api/v1/payments/wxpay/native`（登录后）→ 服务端调微信 `POST /v3/pay/transactions/native`（金额单位分，`out_trade_no` = 前端生成的 `paymentId`）→ 返回 `code_url`，前端展示二维码。
2. **回调**：`POST /api/v1/payments/wxpay/notify` —— 必做四件事后才能入账：
   - 验签：`Wechatpay-Signature` 头 + 微信支付公钥/平台证书（防伪造回调）；
   - AES-256-GCM 解密报文（`resource` 字段，用 APIv3 密钥）；
   - 金额校验：回调 `amount.total`（分）必须等于本地订单金额（防篡改）；
   - 幂等入账：`recordTopup(db, userId, amountCny, out_trade_no)` —— `biz_key = topup:{paymentId}`，重复回调 `{ recorded: false }`，与 mock 语义完全一致；
   - 返回 `200 {"code":"SUCCESS"}`；非 SUCCESS 微信将按衰减频率重试。
3. **兜底对账**：定时任务（如 5 分钟）对「已创建未到账」订单调 `GET /v3/pay/transactions/out-trade-no/{out_trade_no}`，防回调丢失；日终下载资金账单 `GET /v3/bill/fundflowbill` 与 `ledger_entries` 逐笔核对。

### 2.3 退款链路

- 调 `POST /v3/refund/domestic/refunds`，`out_refund_no` = 本系统 `refundId`，`out_trade_no` = 原充值 `paymentId`；
- 退款成功回调/查单确认后调用现有 `recordRefund(db, userId, amountCny, paymentId, refundId)` —— 幂等键 `refund:{paymentId}:{refundId}` 已为微信 `out_refund_no` 语义就绪（2026-09-26 加固）。

### 2.4 路由与开关关系

- `registerPaymentRoutes` 保持 `mock` / 真实两条路径：`PAYMENT_PROVIDER=wxpay` 时 mock 端点继续受 `ENABLE_MOCK_PAYMENTS` 控制（默认 403），真实端点生效；生产建议 `PAYMENT_PROVIDER=wxpay` 且 `ENABLE_MOCK_PAYMENTS` 不设。
- 账本契约零改动：`topup`/`refund` 的 `biz_key`、余额口径、对账测试全部复用。

### 2.5 上线前核对单

- [ ] 真实充值 1 元试单：回调验签通过、账本入账、余额正确
- [ ] 同一 `out_trade_no` 重放回调不入账
- [ ] 金额不一致的伪造回调被拒绝（验签/金额校验日志留痕）
- [ ] 退款 1 笔 + 重放退款通知，余额与账本对上
- [ ] 回调丢失演练：关闭回调模拟，兜底查单任务能补账
- [ ] 日终资金账单与 `ledger_entries` 全量核对一致
