# 时间线和提交清单

> 2026-10-30 11:15 更新。截止时间: **2026-10-31 (六) 15:00**，目标 14:30 前提交。为什么做这些见 `DESIGN.md`。

## 时间线

| 时间 | 阶段 | 内容 | 验收 |
|---|---|---|---|
| 周五 11:30–13:30 | **Phase 0 地基** | workspaces、core、AgentGuard、CIP-20 发表、dashboard 骨架（DESIGN §3） | DESIGN §3.3 |
| 12:00 | (用户) | Cardano workshop: 把三个设计讲给评委听，看他们更喜欢哪个 | |
| 13:30–18:30 | **Phase 1 并行** | 三个 worktree: `d1/payonproof`、`d2/checkedfacts`、`d5/reprobounty` | DESIGN §4 的 MVP 标准 |
| ~~18:30–19:30~~ | ~~内部路演~~ | **取消：12:40 已选定 D5 ReproBounty** | |
| 12:40–20:00 | **Phase 2（D5）** | ① 保底：main 上三条路径、冷启动 README、历史扫描、局限文档 ② 赏金接 Masumi escrow（20:00 前测试网跑通，否则写进 roadmap）③ Buyer：两个算力 agent 比价 | 每步都可提交 |
| 20:00–01:00 | 打磨 | dashboard、视频素材、Sokosumi（可选） | |
| 01:00–07:00 | 睡觉 | 必须睡，周六要上台 | |
| 周六 07:00–10:00 | 收尾 | 修 bug，把胜出分支合进 `main`，写 README | |
| 10:00–13:30 | 材料 | 2.5 分钟视频、Devfolio 描述 | |
| 13:30–14:30 | **提交** | 仓库改为 public（先问用户）、填 Devfolio、提交 | 14:30 前完成 |
| 15:00–17:00 | 现场评审 | 给 Cardano 评委演示（如果报了 API3，也去 API3） | |

**落后时的砍法**: 先砍 Phase 1 里进度最慢的设计 → 不做 Sokosumi 上架 → 不做 Masumi escrow（用 x402 失败不结算代替）。**地基和胜出设计的 MVP 不能砍。**

## 已完成

- [x] 赛道规则调研（`TRACKS.md`）
- [x] 私有 GitHub 仓库 `Curious-Charlie/tum-blockchain-hackathon`
- [x] 工具: pnpm、Foundry；两个官方 demo 的测试都通过
- [x] Cardano 钱包（买方、卖方各 100 tADA + 100 tUSDM），Blockfrost preprod 项目
- [x] **x402 端到端付款跑通**: `npm run smoke` 返回 200，已结算交易 `7c249bb8…`
- [x] EVM 钱包: Base Sepolia 0.0001 ETH + 10 aUSD（D1 用）
- [x] Anthropic API key 已验证（Sonnet 5.5、Haiku 5.5）
- [x] 用户已签到；Blockfrost、Coinbase CDP、Devfolio、Sokosumi 账号都已就绪
- [x] **Phase 0 地基完成（周五 11:30）**: npm workspaces + `@agentic/core`；smoke 经 AgentGuard 结算 `2df9839f…`；CIP-20 发表 `3186d09a…`；AgentGuard 9 个测试通过；dashboard 实时显示；三个 app 骨架和各自的角色钱包（付款角色已从 Masumi dispenser 领币）
- [x] **Phase 1 三个设计的 MVP 全部完成（周五 11:55）**，都在 preprod 上真实跑过成功和失败路径，各自 README 有 60 秒演示脚本:
  - D1 `d1/payonproof`: Base Sepolia InvoiceEscrow `0x63e2b722…`，服务费 `4a5300fe…`，Keeper 收据 `d578fe53…`；tamper 测试 4 种篡改全被拒
  - D2 `d2/checkedfacts`: 店主付款 `a43ea137…`，PASS 证书 `76e54008…`，FAIL 证书 `b81428cf…`（店主未付款）
  - D5 `d5/reprobounty`: 赏金 `a4b5a81d…`，证书 `80f0deef…`；`--altered` 证书 `38b977f7…`；`--tamper` 时 Requester 未付款
- [x] **Phase 2（周五 13:36）**: D5 合入 main，冷启动和历史扫描通过，局限文档中英文；Masumi escrow 赏金在 preprod 上跑通三条路径：
  - 锁定 → 放款：锁定 [1c7ab469…](https://preprod.cardanoscan.io/transaction/1c7ab46900668fd0a55931ed081636a73e95f1dbbbd729f2ac37600cc27e9721)，结果哈希 [4af00ea3…](https://preprod.cardanoscan.io/transaction/4af00ea37471f9314234c09e7b03b2377bc5e6caee00b1d8e65f20b6ae615e44)，证书 [ee93a1a8…](https://preprod.cardanoscan.io/transaction/ee93a1a8855e246e318977a584f55aeb80be8edb0add6868112b6c78d1a7b508)，解锁后 Replicator 领钱 [237ffb9f…](https://preprod.cardanoscan.io/transaction/237ffb9f344957df32dfd6d68cf5046d6a58d443417b3cc496bee0586cb59975)
  - 锁定 → 超时退款（`--vanish`）：锁定 [b46e99e4…](https://preprod.cardanoscan.io/transaction/b46e99e4b4408e741d966391869dea361d50dad91b3f0338a073c538994d0e69)，截止后期刊取回 [208664bc…](https://preprod.cardanoscan.io/transaction/208664bc753aa7aa8ad49e9d3a866564fd5ef71ac7528969f980a9d5383c89cb)
  - 锁定 → 授权退款（`--tamper`）：锁定 [5a60fe25…](https://preprod.cardanoscan.io/transaction/5a60fe254a2af44c791206126a81500aa69392b6173bbe4aaec30808a7e6708e)，Replicator 授权退款 [55955002…](https://preprod.cardanoscan.io/transaction/559550022adb6bf34e2b77c9daf3bef23db66f90dbb7f5bfb34da77c1a628fd5)，期刊立即取回 [237136cb…](https://preprod.cardanoscan.io/transaction/237136cb67bb1abba23e26f33c3cb9b8be66588955974262cfdde5bd2652a91e)
  - Buyer：三个算力 agent 比价，Replicator 按 AgentGuard 预算和口碑在代码里选择（口碑起点为预设数据）
- [x] **改为提交 D1 PayOnProof（周五 17:00），报 Cardano 和 API3 两个赛道**；D5 存档在 `d5/reprobounty` 和 `archive/d5-main`。D1 补上 core 的两个提交（cherry-pick），回归通过：
  - Coworker：Keeper 服务费先锁进 Masumi escrow，盯盘多个周期，执行后写入结果哈希（绑定 execute 交易和 InvoicePaid 事件）；锁定 [adcbd6fc…](https://preprod.cardanoscan.io/transaction/adcbd6fc3d078d233e1ff462ac90695dd3a394a5c065f77fb8bf22cfd2cad652)，Base Sepolia 执行 [0xe66ff958…](https://sepolia.basescan.org/tx/0xe66ff9582763a1a74b0bdb8865ce6a319e28ad92e194faeb7c2c7e75be08d38c)，结果哈希 [8d18c05e…](https://preprod.cardanoscan.io/transaction/8d18c05eca703f424efb687c90a6df182fb1ba6a040b87afbfe72eb6900ec0e2)，收据 [5e5a0eff…](https://preprod.cardanoscan.io/transaction/5e5a0eff49ab64355fa06eb79e6b0000c82a7a3279de44143a592eb87229bba3)；未满足条件的订单授权退款 [3778343d…](https://preprod.cardanoscan.io/transaction/3778343d6685fe19662d82a94c59454ee8f6c6b0d10dcc308e9f1bee10937bf0)，Lena 取回 [2e0105a5…](https://preprod.cardanoscan.io/transaction/2e0105a5d83aac9b3ac7509ecdbf933191f7d1e3d1b3e22277862999bfd654b1)
  - Buyer：三个 Keeper（2 / 1 / 4 tUSDM），记录从链上算（Cardano 收据对 Base Sepolia 的 InvoicePaid），试用规则 €250
  - API3 加分：autopilot 多张发票多轮自动执行；执行前用 x402 付 0.01 aUSD 买 Frankfurter 签名汇率交叉核对

## 提交清单（Devfolio）

- [ ] 在 Devfolio 建项目（队伍 CURIOUSCHARLIE），赛道选 Cardano（D1 胜出时加 API3）
- [ ] Demo 视频 ≤ 2.5 分钟: 给谁用、什么问题、商业模式、一次完整的付费流程、preprod 浏览器上的交易
- [ ] 描述: 问题 / 做了什么 / 怎么工作 / 用了哪些 Cardano 工具 / 现实中怎么跑
- [ ] 公开仓库 + README（setup 和 run 的步骤）
- [ ] preprod 上付费任务或请求的 tx hash
- [ ] 检查 git 历史里没有 `.env`、助记词、私钥
- [ ] 删掉最终提交里用不到的目录（没胜出的设计、`api3/`）
