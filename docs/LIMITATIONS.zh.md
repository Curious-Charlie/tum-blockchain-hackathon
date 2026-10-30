# 诚实的局限

[English](LIMITATIONS.md)

PayOnProof 跨两条链：发票的钱锁在 Base Sepolia（EVM）上的 `InvoiceEscrow` 合约里，Keeper 的服务费在 Cardano preprod 上支付。下面逐项说明每一部分能保证什么、不能保证什么。

## 1. 按次 x402：没结算的服务费在 Keeper 手里

按次模式（`--x402`）下，每次尝试都附带一笔 Lena 的 agent 已经签名、但还没提交上链的服务费。Keeper 一边查汇率、执行，一边拿着这笔签好的交易；发票付成功（HTTP 200）后才提交。条件不满足就回 409，这笔交易永远不提交，Lena 一分钱不付。

薄弱的一方是 Keeper：

- **签好的服务费只在约 10 分钟内有效**（报价后 `maxTimeoutSeconds` = 600 秒）。够一次尝试用，撑不起盯盘几个小时的任务。
- **Lena 可以在结算前双花。** Keeper 提交之前，这笔交易要花的币仍在 Lena 手里。不诚实的买方可以在 Keeper 付完 gas、供应商已经收款之后，抢先把其中一笔花掉，服务费交易随之失效。

## 2. 解决办法，现在是默认模式：服务费先锁进 Masumi escrow

默认情况下，Lena 的 agent 在 Keeper 开工前，先把服务费锁进 Cardano 上 Masumi 的托管合约（`vested_pay`，payment V2）。Keeper 面对的是已经锁定的钱，所以没有 10 分钟的有效期，也没有可以双花的东西。Keeper 按周期盯着订单；条件满足就在 Base Sepolia 上执行，把结果哈希写进 escrow，过了解锁时间再领钱。在盯盘时间内条件一直不满足，它就授权退款，Lena 立即取回；Keeper 失联，Lena 过了提交结果的截止时间也能取回。放款和两种退款都在 preprod 上真实跑过（交易见 [app README](../cardano/apps/payonproof/README.md#evidence)）。

escrow 自己的代价：

- **要等。** 按 Masumi 规则允许的最短截止时间，Keeper 在报价后 32 分钟才能领钱；Keeper 失联时，服务费 17 分钟后才能退回。盯盘时间最长约 13 分钟；要盯更久，截止时间就得更长，领钱也随之更晚。
- **后面的交易要有人发。** 领钱和超时退款都是单独的交易（`npm run escrow -w apps/payonproof -- finish --wait`），不会自动发生。
- **escrow 不检查结果。** Masumi 的合约只存 Keeper 写进去的结果哈希，它看不到 Base Sepolia。这个哈希绑定了 `execute` 交易和其中的 `InvoicePaid` 事件，任何人都能核对（`npm run check -w apps/payonproof -- <收据交易>`）；但假哈希要靠人或 agent 在争议期内发现，合约本身发现不了。Lena 发起争议的路径（`SetRefundRequested`，再由 Masumi 管理员裁决）没有接。

## 3. 哪一笔分账由谁执行

- **发票付款：合约执行。** `InvoiceEscrow` 在同一笔交易里，按 `欧元金额 × 签名汇率` 付给订单里写死的供应商，押金剩下的退给 Lena。Keeper 和 AI 都改不了收款方和金额。
- **Keeper 的服务费：合约执行，但结果哈希由 Keeper 自己写。** 钱什么时候能动（解锁后领取、授权后或截止后退款）由 Masumi escrow 决定；Keeper 是否真的执行了，靠的是 Keeper 自己写的结果哈希，任何人都能核对，但 escrow 核对不了（见第 2 条）。
- **没有任何分账由 agent 单独执行。** 除了这两个合约和 AgentGuard 的上限，没有 agent 自己转钱。

## 4. Keeper 的信誉从哪里来

Lena 的 agent 只用公开的链上数据算每个 Keeper 的记录：Keeper 在 Cardano 上的 CIP-20 收据（由它自己的地址签名的交易），每张收据都去 Base Sepolia 核对它所写的 `InvoicePaid` 事件（合约对、订单对、执行者是这个 Keeper 的 EVM 账户，Keeper 用签名证明这个账户是它的）。没有任何预设数据。局限：

- 只计成功交付。退款和失联在链上看得到（escrow 交易），但还没有记进 Keeper 的记录。
- Keeper 可以执行自己下的发票来刷记录。试用规则（新 Keeper 在有 2 次已核验执行之前，只能接 €250 以下的发票）能拖慢这种做法，但挡不住。
- 收据只扫描 Keeper 最近 100 笔 Cardano 交易。

## 5. 周末外汇休市

外汇市场周五晚上收盘，Nodary 的 EUR/USD 可能在 UTC 22:00 左右之后停止更新。合约接受最多 3 天前的汇率（`maxRateAge`），而签名响应本身必须在 5 分钟以内，所以周末 Keeper 照样能执行，用的是周五的收盘价。那是市场最后的价格，不是实时价格；急着付的款可以接受，其他情况付款人可能宁愿等开盘。收盘后的实测结果见 [app README](../cardano/apps/payonproof/README.md#weekend-fx)。

## 6. 其他局限

- **签名只能证明是谁说的，不能证明说的是真的。** Lena 仍然要信任 Nodary 给的 EUR/USD。Keeper 执行前会再买一个签名汇率（AirnodeHub 上的 Frankfurter），两者相差超过 1% 就不执行；但这道核对在 Keeper 里，不在合约里，合约接受任何有效的 Nodary 响应。另外，在 5 分钟的窗口内，Keeper 可以从几个签名汇率里挑对自己有利的；窗口越短，可挑的余地越小。
- **两条链之间没有桥。** 服务费（Cardano）和付款（Base Sepolia）靠哈希和收据关联，不靠跨链消息。
- **测试币。** dUSD 是演示用的稳定币；全部运行在 Cardano preprod 和 Base Sepolia 上。
