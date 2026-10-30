# TUM Blockchain & AI Hackathon 2026: 赛道与提交规则

> 来源: https://hackathon.tum-blockchain.com/ (/prizes, /faq, /schedule)，抓取于 2026-10-30。
> 规则以官网为准，有疑问发邮件到 hackathon@tum-blockchain.com 或在 Telegram 群里问。

## 基本信息

| 项目 | 内容 |
|---|---|
| 时间 | 2026-10-30 (五) 09:00 开始，**10-31 (六) 15:00 截止提交** |
| 地点 | House of Communication, Munich，纯线下 |
| 主题 | Blockchain + AI，重点是 **agentic payments**（AI agent 支付） |
| 团队 | 1–5 人，可以单人参赛 |
| 奖金 | 三个合作方赛道共 €12,000，另有 TUM Blockchain Track 的 $16,000 审计额度 |
| 提交平台 | Devfolio (tum.devfolio.co)，每队提交一次，最多选 3 个合作方赛道 |
| 评审 | 周六 15:00–17:00 现场评审，要去你报名的每个赛道的评委那里演示 |
| 颁奖 | 周六 17:30 闭幕式 |
| 支持 | Telegram 群 https://t.me/+mY6aLKS8OnlhZjJk，现场有 mentor |

## 通用提交要求（所有队伍都要交）

1. **Demo 视频，最长 2.5 分钟**
2. **Devfolio 上的详细项目描述**：问题、做了什么、怎么实现的
3. **代码仓库链接 + README**（写清楚怎么安装和运行）。**截止前仓库必须设为 public**

提交步骤（官网 "How to submit"）:
1. 在 tum.devfolio.co 建项目，把所有队友加进去。官方建议周六早点建好、一直改，别拖到 14:55
2. 选最多 3 个合作方赛道（BSV / Cardano / API3）。TUM Blockchain Track 不用选，所有项目自动参评
3. 补齐视频、描述、公开仓库链接，以及每个赛道各自要求的额外材料（见下文）
4. 15:00 前提交，截止前可以一直修改

其他规则:
- 不能赛前开发。已有项目只有在比赛期间做了实质性扩展才算；核心部分必须在比赛期间完成
- 可以用开源库、starter 模板，也可以用任何 AI 编程工具
- IP 归团队所有
- **押金退还条件**：周四签到会议 + 周五签到黑客松 + 至少在一个合作方赛道提交项目（只参加 TUM Track 的话押金不退）
- TUM Blockchain Club 成员和合作方员工不能拿奖
- 密钥和私钥不要放进 prompt 或仓库

---

## 赛道 1: Cardano: Agentic Commerce on Cardano (€6,000)

**一句话**: 做一个能完成有用工作、并在 Cardano 上**收到报酬**的 agent、服务或开发者工具。

**奖金**: 1st €3,000 · 2nd €2,000 · 3rd €1,000

**背景**: Masumi 是建在 Cardano 上的 AI agent 支付网络（托管 escrow、链上身份、公开注册表），Sokosumi 是它的 agent 市场。

**两种收款方式**（可以都用）:
- **按任务付费 (Masumi on Sokosumi)**: agent 作为 "Coworker" 在 Sokosumi 上被雇佣，买家的钱先放在 Cardano 的 escrow 里，交付后才放款，没交付就退款
- **按请求付费 (x402)**: 每次调用 API/agent 都用 HTTP 402 "Payment Required" 当场付款，不需要账号和 API key。**x402 拿到第一笔付款更快**

agent 内部不一定要有 AI：需要写作或判断的任务调 LLM，固定流程（下单、取价格、计算）用普通代码就行。

**资格要求**:
- 一个能工作的 agent 或服务，在 **Cardano preprod** 上完成至少一次付费任务或付费请求

**额外提交**:
- preprod 上付费任务/请求的**交易哈希**
- 视频里要讲: 目标用户、问题、商业模式，并完整演示一次付费任务/请求
- 描述里要讲: 怎么工作的、用了哪些 Cardano 工具、真实场景下怎么运行

**评审标准**: 原创用例 + 端到端跑通的付费流程。看 Cardano 工具的技术实现、创意、用户体验、pitch 和 demo 是否清晰、现实影响、赛后能否继续。**Cardano 特别想看到**:
- 清晰的客户、用户旅程，以及客户愿意付钱的 agent 任务
- **付款和结果挂钩**: escrow、退款、只为通过检查的工作付钱
- **agent 雇佣其他 agent**，或在真实世界里行动（购买、发布、预订）
- 现场演示付费任务，并在 preprod 浏览器上展示交易

**示例想法**:
- 付费调研任务: 店主通过 Sokosumi 雇你的 agent 写一份简短调研报告
- 付费数据 API: x402 付款后返回有用的数据
- Agent 团队: lead agent 雇一个 specialist 优化商品详情（先跑通一次付费任务，再加更多 agent）

**上手步骤**:
1. 选 Masumi (按任务) 或 x402 (按请求)，用对应的官方指南和 starter
2. 按 starter 准备 Node.js、账号、模型访问、preprod 测试币
3. 完成一次付费任务/请求，保存 tx hash，README 写清楚安装步骤和限制

**资源**:
- 官方指南（先读）: https://www.masumi.network/tum-hackathon （agent 版: https://www.masumi.network/tum-hackathon/agent-guide.md ）
- Masumi starter: https://github.com/masumi-network/tum-hackathon-quickstart （Node.js 24，Sokosumi CLI 1.0.4，先读 README 和 AGENTS.md）
- x402 on Cardano: https://developers.cardano.org/x402/
- x402 模板: https://developers.cardano.org/templates/x402-express/ 、 https://developers.cardano.org/templates/x402-next/
- Sokosumi preprod 注册: https://preprod.sokosumi.com/signup
- Masumi dispenser（测试 ADA 和 tUSDM）: https://dispenser.masumi.network/
- Cardano 测试网 faucet: https://docs.cardano.org/cardano-testnets/tools/faucet
- Blockfrost preprod key（免费）: https://blockfrost.io
- x402 + Masumi 端到端 demo: https://github.com/cardano-foundation/x402-cardano-demo
- Masumi hackathon skill: https://www.masumi.network/tum-hackathon/skill/SKILL.md
- Masumi skills: `npx skills add https://github.com/masumi-network/masumi-skills --skill masumi`
- Sokosumi MCP server（OAuth 登录）: https://www.masumi.network/dev/sokosumi/mcp
- Cardano Developer Plugin (Claude Code/Codex): https://github.com/cardano-foundation/cardano-dev-skills

**评委/支持**: Bora Oben (Developer Community Advocate, Cardano)、Vladislav Kudrin (Web3 Solutions Architect, Cardano Foundation)。Masumi 工程师 1:1 预约: https://calendly.com/sandro-schaier/hackathon

**Workshop**: 周五 12:00–12:30 "Agentic Commerce on Cardano: get your agent hired and paid"

---

## 赛道 2: BSV Association: DeFi Rails for Agentic Payments (€4,000)

**一句话**: 在 BSV 链上做一个 **DeFi 层**，然后演示一个 AI agent 用它完成支付。

**奖金**: 1st €2,500 · 2nd €1,000 · 3rd €500

**背景**: agent 要买服务、调 API、为数据付费，BSV 的超低手续费让按次微支付可行。agent 缺的是金融层：可以用来支付的稳定价值、流动性、兑换和跨链转移。**DeFi 产品是核心**，agent 可以很简单（比如先兑换成对应 token，再付一次 API 调用费）。

**资格要求**:
- 用 BSV 官方开源 TypeScript 栈: **BSV SDK**，需要钱包功能时用 **Wallet Toolbox**（都在 ts-stack 里）
- 用户流程要接标准 BSV 钱包（**BSV Desktop** 或 **BSV Browser**），通过 WalletClient 接入；私钥不能离开钱包，不能向用户要私钥或助记词
- 在 BSV 上发**真实交易**（testnet 或 mainnet）
- 涉及资金时必须 **non-custodial**，不能由单方持有用户资产
- 至少一个 AI agent 用你的项目完成一次支付（简单的就行）

**额外提交**:
- WhatsOnChain 上的示例交易链接
- 视频: 端到端演示，包括 agent 支付
- 描述: 问题、目标用户、用户怎么用、给 BSV 带来什么

**评审标准**: 做一个让人和 agent 有理由使用 BSV 的实用 DeFi 产品，有明确的采用潜力，说明怎么给网络带来用户或流动性。看 BSV 栈的使用、技术实现、non-custodial 设计、真实的 agent 支付、原创性、demo 清晰度。

**示例想法**:
- Agent token swap: 接钱包的 demo 资产兑换，再让 agent 用它付款
- Service launchpad: 用桥接稳定币为 agent 服务做众筹流程（先跟 BSV 确认资产是否可用）
- 跨链注资（进阶）: 用 non-custodial 流程把资产转入 BSV 钱包。从零写桥工作量很大

**上手步骤**:
1. 看 ts-stack 文档、SDK 和钱包包，用文档里的版本
2. 下载 BSV developer pack，先读 START-HERE.md，把 AGENTS.md 复制到仓库根目录，主参考 BSV_STACK_COMPLETE_GUIDE.md（优先用 Appendix A 的测试过的代码）。starter/bsv21-token-kit 里有 38 个测试
3. 测试币: 把你的 BSV 地址和队名发给 BSV 支持联系人（Axel）
4. 通过 Arcade 广播交易，在 WhatsOnChain 上贴交易链接

**资源**:
- BSV developer pack: https://drive.google.com/drive/folders/179lAsiQEiV1Fpf9SY8b0y4456-3QfxfG?usp=sharing
- ts-stack 文档: https://bsv-blockchain.github.io/ts-stack/ ，GitHub: https://github.com/bsv-blockchain/ts-stack （旧的 ts-sdk / wallet-toolbox 仓库已被取代）
- 钱包: BSV Desktop https://desktop.bsvb.tech ，BSV Browser https://mobile.bsvb.tech
- Arcade 广播: https://arcade-v2-us-1.bsvblockchain.tech
- BRC 标准: https://github.com/bsv-blockchain/BRCs
- BSV-21 token 规范: https://docs.1satordinals.com/fungible-tokens/bsv-21
- 浏览器: https://whatsonchain.com ，https://bananablocks.com/tokens
- bOpen agent 插件（社区工具，与 dev pack 冲突时以 dev pack 为准）: https://bopen.ai/agents
  - Claude Code: `/plugin install bsv-skills@b-open-io`、`/plugin install 1sat@b-open-io`、`/plugin install bsv-mcp@b-open-io`

**评委/支持**: Axel Maisonneuve (Head of DevRel, BSV Association)，Telegram: https://t.me/lexamaison

**Workshop**: 周五 11:30–12:00

---

## 赛道 3: API3: Any API in your contract (€2,000)

**一句话**: "Real-world data. Checked by your contract." 做一个 app 或 agent，**核心链上功能依赖经过认证的 AirnodeHub 数据**。

**奖金**: 1st €1,000 · 2nd €600 · 3rd €400

**背景**: API3 做 oracle 基础设施。AirnodeHub 帮开发者和 agent 发现 API 并拿到**签名响应**，合约在使用前可以验证签名。由用户、keeper 或 agent 把响应带上链，合约验证**签名者、请求是否匹配、数据新鲜度**，然后用数据做有意义的决策或状态变更。**在不相关的项目里加一个 API 调用不算数。** 签名只能证明响应来自该 Airnode 且没被篡改，不能证明现实世界里的事实为真。

**资格要求**:
- AirnodeHub 集成必须是核心功能的关键部分，去掉之后应用会明显受损
- 把签名响应提交到已部署的合约，合约验证预期签名者、预期请求和时间条件（testnet 就行）
- 用绑定到该签名响应的值驱动有意义的链上操作或状态变更，需要时防止重复执行

**额外提交**:
- 已部署合约地址和网络
- 让评委能提交自己的响应的方式（通过 app 或有文档的脚本），用来跑 tamper test
- **视频里必须有 tamper test（pass/fail，不通过直接不合格）**: 先演示一个有效、及时的响应触发链上操作，再演示 **4 种被拒绝的响应**:
  1. 真实响应但改了一个值
  2. 真实响应但太旧
  3. 针对另一个请求的真实响应
  4. 不是预期 Airnode 的密钥签的响应
- 描述: 谁依赖这些数据、伪造会出什么问题、你想要但在 AirnodeHub 上没找到的数据

**评审标准**: 认证数据对核心流程真正重要的真实用例。看执行和原创性。tamper test 是 pass/fail 的资格门槛。**加分项**: 自主 agent 自己选数据、需要时通过 x402 付款，并在**多个周期里反复**上链执行。只有付款或只做一次 MCP 发现不算。

**示例想法**:
- 签名价格守卫: 用 starter 的 ETH/USD 响应决定允许或阻止一个链上操作，并演示必需的拒绝情况
- 条件支付: 只有经过验证的 AirnodeHub 数据满足条件时才释放测试资金（先选好 hackathon 推荐的 operation）
- 协议保护: 签名值越过阈值时更新合约状态，展示篡改/过期/错请求/错签名者都无法触发

**上手步骤**:
1. 看推荐集成和官方 starter（自带签名 ETH/USD 响应，可以直接作为第一个集成）
2. 按 starter 准备 **Foundry、Node.js、pnpm**；收费 operation 用活动 faucet 和支付说明
3. 部署一个会检查签名者、请求和新鲜度的合约，演示 1 个有效响应 + 4 个 tamper 失败

**资源**:
- Starter: https://github.com/api3dao/airnodehub-hackathon-starter （Nodary ETH/USD 签名响应的 consumer、logger、client 和验证测试）
- 挑战与 onboarding: https://api3dao.github.io/airnodehub-hackathon/
- Hackathon 文档: https://api3dao.github.io/airnodehub-hackathon/docs/
- 推荐集成: https://api3dao.github.io/airnodehub-hackathon/docs/integrations
- From API to contract: https://api3dao.github.io/airnodehub-hackathon/docs/from-api-to-contract
- Projections: https://api3dao.github.io/airnodehub-hackathon/docs/projections
- AirnodeHub 目录: https://airnodehub.api3.org/ （agent 说明: https://airnodehub.api3.org/llms.txt ）
- 产品文档: https://airnodehub-docs.api3.org/
- MCP server（无需账号）: https://airnodehub.api3.org/mcp ，设置: https://airnodehub-docs.api3.org/api-consumers/mcp
- 测试币: aUSD faucet https://api3dao.github.io/airnodehub-hackathon/faucet/ ，Circle 测试网 USDC https://faucet.circle.com
- 自然语言解析接口（免费）: `POST https://airnodehub.api3.org/resolve`

**评委/支持**: Ugur Schenk (Strategy Lead, API3)、Matej Falat (Software Engineer, API3)

**Workshop**: 周五 11:00–11:30 "Building with AirnodeHub"

---

## 附加: TUM Blockchain Track ($16,000 审计额度，自动参评)

- 所有在 Devfolio 提交的项目自动参评，不用选，也**不占** 3 个合作方赛道名额
- TUM Blockchain Club 评委选出全场 **最认真、最值得做安全审计继续发展的 3 个项目**
- 奖品由 Adevar Labs 提供，一年内有效: 1st $10K 审计额度 · 2nd Pre-Audit Core · 3rd Pre-Audit Express
- 评委: Benjamin Bosnjak、Zafar Nasimov (TUM Blockchain Club)

## 日程要点

- 周五 10-30: 08:00 开门 · 09:00 开始 · 09:30 开幕 · 11:00 API3 workshop · 11:30 BSV workshop · 12:00 Cardano workshop · 16:00 zk-SNARK workshop (Veronika Bauer, TUM) · 通宵开放
- 周六 10-31: **15:00 截止提交** · 15:00–17:00 现场评审 · 17:30 颁奖和闭幕
