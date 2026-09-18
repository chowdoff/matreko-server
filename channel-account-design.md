# 渠道账号（ChannelAccount）服务端登记 — 设计方案

> 状态：**已落地**（2026-09-17；实现摘要与偏差见 §9）
> 需求来源：PRD P0-C-03 AC1、P0-C-18 AC1/AC15/AC18/AC19/AC20、P0-B-10 AC1、§6.1、§6.2；task.md T6-04
> 上位约束：backend.md §3.3 B（账号配置字段契约）
> 决策：**措辞口径统一为 P0-B-10 AC1「已添加的渠道账号」**（2026-09-17 确认）

---

## 0. 结论与范围

**问题**：主管端 `GET /api/supervisor/accounts` 目前用 `port_leases`（端口租约）反推账号列表，而端口租约**只在账号启动时产生**。于是「已添加但从未启动」的账号在服务端完全不存在，主管端看不到 —— 违反 P0-B-10 AC1 的字面要求（「已**添加**」）。

**方案（A）**：新增服务端 `ChannelAccount` 登记表 + 客户端全量对账接口。**只登记存在性元数据**（渠道、账号名、归属），代理 / 指纹 / 数据目录等**配置内容仍只存客户端本地**，不违反 P0-C-18 AC18「各设备账号配置互相独立、不做同步」。

**顺带修复**上一轮排查发现的 3 个缺陷（详见 §4）：
1. IM 账号页在线判定窗口 60s 与心跳周期 2min 矛盾（误判离线）
2. 主管端返回字段与前端 / 类型定义不匹配（状态列恒显示"离线"）
3. `PortLease.channelStatus` 无写入点（WAITING_QR / 权威 ONLINE 分支永不生效）

**不在本次范围**：客户端本地库改造（`matreko-client` 侧接入由客户端仓库自行排期）、`PortLease` 的历史数据清理（不物理删除，`RELEASED` 记录保留）。

---

## 1. 概念边界（先对齐语义）

| 概念 | 语义 | 载体 | 生命周期 |
|---|---|---|---|
| **渠道账号** | 客服配置的一个 IM 账号（渠道 + 别名 + 代理 + 指纹 + 数据目录） | 客户端本地 `port` 表（真相源）<br>**服务端 `channel_accounts`（仅登记）** | 添加即存在 → 直到删除 |
| **端口租约** | 账号**启动后**对团队端口的占用凭证 | 服务端 `port_leases` | 启动（acquire）→ 停止 / 超时回收（RELEASED） |
| **账号状态** | 账号当前跑没跑、跑得如何 | **派生值**（由租约 + channelStatus 计算） | 不落库 |

关键：**一个账号可以有 0..N 条租约历史，但任一时刻至多 1 条 HELD**。账号是主体，租约是它的一段时间线。此前实现把两者混在一张表里，才出现「未启动账号不可见」。

---

## 2. 数据模型设计

### 2.1 新增 `ChannelAccount`（channel_accounts）

```prisma
/// 渠道账号登记（服务端仅存「存在性元数据」；配置内容留客户端本地，P0-C-18 AC18）
model ChannelAccount {
  id               String    @id @default(cuid())
  teamId           String
  team             Team      @relation(fields: [teamId], references: [id])
  keyId            String
  licenseKey       LicenseKey @relation(fields: [keyId], references: [id], onDelete: Cascade)
  /// 归属客户端（= ClientCredential.clientId，确定性派生，同设备同密钥恒定）
  clientId         String
  /// 客户端侧稳定标识（客户端 port.id，单机内唯一）
  channelAccountId String
  channel          Channel
  /// 客服自定义别名（P0-C-18「账号名称」）
  accountName      String
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  /// 软删除（P0-C-18 AC15 删除账号配置）；主管端默认不展示
  deletedAt        DateTime?

  @@unique([clientId, channelAccountId])
  @@index([teamId, deletedAt])
  @@index([keyId])
  @@map("channel_accounts")
}

/// IM 渠道
enum Channel {
  TELEGRAM
  WHATSAPP
}
```

**唯一键为什么是 `(clientId, channelAccountId)`**

- P0-C-18 AC18 明确「多设备用同一密钥时各设备账号配置**互相独立**」→ `channelAccountId` 只在单机内唯一，`(keyId, channelAccountId)` 会在多开场景下误撞。
- 用 `clientId` 而非 `deviceFingerprintHash`：`clientId` 已在 2026-09-17 改造中改为**按 `(keyId, fingerprintHash)` 确定性派生**（backend §5.1.2），同设备重复激活恒定不漂移 —— 这正是登记记录不会因重新激活而"换主人"的前提。若沿用旧随机 `clientId`，此方案会失效。

**冗余 `teamId` / `keyId` 的理由**

- 主管端按 `teamId` 过滤、按 `keyId` 展示"所属密钥"，冗余后免 join；
- `keyId` 由服务端从 `req.auth.keyId` 写入（**客户端不上传**），不存在伪造风险。

**不引入 `config_version`**：backend.md §3.3 B 的该字段属于"未来**配置内容**同步"契约。本表是**存在性登记**，语义不同，引入会造成混淆。两者的关系见 §2.3。

### 2.2 `PortLease` 微调（向后兼容）

```prisma
model PortLease {
  // ... 现有字段不变 ...
  channelAccountKey String  // 保留：客户端原始上报值（历史兼容）
  /// 新增：规范化后的账号标识，用于与 channel_accounts 精确匹配
  channelAccountId  String?
}
```

**为什么加这一列**：现在 `channelAccountKey` 的格式没有权威约定 —— 客户端 `useAcquirePortMutation` 传的是 `portId`（**不带渠道前缀**），而库里既有 `telegram:东南亚主号`（带前缀）也有纯 id 形态。`usage.service` 靠 `split(':')[0]` 猜渠道，key 不含冒号时会整体退化。

新表把 `channel` 与 `channelAccountId` **拆开存**，不再依赖这个模糊约定。匹配时优先用新增的 `channelAccountId`，缺失时回落到 `channelAccountKey` 解析（兼容未升级的客户端）。

**`acquire` 入参扩展**（可选字段，老客户端不传也能跑）：

```ts
export const acquirePortSchema = z.object({
  channelAccountKey: z.string().trim().min(1).max(256),
  // 以下为新增可选字段（升级后的客户端建议传全）
  channelAccountId: z.string().trim().min(1).max(128).optional(),
  channel: z.enum(['TELEGRAM', 'WHATSAPP']).optional(),
});
```

服务端规范化顺序：`channelAccountId` 显式传入 → 否则按 `channelAccountKey` 含 `:` 则取冒号后段 → 否则取整个 key。渠道同理（显式传入 → 冒号前段 → 查登记表 → `null`）。

### 2.3 与 backend.md §3.3 B 的关系（务必区分）

| | §3.3 B「账号配置（本地账号配置库）」 | 本文「ChannelAccount 登记表」 |
|---|---|---|
| 定位 | 客户端**本地**库字段契约 | 服务端**登记**表 |
| 存什么 | `proxy_config` / `fingerprint_config` / `data_dir` + 同步预留字段 | 仅 `channel` / `account_name` / 归属 |
| v1.0 | 只写默认值，不参与业务逻辑 | **参与业务**（主管端唯一数据源） |
| 未来 | 同步上线时按该契约建云端表（**另一张表**，非本表扩列） | 不变 |

> PRD 未要求同步代理 / 指纹，且 P0-C-18 AC18 明确"不做同步"。**本方案不触碰 §3.3 B 的配置同步契约**，只是补上 PRD 已要求、但实现缺失的"账号存在性"这一层。

---

## 3. 接口设计

### 3.1 客户端登记：`PUT /api/client/accounts`（全量对账）

**为什么选全量对账而非增量增删改**

| | 全量对账 | 增量（POST/PATCH/DELETE） |
|---|---|---|
| 幂等 / 可重放 | ✅ 天然幂等 | ⚠️ 需自行保证 |
| 漏报自愈 | ✅ 下次对账自动补齐 | ❌ 漏一次永久不一致 |
| 客户端实现 | 一个函数，每次配置变更后整表上报 | 需维护增删改三条路径 |
| 请求体 | 单机几十个账号 ≈ 数 KB | 更小 |

客户端本地库才是真相源，服务端只做投影 —— 全量对账是这类"投影同步"的标准做法。

**请求**

```
PUT /api/client/accounts
Authorization: Bearer <accessToken>
X-Device-Fingerprint: <fingerprint>
Content-Type: application/json

{
  "accounts": [
    { "channelAccountId": "k9x2m", "channel": "TELEGRAM", "accountName": "东南亚主号" },
    { "channelAccountId": "p4q7z", "channel": "WHATSAPP", "accountName": "中东客服A" }
  ]
}
```

- 「客户端**本地全部未删除**账号」构成完整快照；传空数组 = 本机已无账号（全部软删）。
- 服务端在**事务内**：快照内 upsert（`deletedAt` 复位为 `null`），不在快照内的置 `deletedAt = now()`；不变的行不写（避免 `updatedAt` 抖动）。

**响应**

```json
{
  "success": true,
  "data": {
    "created": 1,
    "updated": 1,
    "deleted": 2,
    "total": 2,
    "accounts": [
      {
        "channelAccountId": "k9x2m",
        "channel": "TELEGRAM",
        "accountName": "东南亚主号",
        "status": "NOT_STARTED",
        "online": false,
        "leaseId": null,
        "portsHeld": 0
      }
    ],
    "timezone": "Asia/Shanghai"
  }
}
```

`created / updated / deleted` 计数便于客户端与 QA 断言幂等性（重复提交同一快照 → 三者皆为 0）。

**Zod 校验**

```ts
export const syncChannelAccountsSchema = z.object({
  accounts: z
    .array(
      z.object({
        channelAccountId: z.string().trim().min(1, 'channelAccountId 不能为空').max(128),
        channel: z.enum(['TELEGRAM', 'WHATSAPP'], { message: '渠道仅支持 TELEGRAM / WHATSAPP' }),
        accountName: z.string().trim().min(1, '账号名称不能为空').max(64, '账号名称不能超过 64 字符'),
      }),
    )
    .max(500, '单次最多上报 500 个账号'), // 防御性上限，非产品上限（P0-C-03 AC14 不设实例上限）
});
```

出现重复 `channelAccountId` 时按"后者覆盖前者"处理，不报错（客户端数据异常时不应阻断对账）。

### 3.2 心跳扩展：上报渠道业务状态

补齐 §4.3 提到的 `channelStatus` 无写入点问题。**向后兼容**：老客户端不传 `channelStatuses`，行为与现在完全一致。

```ts
export const heartbeatSchema = z.object({
  leaseIds: z.array(z.string()),
  /** 新增可选：各租约的渠道业务状态（P0-C-03 AC4/AC8/AC9/AC10） */
  channelStatuses: z
    .array(
      z.object({
        leaseId: z.string().min(1),
        status: z.enum(['ONLINE', 'WAITING_QR', 'OFFLINE']),
      }),
    )
    .optional(),
});
```

服务端在 `portService.heartbeat()` 内，对**属于本 `clientId` 且仍 HELD** 的租约更新 `channelStatus`（校验归属，防越权写入他人租约）。

### 3.3 主管端查询改造：`GET /api/supervisor/accounts`

**数据源切换为 ChannelAccount 主 + PortLease 副**：

```
channel_accounts (WHERE teamId = ? AND deletedAt IS NULL)
  ├─ LEFT JOIN license_keys            → keyNickname
  └─ LEFT JOIN port_leases (当前 HELD)  → 运行态（status / leaseId / lastSeenAt）
```

按 `(clientId, channelAccountId)` 匹配租约；租约缺失或已 RELEASED → 账号为 `NOT_STARTED`。

**改造后响应**（字段与前端 `ImAccounts.vue`、类型定义对齐 —— 见 §4.2）：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "channelAccountId": "k9x2m",
        "accountId": "k9x2m",
        "channelAccountKey": "TELEGRAM:k9x2m",
        "channel": "TELEGRAM",
        "accountName": "东南亚主号",
        "status": "ONLINE",
        "online": true,
        "isHeld": true,
        "portsHeld": 1,
        "leaseId": "cmt6vstlm0001uoi07ldnjb7y",
        "keyId": "cmt2q1yq50003uo84g5hq1h69",
        "keyNickname": "海外一部密钥",
        "clientId": "cli_3I_aMP-Ir6uxYLX9SivRWg",
        "createdAt": "2026-09-17T02:10:00.000Z",
        "acquiredAt": "2026-09-17T03:00:00.000Z",
        "lastSeenAt": "2026-09-17T03:05:00.000Z",
        "releasedAt": null,
        "proxyExit": "",
        "timezone": "Asia/Shanghai"
      }
    ],
    "summary": {
      "total": 12,
      "online": 3,
      "offline": 1,
      "waitingQr": 0,
      "notStarted": 8,
      "portsHeld": 4
    },
    "timezone": "Asia/Shanghai"
  }
}
```

**字段语义对照（含变更点）**

| 字段 | 来源 | 变更 |
|---|---|---|
| `accountName` | `channel_accounts.accountName` | 🆕 真实别名（替代原先从 key 拼出的 `accountId`） |
| `createdAt` | `channel_accounts.createdAt` | 🆕 账号**添加**时刻（对应前端"添加时间"列） |
| `acquiredAt` / `lastSeenAt` / `releasedAt` | 当前 / 最近一次租约 | ⚠️ 未启动时为 `null`（原先恒有值） |
| `status` | 派生 | ⚠️ 枚举变更，见 §4.1 |
| `online` | `status === 'ONLINE'` | 🆕 补齐（前端原本就在用） |
| `summary.offline` | `status === 'OFFLINE'` | 🆕 补齐（前端原本就在用） |
| `summary.notStarted` | `status === 'NOT_STARTED'` | 🆕 替代语义错误的 `RELEASED` 计数 |

### 3.4 错误码与限流

- **无新增错误码**：复用 `PARAM_INVALID`（校验失败）、`UNAUTHORIZED` / `CREDENTIAL_REVOKED`（鉴权链）、`RATE_LIMITED`。
- **限流**：`PUT /api/client/accounts` 走既有 `clientOtherRateLimiter`（50/s，backend §4.5）。对账为低频调用，无需单独限流器。
- **审计**：**不写**审计日志。账号登记为高频配置动作、噪音大，且 PRD 未要求。若后续需要追溯，可只对"删除账号"写 `AuditAction.CHANNEL_ACCOUNT_DELETED`（本次不加）。

---

## 4. 状态口径与在线窗口统一（顺带修复）

### 4.1 账号状态枚举重定义

| 新值 | 含义 | 判定 |
|---|---|---|
| `NOT_STARTED` | 未启动（不占端口） | 无 HELD 租约 |
| `WAITING_QR` | 等待扫码 | HELD + `channelStatus = WAITING_QR` |
| `ONLINE` | 在线 | HELD + `channelStatus = ONLINE`，或 `channelStatus` 缺失但 `lastSeenAt` 在窗口内 |
| `OFFLINE` | 离线（仍占端口） | HELD + 其余情况 |

去掉原先误用的 `RELEASED` —— 那是**端口租约**语义，出现在账号状态里会让前端误显示为"未启动"，且与真正未启动的账号无法区分。

### 4.2 在线窗口统一为 5 分钟

| 位置 | 现状 | 改为 |
|---|---|---|
| `usage.service.ts:135` | **硬编码 60s** ❌ | `env.onlineWindowMs` |
| `port.service.ts:364/461/490` | 5 min（局部常量） | `env.onlineWindowMs` |
| `clientDashboard.service.ts:7` | 5 min（局部常量） | `env.onlineWindowMs` |

```ts
// src/config/env.ts
onlineWindowMs: toInt(process.env.ONLINE_WINDOW, 5 * 60 * 1000, 'ONLINE_WINDOW'),
```

**为什么是 5 分钟**：PRD §6.1 已承诺"服务端 / 客户端认知不一致 ≤ 5min"，且心跳间隔 `HEARTBEAT_INTERVAL = 120000`（2 分钟）。原 60s 窗口**小于心跳周期**，健康账号在两次心跳之间必然被判离线 —— 纯 bug。统一后三个页面（IM 账号页 / 端口管理页 / 客户端仪表板）对同一账号的状态判定一致。

### 4.3 前端与类型定义的连带修改（客户端仓库）

`matreko-user-web`（用户后台）侧改动 —— **已于 2026-09-17 落地并实跑验证**：

| 文件 | 改动 |
|---|---|
| `src/types/usage.ts` | `ImAccountItem` 对齐后端 19 字段：`status` 改为四态联合类型 `ChannelAccountStatus`；补 `channelAccountId` / `accountName` / `online` / `isHeld` / `portsHeld` / `clientId` / `createdAt`；`leaseId` / `acquiredAt` / `lastSeenAt` 改可空；新增 `ImAccountsSummary`（`total`/`online`/`offline`/`waitingQr`/`notStarted`/`portsHeld`）。类型名用 `ChannelAccountStatus` 而非 `AccountStatus`，避免与 `types/port.ts` 已有的端口租约态重名（`index.ts` 是全量 `export *`） |
| `src/views/ImAccounts.vue` | ① 统计卡由 3 张改 6 张（总数/在线/等待扫码/离线仍占用/未启动/占用端口）；② 状态列改按 `row.status` 四态渲染（未启动=蓝、等待扫码=橙、在线=绿、离线=灰）；③ 「添加时间」改取 `row.createdAt`（未启动账号不再为空）；④ 账号列改显 `accountName`，tooltip 给 `channelAccountKey`；⑤ **新增「设备」列**（截断 `clientId` + tooltip 全值）—— P0-C-18 AC18 多设备配置独立，同名账号必须能区分；⑥ 新增「端口」列（占用中/未占用）直白呈现 AC1「不占端口」；⑦ 未启动账号底部提示「不占用端口配额」 |

**未改动**（按用户 2026-09-17 决策：客户端不由其负责）：`matreko-client/packages/api/src/supervisor/accounts.ts` 的类型仍是旧契约（`status: 'HELD' | 'RELEASED'`、`online: boolean`、`summary.offline`）。⚠️ 该文件只影响桌面客户端内部调用，**不影响用户后台上线**；但若客户端后续复用该类型，需按上表同步。

`usage.routes.ts` 的 swagger 注释同步更新（原写的 `status: enum [HELD, RELEASED]` 与实现不符）。

---

## 5. 数据迁移与上线顺序

### 5.1 回填脚本 `scripts/backfill-channel-accounts.ts`

从存量 `port_leases` 提取账号，避免主管端在切换数据源后**变空**：

```
对每个 (teamId, keyId, clientId, channelAccountKey) 唯一组合：
  channelAccountId = key 含 ':' ? 冒号后段 : 整个 key
  channel          = key 含 ':' ? 冒号前段（归一化大写，非法则跳过） : 查不到则跳过
  accountName      = channelAccountId（存量无真实别名，只能退化）
  upsert (clientId, channelAccountId)
```

- **幂等**：用 `upsert`，可重复执行；已存在的账号**不覆盖** `accountName`（避免把客户端上报的真实别名冲掉）。
- 无法判定渠道的记录**跳过并打印清单**，人工确认后处理 —— 不猜测。
- 软删的不回填。

### 5.2 上线顺序（关键风险）

```
① 后端发布（新表 + 登记接口 + 主管端改造）   ← 此时若未回填，主管端账号列表会变空
② 执行回填脚本（幂等）
③ 客户端接入登记接口                        ← 新账号开始实时可见
```

⚠️ **① 与 ② 之间有一个窗口期主管端看不到账号**。两种处理方式，任选：

- **推荐**：把回填放进发布流程（migration 后立刻执行脚本），窗口期压到秒级；
- 或**过渡期双源**：主管端查询在过渡期内 `UNION` 存量租约派生结果（用 `source: 'lease' | 'account'` 标记），客户端接入率达标后再摘除该分支。此方案更平滑但代码有临时分支。

另需注意：回填出来的 `accountName` 是 id 形态，客户端接入并上报真实别名后，`accountName` 才会变成客服填的名字（`upsert` 会更新它）。

---

## 6. 文件级改动清单（服务端）

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | 新增 `ChannelAccount` 模型 + `Channel` 枚举；`PortLease` 增 `channelAccountId String?`；`Team` / `LicenseKey` 增反向关系字段 |
| `prisma/migrations/*` | 新增 migration（`prisma migrate dev --name add_channel_accounts`） |
| `src/schemas/channelAccount.schema.ts` | 🆕 `syncChannelAccountsSchema` |
| `src/schemas/port.schema.ts` | `acquirePortSchema` 增可选字段；`heartbeatSchema` 增 `channelStatuses` |
| `src/services/channelAccount.service.ts` | 🆕 `syncAccounts()`（事务内 diff upsert/软删）；`listTeamAccounts()`（主管端查询） |
| `src/controllers/clientAccount.controller.ts` | 🆕 `sync` 处理器 |
| `src/controllers/usage.controller.ts` | `imAccounts` 改调 `channelAccountService.listTeamAccounts()` |
| `src/routes/clientAccount.routes.ts` | 🆕 `PUT /accounts`（`requireClientAuth`） |
| `src/routes/usage.routes.ts` | swagger 响应结构更新 |
| `src/app.ts` | 挂载 `app.use('/api/client', clientAccountRouter)` |
| `src/services/port.service.ts` | `acquire` 规范化 `channelAccountId`；`heartbeat` 写 `channelStatus`；在线窗口改 `env.onlineWindowMs` |
| `src/services/usage.service.ts` | `listImAccounts` 整体迁移至新 service（本文件仅留翻译用量）；在线窗口改 `env.onlineWindowMs` |
| `src/services/clientDashboard.service.ts` | 在线窗口改 `env.onlineWindowMs` |
| `src/config/env.ts` | 新增 `onlineWindowMs` |
| `.env.example` | 新增 `ONLINE_WINDOW=300000` |
| `scripts/backfill-channel-accounts.ts` | 🆕 回填脚本 |
| `scripts/verify-channel-accounts.sh` | 🆕 回归脚本（沿用仓库 `verify-*.sh` 风格） |

---

## 7. 文档同步清单

| 文档 | 改动 |
|---|---|
| **prd.md** | P0-B-10 用户故事（:548）"已启动的 IM 账号" → "**已添加的** IM 账号"，与 AC1 对齐 |
| **backend.md** | §3.1 模型清单 + §3.2 新增 `ChannelAccount` 定义；§3.3 增"与登记表的关系"说明；§6 新增"账号登记与对账"小节；§9.1 接口清单增 `PUT /api/client/accounts`；§12 环境变量表增 `ONLINE_WINDOW`；§13 验收映射增 P0-B-10 AC1 |
| **task.md** | T5-04 开发内容补充"账号登记表 + 对账接口"；T6-04 数据来源说明 |

---

## 8. 决策记录（2026-09-17 拍板）

| # | 事项 | 决策 |
|---|------|------|
| 1 | `channelAccountKey` 权威格式 | **要** —— `acquire` 入参扩展为显式 `{ channelAccountId?, channel? }`（可选、向后兼容），服务端统一规范化 |
| 2 | 回填 vs 双源过渡 | **回填** —— 回填脚本随发布流程执行，不做过渡期 UNION 分支 |
| 3 | `ONLINE_WINDOW` 取值 | **5 分钟**（与 PRD §6.1 承诺及端口页现状一致） |
| 4 | 心跳上报 `channelStatus` | **一并做** —— 后端本期内支持，需客户端配合上报 |

---

## 9. 实现摘要与偏差说明（2026-09-17）

### 9.1 与本文档的偏差

| 项 | 文档原计划 | 实际实现 | 原因 |
|---|---|---|---|
| 数据库变更方式 | `prisma migrate dev --name add_channel_accounts` | **`prisma db push`**（未新增 migration 文件） | 项目部署链路（`Dockerfile` CMD）用的是 `prisma db push --skip-generate`，且 `prisma/migrations/` 最后一条停在 2026-08-21、与 `dev.db` 已有 drift（`channelStatus`/`proxyExit` 未进 migration）。**沿用项目既有约定**，避免引入与实际部署不一致的 migration |
| 客户端登记接口 | 仅 `PUT /api/client/accounts` | 另增 **`acquire` 自动补登** | 若客户端未升级，后端先上线会让"新启动的账号"在主管端完全不可见（列表只读登记表）→ 功能性回归。启动动作即登记可作为过渡兜底，别名退化为标识本身，客户端接入后由对账覆盖 |
| 心跳响应 | 未定义新增字段 | 新增 **`channelStatusUpdated`** | 便于客户端/QA 断言上报是否被接受（未上报时恒为 0） |
| 回填计数 | created / 跳过 | 另增 **revived** | 已软删但仍在申请端口的账号需复位 `deletedAt`，单独计数便于观察 |

### 9.2 实际改动文件

**新增**
- `src/lib/channelAccountKey.ts` —— 账号标识/渠道规范化（全项目唯一实现）
- `src/schemas/channelAccount.schema.ts` —— 对账入参校验
- `src/services/channelAccount.service.ts` —— `syncAccounts()` + `listTeamAccounts()`
- `src/controllers/clientAccount.controller.ts` / `src/routes/clientAccount.routes.ts`
- `scripts/backfill-channel-accounts.ts`（支持 `--dry-run`）
- `scripts/verify-channel-accounts.sh`（30 项断言，隔离库实跑通过）

**修改**
- `prisma/schema.prisma` —— `ChannelAccount` 模型 + `Channel` 枚举 + `PortLease.channelAccountId`
- `src/config/env.ts`、`.env.example` —— `ONLINE_WINDOW`（默认 5 分钟）
- `src/schemas/port.schema.ts` —— `acquire` 可选字段 + 心跳 `channelStatuses`
- `src/services/port.service.ts` —— acquire 规范化与幂等键修正 + 自动补登；心跳写 channelStatus（含归属校验）；两处窗口统一
- `src/services/clientDashboard.service.ts` —— 窗口统一
- `src/services/usage.service.ts` —— 移除 `listImAccounts`（职责迁至新 service）
- `src/controllers/usage.controller.ts`、`src/routes/usage.routes.ts` —— 改数据源 + swagger
- `src/docs/swagger.ts` —— 新增/更新 5 个 schema
- `src/app.ts` —— 挂载 `clientAccountRouter`
- `prd.md`（P0-B-10 用户故事措辞）、`backend.md`（§3.1/§3.2/§3.3/§6.3/§9.1/§12/§13）、`task.md`（T5-04/T6-04）
- `scripts/wipe-data.ts` —— 抹除清单补 `ChannelAccount` / `KeyDailyUsage`，并新增业务表残留自检

**前端仓库（`matreko-user-web`，2026-09-17）**
- `src/types/usage.ts`、`src/views/ImAccounts.vue` —— 见 §4.3

### 9.3 未完成 / 待跟进

1. ~~**前端连带修改（§4.3）尚未落地**~~ → **已完成**（2026-09-17）：`matreko-user-web` 的 `src/types/usage.ts` + `src/views/ImAccounts.vue` 已对齐后端契约，并在隔离库上以真实 HTTP + 无头浏览器实跑验证（覆盖 ONLINE / WAITING_QR / OFFLINE / NOT_STARTED 四态、多密钥多设备同名账号、未启动账号空值列）。
2. **`matreko-client/packages/api/src/supervisor/accounts.ts` 类型未同步** —— 按用户决策（客户端不由其负责）**刻意不动**。仅影响客户端内部调用，不影响用户后台。
3. **客户端接入** —— `PUT /api/client/accounts` 需客户端在配置变更后调用；心跳建议带上 `channelStatuses`。
4. **`channelAccountKey` 双轨期** —— 老客户端仍传裸 id 时，`acquire` 无法判定渠道 → 不自动补登（仍可由对账补齐）；回填脚本对这类记录跳过并打印清单。
5. **本地库已清空（2026-09-17）** —— 业务数据全抹除、仅保留 PLATFORM 管理员（`scripts/wipe-data.ts`，已补 `ChannelAccount` / `KeyDailyUsage` 两张表）；备份留在 `prisma/dev.db.bak-20260917-181004`。**抹除后用户后台无可用账号**：SUPERVISOR 账号随团队一并删除，且登录要求角色严格匹配 → 需先以平台管理员登录、创建团队拿到主管初始密码，才能再进用户后台。

