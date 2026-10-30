# 设计文档: Cardano 赛道，三个设计并行

> 2026-10-30 11:15 更新。给人看的完整设计；Claude 需要细节时读对应章节。给 Claude 的操作手册是根目录的 `CLAUDE.md`。

## 0. 战略

- **主攻 Cardano 赛道**（€6k: 3k / 2k / 1k）。BSV 放弃。
- 一套共同地基（Phase 0），上面**并行做三个设计**（D1、D2、D5）。周五 18:30 内部路演，用户选一个提交。
- 只有 D1 胜出时才顺带报 API3（€2k）。
- 每队只能交一个项目，所以没胜出的设计留在各自的分支里，不进最终提交。

---

## 1. 新手概念速查

| 概念 | 白话 |
|---|---|
| 测试网 (preprod) | Cardano 的练习账本，用免费的玩具钱 |
| 钱包 / 助记词 / 地址 | 助记词是万能密码，只存在 `.env`；地址相当于银行账号，可以公开 |
| tADA / tUSDM | 测试 ADA / 测试美元稳定币，从 Masumi dispenser 免费领 |
| 交易 / tx hash | 一次转账 / 它的回执单号，在 cardanoscan 上谁都能查 |
| **x402** | API 的自动售货机。服务端回 402 并报价，客户端签一张付款单再请求一次。**付款单签好后先不上链: 服务端干成了才提交上链，干砸了（返回错误）就作废，不扣钱** |
| Facilitator | x402 的"收银员"，检查付款单，并把它提交上链。我们把它内置在服务里 |
| **交易元数据 (CIP-20)** | 每笔交易可以附一段公开文字，永久可查。我们用它"发表"记录，比如复现证书 |
| Masumi escrow | Cardano 上的托管合约: 钱先锁住，交付后放给卖方，没交付就退给买方 |
| Sokosumi | 基于 Masumi 的 agent 市场，agent 在上面被雇佣 |

---

## 2. Cardano 评委看什么（每个设计都按这张表打分）

**资格（必须满足）**: 在 Cardano preprod 上至少完成一次付费任务（Masumi）或付费请求（x402），并提交交易哈希。

**提交材料**: 视频里讲清楚给谁用、什么问题、商业模式，并完整演示一次付费流程；描述里讲清楚怎么工作、用了哪些 Cardano 工具、现实中怎么跑。

**评分**: 原创用例、端到端跑通的付费流程、用 Cardano 工具的技术实现、创意、用户体验、pitch 和 demo 是否清晰、现实影响、赛后能否继续。**特别想看到**:
1. 清晰的客户、他的使用旅程，以及他愿意付钱的 agent 任务
2. **付款和结果挂钩**: escrow、退款、只为通过检查的工作付钱
3. **agent 雇 agent**，或者在现实世界里行动（购买、发布、预订）
4. 现场演示一次付费任务，并在 preprod 浏览器上展示交易

---

## 3. Phase 0: 共同地基（含 D4 AgentGuard）

由主 session 按顺序完成。地基稳定之后才开始并行，否则三个分支会各写各的地基，最后合不起来。

### 3.1 目标目录结构

```
cardano/
  package.json            npm workspaces
  packages/core/          共同地基（只有主 session 改）
    config.ts             读 .env、网络常量、Blockfrost provider
    wallets.ts            按角色创建和读取钱包、查余额（替代 scripts/wallets.ts）
    seller.ts             x402 卖方工具包: 内置 facilitator + 定价（tADA / tUSDM）+ 失败不结算
    guard.ts              ★ D4 AgentGuard: 买方钱包和消费策略
    publish.ts            用 CIP-20 元数据把一条记录写上链
    claude.ts             Anthropic 客户端（Sonnet / Haiku）、简单的 tool-use 循环
    events.ts             事件总线（谁付了谁、多少钱、tx hash）+ SSE 推送
    dashboard/            通用演示页: 事件时间线 + 资金流向图 + cardanoscan 链接
  apps/
    payonproof/           D1
    checkedfacts/         D2
    reprobounty/          D5
```

### 3.2 D4 AgentGuard（所有买方 agent 都用它付钱）

把钱包交给一个 AI 很危险，所以 agent 的每一笔付款都要先过 AgentGuard:
- **预算**: 每个任务和每天各有上限
- **单笔上限**: 一次最多付多少
- **收款方白名单**: 只能付给允许的服务（防止被提示词注入诱导，把钱转给攻击者）
- **审计日志**: 每笔付款（或被拒绝的付款）都写进 JSONL 并推送到 dashboard
- **一键冻结**（kill switch）

用法: `guard.fetch(url)` 直接替代普通的 `fetch`，遇到 402 时自动检查策略、签名、付款。

### 3.3 Phase 0 验收标准

- `npm run smoke` 改写到 core 上，仍然返回 200 并拿到 tx hash
- AgentGuard 的策略有单元测试: 超预算、超单笔上限、收款方不在白名单时都会拒绝
- `publish.ts` 在 preprod 上发出一笔带 CIP-20 元数据的交易，在 cardanoscan 上能看到这段文字
- dashboard 能实时显示 smoke 测试的事件
- 三个设计的 app 目录骨架已经建好，每个都有自己的 `.env.example` 和钱包角色列表

---

## 4. 三个设计

每个设计的 **MVP 验收标准相同**，方便公平比较:
1. 一条命令跑完整个流程，preprod 上至少一笔已结算的交易
2. 能演示"失败不收钱"或"退款"那条路径
3. dashboard 上能看到资金流向和 tx 链接
4. 在 app 目录的 README 里写一段 60 秒的演示脚本

### D5 ReproBounty: 复现赏金（学术方向）

**一句话**: 付钱让 agent 复现一篇论文的结果。它花钱买算力去运行作者的代码，结果由另一个 agent 抽查；**通过抽查才付钱，复现证书发表在 Cardano 上**。

**为什么做这个**: 复现危机（Nature 2016 年的调查: 超过 70% 的研究者复现过别人的实验但失败了）。复现工作几乎没人付钱，也没处发表。期刊确实需要这项服务，比如美国经济学会（AEA）有专门的 data editor，每篇论文发表前都要检查能不能复现。

**角色与钱包**:

| 角色 | 做什么 | 钱包 |
|---|---|---|
| Requester（期刊 / 基金方 / 课题组） | 发赏金，付复现费 | requester |
| Replicator agent | 读论文、提取数字结论、组织复现、出报告 | replicator（收赏金，付算力费和核验费） |
| Compute agent | 卖算力: 按次运行代码，返回输出 | compute |
| Verifier agent | 检查证据包是否完整、可信 | verifier |

**流程**:
1. Requester 调用 Replicator 的付费端点（x402，比如 5 tUSDM），提交论文链接、代码仓库、要复现的结论（如"表 2 第 3 列"）
2. Replicator 用 Claude 读论文，把目标结论提取成结构化的数字（名称、值、容差）
3. Replicator **付钱给 Compute agent**（x402，经 AgentGuard），在隔离的临时目录里运行作者的代码（有超时、不带任何密钥），拿回输出文件和日志
4. Replicator 逐个比对数字（确定性的数值比较，Claude 只负责把输出对应到论文里的哪个结论），给出结论: 复现成功 / 部分成功 / 失败
5. Replicator 打包证据: 代码的 commit hash、输入和输出文件的哈希、运行日志、比对表，并计算证据包哈希
6. Replicator **付钱给 Verifier agent**。Verifier 检查哈希是否一致，再抽查重跑一步，确认结果可以重现
7. 抽查通过 → Replicator 返回 200 → Requester 的付款结算 → Replicator 用 CIP-20 元数据把**复现证书**发表上链（论文 DOI、结论、证据包哈希、Verifier 地址）
8. 抽查不通过 → 返回 4xx → Requester 一分钱不付

**关键设计**: **付钱给"验证过的尝试"，不付钱给"想要的结论"**。复现失败也照样付钱，否则 agent 会有动机把结果造成"复现成功"。而且"复现不了"本身就是有价值的结果，学术界一直苦于负面结果没处发表。

**Demo 素材**: 一篇有公开代码和数据、几秒钟就能跑完、结论是数字表格的真实小论文。再准备一个故意改错一个数字的版本，用来演示"复现失败，但仍然付费并发表"。选论文是 D5 分支的第一个任务。

**风险与对策**:
- 运行别人的代码有安全风险 → MVP 只运行我们挑好的仓库，临时目录 + 超时 + 清空环境变量。真正的沙箱（容器）写进 roadmap
- 安装依赖很慢 → demo 用的论文环境提前装好

**加分点**: 三个 agent 互相雇佣、按次付费；付款和"验证通过"挂钩；证书发表在链上（"publishing"正是评委列出的现实世界行动之一）。

### D2 CheckedFacts: 先核实、后付款的调研

**一句话**: 小店老板付钱买一份竞品调研。调研 agent 写完后**自己花钱雇核查 agent 逐条核对来源**，核查通过率达标才收费。

**角色**: Customer（店主）/ Research agent（Sonnet + 联网搜索）/ Fact-checker agent（Haiku + 网页读取，按条收费）

**流程**:
1. 店主用 x402 请求一份报告，比如"慕尼黑精品咖啡的竞争格局"
2. Research agent 联网调研，每条结论都附上来源 URL 和原文引用
3. Research agent 付钱给 Fact-checker，按批核查: 打开来源，看原文里是否真有这句话、是否支持这条结论
4. 通过率 ≥ 阈值（如 90%）→ 返回 200 和报告（附核查表）→ 结算
5. 不达标 → 返回 4xx → 不收钱

**风险**: 网页抓取不稳定 → 来源失效的那条只算"无法核实"，不算"造假"；缓存所有抓取结果。

### D1 PayOnProof: 条件付款 Keeper

**一句话**: Lena 的财务 agent 雇 Keeper，在 EUR/USD 低于 1.11 时替她付一张欧元发票。合约用 API3 签名汇率验证条件并计算付款金额；**Keeper 只有执行成功才收到 Cardano 上的服务费**。

**结构**: Base Sepolia 上的发票托管合约（验证 API3 签名、计算金额、放款），加上 Cardano 上的 x402 服务费（每次轮询附一张付款单，条件没到返回 409，不扣钱）。数据用 Nodary EUR/USD（免费、不限量）。

**独特之处**: 唯一能顺带报 API3 赛道的设计（多一次拿 €2k 的机会）。

**代价**: 需要写合约，工作量是三个设计里最大的。Cardano 在这个设计里只是收费通道，评委可能觉得"Cardano 的戏份少"。

完整的合约和流程设计见 git 历史里的上一版 DESIGN.md（commit `f22a5a8`）。

---

## 5. 周五 18:30 选择评分卡

每项 1–5 分，由用户打分:

| 维度 | 权重 | 说明 |
|---|---|---|
| 客户和付费任务是否清晰 | ×3 | Cardano 评委的第一条 |
| 付款和结果挂钩的力度 | ×3 | Cardano 评委的第二条 |
| demo 稳定性 | ×3 | 现场一失败就全完了 |
| agent 雇 agent / 现实世界行动 | ×2 | |
| 原创性 | ×2 | |
| 你讲得有没有底气 | ×2 | 周六你要上台讲 |
| 能否顺带报其他赛道 | ×1 | 只有 D1 能报 API3 |

## 6. 胜出后的升级清单

1. **Masumi escrow**: 付款先锁进 Cardano 托管合约，交付后放款，超时自动退款（参考 `reference/x402-cardano-demo/masumi/`）
2. **上架 Sokosumi**: 让 agent 能在 Cardano 官方的 agent 市场被雇佣（用 TUM workspace）
3. 打磨 dashboard，写 README、录视频
4. 如果 D1 胜出: 部署 API3 合约并完成 tamper test

## 7. 明确不做

BSV 赛道、电商 listing 的 agent 团队（已否决）、主网、移动端、复杂的账号体系、真实的容器沙箱（只写进 roadmap）。
