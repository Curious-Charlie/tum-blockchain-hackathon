# 时间线和提交清单

> 2026-10-30 11:15 更新。截止时间: **2026-10-31 (六) 15:00**，目标 14:30 前提交。为什么做这些见 `DESIGN.md`。

## 时间线

| 时间 | 阶段 | 内容 | 验收 |
|---|---|---|---|
| 周五 11:30–13:30 | **Phase 0 地基** | workspaces、core、AgentGuard、CIP-20 发表、dashboard 骨架（DESIGN §3） | DESIGN §3.3 |
| 12:00 | (用户) | Cardano workshop: 把三个设计讲给评委听，看他们更喜欢哪个 | |
| 13:30–18:30 | **Phase 1 并行** | 三个 worktree: `d1/payonproof`、`d2/checkedfacts`、`d5/reprobounty` | DESIGN §4 的 MVP 标准 |
| **18:30–19:30** | **内部路演** | 逐个演示，用户用评分卡打分，选出胜出者（DESIGN §5） | 选定一个 |
| 19:30–01:00 | **Phase 2 打磨** | Masumi escrow、Sokosumi 上架、dashboard（DESIGN §6） | |
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

## 提交清单（Devfolio）

- [ ] 在 Devfolio 建项目（队伍 CURIOUSCHARLIE），赛道选 Cardano（D1 胜出时加 API3）
- [ ] Demo 视频 ≤ 2.5 分钟: 给谁用、什么问题、商业模式、一次完整的付费流程、preprod 浏览器上的交易
- [ ] 描述: 问题 / 做了什么 / 怎么工作 / 用了哪些 Cardano 工具 / 现实中怎么跑
- [ ] 公开仓库 + README（setup 和 run 的步骤）
- [ ] preprod 上付费任务或请求的 tx hash
- [ ] 检查 git 历史里没有 `.env`、助记词、私钥
- [ ] 删掉最终提交里用不到的目录（没胜出的设计、`api3/`）
