# 0.1.5 接口核对

依据：游戏前端 0.2.62 / 20260916.2，下载并格式化的公开前端。仅检查公开前端，不调用真实账号的购买、挑战或领取接口。

## 系统行商

- `GET /api/market/orders?scope=merchant&orderType=sell&sort=price&currencyType=gold&itemType=material&limit=30`，继续页使用 `cursor`。`data.items` 为订单，`hasMore` / `nextCursor` 表示分页。
- 只允许 `source: npc`、`status: active`、金币、材料、正确 `itemKey` 的订单；不能用展示名称代替物品标识。
- `POST /api/market/buy`：`{orderId, quantity}`。NPC 的 `quantity` 是份数，上限 99；每份物品数为 `amount`，每份价格为 `price`。
- 原版购买行 `m8`（35788 行附近）使用 `t.amount * T` 显示实际件数；定价 `n0`（35592 行）对 NPC 使用 `t.price * n`。
- 0.1.2 错用了 `/api/npc-shop/buy` 元宝兑换渠道。0.1.3 改为行商金币订单，并按份量精确凑齐强化石 1000、洗练石 1000、高级强化石 999 个。购买前核对总余额、价格与份量；失败不自动重发。

## 试炼之塔

- `POST /api/client/view-sections`：`{sections:["tower"]}`，返回 `data.tower`。
- 状态含 `unlocked`、`blockedReason`、`highestFloor`、`nextFloor`、`capped`、`floors`、`challengeOptions.skills`。
- `floors[].status` 仅 `available` 可挑战（游戏 hS，19330 行附近）。
- `POST /api/tower/preview` 与 `/api/tower/challenge` 使用 `{floor,selectedSkillKeys,buffKey,affixKey}`，原版默认前三个技能、buff/affix 为 `none`。
- 挑战响应 `data.battle.events` 的第一个 `victory` / `defeat` 是终局结果（Fy，19298 行附近）。动画是前端回放；无须额外写入结算。

## 免费奖励领取

- 公会状态：`GET /api/guild/view`；仅处理 `joined === true` 时的 `dividendPreview.eligible === true`（`POST /api/guild/claim-dividend`，空 body）和 `progressRewards[].canClaim === true`（`POST /api/guild/claim-progress`，`{point}`）。已领取、未解锁和付费/兑换操作均排除。
- 活动状态：`POST /api/client/view-sections`，`{sections:["quests","achievements","codex"]}`；仅处理 `canClaim === true && claimed !== true` 的任务、成就和图鉴奖励，分别调用 `/api/quests/claim {questKey}`、`/api/achievements/claim {achievementKey}`、`/api/codex/claim {rewardKey}`。
- 每日活动还检查 `retention.signIn` 的当日未领取状态并调用 `/api/retention/sign-in`，以及按服务器每日进度计算已达成且未在 `daily.claimedActivity` 中的 20/40/60/80/100 活跃箱，调用 `/api/daily/claim {point}`。
- 活动页的推币场只读取 `/api/arcade/coin-pusher/view`，在 `global.canClaim` 或 `guild.rewards[].canClaim` 为真且未领取时分别调用 `/api/arcade/coin-pusher/claim-global` 或 `/api/arcade/coin-pusher/claim-guild {point}`；不开始推币、不调用其他小游戏、彩票、市场兑换、捐献、购买或红包接口。每个领取请求使用幂等键，响应异常不自动重发。
- 首领征伐：个人首领和地图首领使用 `POST /api/boss/challenge`（`{bossKey,difficulty,selectedSkillKeys,buffKey,affixKey,targetSlot?,useMaterialBoost?}`）；世界首领协作继续使用 `POST /api/boss/assist {bossKey}`。助手按首领类型分组，个人首领可设置追加挑战次数，地图首领支持多选和一键全选。
- 系统邮件批量领取使用 `POST /api/mail/claim-all`，只在邮件存在未领取附件时提交，并使用幂等键；邮件状态来自 `/api/client/bootstrap` 的 `mails`。
- 胜利后重新读取 tower 再挑战下一层。缺少终局、楼层未推进、网络异常、失败、达到目标、未解锁或封顶均停止。

测试使用真实 Electron DOM 事件与请求封装，模拟响应不代表真实账号交易验证。
