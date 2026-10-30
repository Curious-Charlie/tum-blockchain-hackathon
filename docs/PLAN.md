# 作战计划（内部文档）

> 2026-10-30 09:45 制定。截止 2026-10-31 (六) 15:00，剩约 29 小时。

## 决策: 主攻 Cardano，同一个项目兼报 API3，放弃 BSV

**关键规则**: 每队只能提交**一个项目**，最多报 3 个赛道。所以三个赛道不是三个独立项目，而是让**同一个项目**同时满足多个赛道的资格要求，每多满足一个就多一次拿奖机会。

| | Cardano €6k | API3 €2k | BSV €4k |
|---|---|---|---|
| 零基础友好度 | **高**。官方原话"你不需要是区块链开发者"，x402 模板现成，完成一笔 preprod 付款就达标 | **中**。要写 Solidity，但 starter 已经写好签名验证，4 种 tamper test 的测试也有 | **低**。核心必须是 DeFi 产品（swap/众筹/跨链），还要 non-custodial、BSV 专用钱包，测试币要私信 DevRel 要 |
| 竞争 | 高（奖金最大，做 AI 的人都会来） | **低**（Solidity + 严格的 tamper test 会筛掉很多队） | 中低 |
| 评分重点 | 清晰的客户和商业模式、**按结果付款**（escrow/退款/只为通过检查的工作付钱）、agent 雇佣 agent、现场演示 preprod 交易 | 真实用例 40%、签名数据必不可少 30%、执行 20%、新颖 10%，**自主 agent +10** | DeFi 采用潜力、BSV 栈使用、non-custodial |
| 和其他赛道的协同 | **都用 x402**: agent 在 Cardano 上收钱，在 AirnodeHub 上花钱买数据 | 同左 | 技术栈和另外两个不重合 |

**保底顺序**: 先让 Cardano 达标（目标周五晚上），再做 API3（目标周六早上）。就算 API3 没做完，Cardano 也有效，押金也能退（押金要求至少在一个合作方赛道提交）。

## 推荐方案（待确认）: "Don't trust your agent. Verify it."

**客户**: 需要"现实条件满足时自动执行链上付款/操作"的人或 agent，比如小商家或 DAO 财务（"ETH 跌破 X 时自动付款给供应商 / 换成稳定币"）。

**他们雇一个 keeper agent 盯着数据并执行，但有两个信任问题:**
1. **agent 会不会伪造数据乱执行？** → API3: 合约自己验证 AirnodeHub 签名数据，篡改值、过期数据、错误请求、错误签名者都会被合约拒绝（正好就是 tamper test）
2. **agent 没干成也收钱？** → Cardano: 付款和结果挂钩，只有链上执行成功后才结算，失败不收钱（Cardano 评委明确要的"pay only for work that passed a check"）

**两个赛道的加分点都能覆盖**:
- Cardano: 清晰的客户 + 按结果付款 + agent 在真实世界行动（可选：客户自己也是一个 agent → agent 雇佣 agent）
- API3: 签名数据是核心（伪造等于偷钱）+ 自主循环（定时拉数据、x402 付 aUSD 买数据、上链执行）→ +10

具体的付款机制（x402 按次 vs Masumi escrow）在方案确认后再定。

## 目录结构

```
README.md       提交用总 README（英文，评委看）
docs/           内部文档（中文）: 赛道规则、本计划
cardano/        Cardano 部分: agent 服务 + x402 收费（主攻）
api3/           API3 部分: Foundry 合约 + 提交签名数据的脚本（兼报）
bsv/            暂不参加（提交前如果没用上就删掉，免得评委看到空目录）
```

## 时间线

| 时间 | 任务 |
|---|---|
| 周五 10:00–11:00 | 账号和钱包（见下面"需要你本人操作的事"），我来装工具、跑通 x402 demo |
| **11:00 API3 workshop、12:00 Cardano workshop** | 建议去听这两场，当面问评委: 跨链组合（Cardano 收款 + EVM 合约验证）在各自赛道算不算数 |
| 周五 13:00–20:00 | Cardano 部分: agent + 收费端点，preprod 完成第一笔付费并保存 tx hash（**Cardano 达标**） |
| 周五 20:00–周六 02:00 | API3 部分: 合约 + 4 种 tamper test + 部署到测试网（**API3 达标**） |
| 周六 02:00–10:00 | 串联两部分 + agent 自主循环（API3 加分），中间睡觉 |
| 周六 10:00–13:00 | README、证据（tx hash、合约地址）、录 2.5 分钟视频 |
| 周六 13:00–14:30 | 填 Devfolio，仓库改成 public，**14:30 前提交**（留 30 分钟 buffer） |
| 周六 15:00–17:00 | 现场给 Cardano 和 API3 的评委分别演示 |

## 需要你本人操作的事（涉及注册、验证码、私密信息，我替你做不了）

1. **Cardano 钱包**: 装 Lace (https://www.lace.io) 或 Eternl (https://eternl.io) 浏览器插件，建一个测试用的新钱包，切到 **Preprod** 网络，去 https://docs.cardano.org/cardano-testnets/tools/faucet 领 tADA
2. **Blockfrost**: 注册 https://blockfrost.io ，建一个 **Cardano preprod** 项目，拿到以 `preprod` 开头的 project ID
3. **LLM API key**: agent 要调模型（Anthropic / OpenAI / 其他兼容 OpenAI 的都行）
4. **Devfolio**: 在 tum.devfolio.co 建项目，把队友加进去
5. （API3 阶段再做）Base Sepolia 测试 ETH 和 aUSD faucet

密钥直接写进对应目录的 `.env`（已在 .gitignore 里），不要贴到聊天里。

## 提交清单

- [ ] Devfolio 项目已建，队友已加
- [ ] 赛道选择: Cardano + API3
- [ ] Demo 视频 ≤ 2.5 分钟，要同时覆盖两个赛道的必备内容，**脚本要提前写**:
  - Cardano: 给谁用、什么问题、商业模式、一次付费任务/请求从头到尾 + preprod 浏览器上的交易
  - API3: 1 个有效响应触发链上操作，再演示 4 种响应被拒绝（改值 / 过期 / 错请求 / 错签名者）
- [ ] Devfolio 描述: 问题 / 做了什么 / 怎么实现的
  - Cardano: 工作原理、用了哪些 Cardano 工具、真实场景怎么跑
  - API3: 谁依赖这些数据、伪造的后果、在 AirnodeHub 上想要但没找到的数据
- [ ] 仓库改成 **public**，README 写清 setup/run
- [ ] Cardano preprod 付款 tx hash
- [ ] API3 合约地址 + 网络 + 让评委自己跑 tamper test 的脚本
- [ ] 检查 git 历史里没有 `.env` 和私钥
- [ ] 删掉没用上的 `bsv/` 目录
