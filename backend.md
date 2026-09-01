# 后端技术方案文档（backend.md）

**关联文档**：`prd.md`（v1.0-rc5）
**角色**：后端工程师（服务端 + 用户后台前端 + 管理后台前端）
**版本**：v0.1（Draft）
**日期**：2026-08-18

> 本文档回答 PRD 中标注「技术方案需回答」的全部条目，并对数据模型、认证、限流、端口租约、翻译代理、计量配额、安全等做定稿。凡 PRD 已承诺的上限（24h / 5min / 40s / 10 次熔断等），本方案**只做机制设计，不改变承诺**；所有参数均可配置，供 QA 构造验收路径。

---

## 1. 技术栈基线（基于现有工程）

现有工程 `matreko-server` 已定型，本文档基于此基线，不引入额外重型组件：

| 类别 | 选型 | 说明 |
|------|------|------|
| 运行时 | Node.js ≥ 18 | 现有 |
| 语言 | TypeScript 5.7（严格模式） | 现有 |
| Web 框架 | Express 4 | 现有，分层 Route → Controller → Service |
| 数据库 | SQLite（Prisma 6） | 现有；内测规模（2 团队 × 5 人）充裕，设计目标规模（100 团队 / 500 客服）下写并发仍可控 |
| 校验 | Zod 3 | 现有，用于请求参数校验 |
| 认证凭据 | JWT（access）+ 不透明随机串（refresh） | 新增依赖 `jsonwebtoken`、`bcryptjs`（密码哈希）、`crypto`（内置） |
| 限流 | 进程内内存令牌桶（单实例） | 抽象 `RateLimiter` 接口，未来多实例可换 Redis 实现 |
| 缓存 | 进程内内存缓存（TTL） | 团队状态 / 密钥状态 / 语种能力 / 引擎可用性；未来可换 Redis |
| 翻译引擎 | HTTP 调用 Google / DeepL 官方接口 | `axios` 或内置 `fetch`，统一封装 `TranslationProvider` |
| 定时任务 | `node-cron` | 端口租约回收扫描、引擎语种清单同步、Key 状态巡检 |
| 审计 | 数据库表 + 结构化日志 | `audit_logs` 表 |
| API 文档 | Swagger UI + swagger-jsdoc | 现有 |
| 后台前端 | 静态 HTML/JS（服务端托管）或独立 Vue 3 工程 | 见 §11 |

**数据库选型说明**：PRD §4.2 明确 v1.0 不为 100 团队 / 500 客服做分库分表优化。SQLite 支持事务与约束，足以满足「并发激活原子性」「端口防超卖」两个关键写路径（见 §4.3、§6.3）。若未来扩容，Prisma 可平滑迁移 PostgreSQL（切换 `datasource.provider` + 连接串，模型不变）。

---

## 2. 总体架构

```
┌─────────────┐   HTTPS    ┌──────────────────────────────────────────────┐
│  客户端      │──────────▶│                   服务端                       │
│ (密钥激活/   │            │  ┌─────────────┐  ┌──────────────────────┐   │
│  端口租约/   │            │  │ Auth 模块   │  │ Port Lease 模块      │   │
│  翻译请求)   │            │  │ (凭据/限流) │  │ (申请/心跳/回收)     │   │
└─────────────┘            │  ├─────────────┤  ├──────────────────────┤   │
                           │  │ License 模块│  │ Translation 模块     │   │
┌─────────────┐            │  │ (密钥/绑定) │  │ (引擎/Key/计量)      │   │
│ 用户后台     │──────────▶│  ├─────────────┤  ├──────────────────────┤   │
│ (主管)       │            │  │ Backoffice  │  │ Quota/Team 模块      │   │
└─────────────┘            │  └─────────────┘  └──────────────────────┘   │
                           │                    SQLite (Prisma)           │
┌─────────────┐            └──────────────────────────────────────────────┘
│ 管理后台     │──────────▶   Google Translate API ──▶ 引擎适配层
│ (管理员)     │              DeepL API
└─────────────┘
```

**接口分组与凭据体系**（三组接口、两套凭据）：

| 分组 | 前缀 | 调用方 | 凭据体系 |
|------|------|--------|---------|
| 客户端 API | `/api/client/*` | 客户端 | 客户端凭据（access + refresh token），绑定硬件指纹 |
| 用户后台 API | `/api/supervisor/*` | 主管后台页面 | 后台会话凭据（邮箱 + 密码） |
| 管理后台 API | `/api/platform/*` | 管理员后台页面 | 后台会话凭据（邮箱 + 密码） |

两套凭据互不通用：`token_type` claim 区分（`client` / `backoffice`），守卫按前缀强制校验，交叉调用一律 401（PRD P0-A-19 AC17）。

---

## 3. 数据模型设计

> 时间口径（PRD §2.6）：所有时间字段存储 UTC（Prisma `DateTime` 精确到毫秒，业务判定一律取秒精度），展示层统一转 `Asia/Shanghai`。所有「到期/禁用」类字段均为秒级精确。

### 3.1 Prisma 模型清单

```
Team / AdminAccount / LicenseKey / DeviceBinding / ClientCredential /
PortLease / TranslationKey / EngineLanguageSupport / TranslationUsageLog /
AuditLog / RevokedToken / BackofficeSession
```

### 3.2 模型定义

#### Team 团队

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| name | String | 团队名 |
| createdAt | DateTime | 创建时刻，**不可修改**（PRD §2.6 / P0-S-11 AC12） |
| expiresAt | DateTime | 到期时刻，秒级精确，管理员可随时修改 |
| portQuota | Int | 端口配额 |
| translationQuota | Int | 翻译配额总量（字符），默认 1_500_000 |
| translationUsed | Int | 累计已用字符（冗余计数，以日志表为唯一真相源，见 §8） |
| status | Enum (ACTIVE / DISABLED) | 启用 / 禁用 |
| isExpired 派生 | — | 不落库，判定 `expiresAt <= now` |

约束：只能禁用不能删除；禁用后所有关联数据保留。

#### AdminAccount 后台账号

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| role | Enum (PLATFORM / SUPERVISOR) | 平台管理员 / 团队主管 |
| email | String (unique) | 仅作账号标识，不做邮箱验证 |
| passwordHash | String | argon2id/bcrypt 哈希，**不可还原**（P0-A-19 AC16） |
| teamId | String? | 主管归属团队；平台管理员为空 |
| status | Enum (ACTIVE / DISABLED) | 仅禁用不删除 |
| failedLoginCount | Int | 连续失败计数，默认 0 |
| lockedUntil | DateTime? | 锁定截止时刻；null 表示未锁定 |

约束：`PLATFORM` 全系统唯一（部署初始化，见 §4.6）；`SUPERVISOR` 每团队唯一；锁定期内登录不延长锁定（P0-A-19 AC8）。

#### LicenseKey 密钥

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| teamId | String | 所属团队 |
| code | String (unique) | 密钥明文（仅创建时返回一次；库中可存哈希或明文——密钥本身是激活凭证，建议存哈希并启用前缀，见 §5.2） |
| status | Enum (UNUSED / ACTIVE / DISABLED) | 未激活 / 已激活 / 已禁用 |
| multiDeviceEnabled | Boolean | 多开开关，默认 false |
| deviceLimit | Int | 多开设备上限，恒为 5（关闭多开时逻辑上限 1） |
| createdAt | DateTime | 创建时间 |

**一密钥 = 一客服**（PRD §2.2）。密钥不能删除，只能禁用。

#### DeviceBinding 设备绑定

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| keyId | String | 所属密钥 |
| fingerprintHash | String | 硬件指纹哈希（服务端只存哈希，见 §5.3） |
| deviceLabel | String? | 可识别标识（客户端上报，展示给主管） |
| boundAt | DateTime | 绑定时间 |

约束：`(keyId, fingerprintHash)` 唯一；同密钥绑定数 ≤ `deviceLimit`；解绑即删除记录（不保留历史）。

#### ClientCredential 客户端凭据（refresh token 存储）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| keyId | String | 所属密钥 |
| deviceFingerprintHash | String | 绑定指纹（校验用） |
| clientId | String (unique) | 客户端实例标识（限流维度 key） |
| refreshTokenHash | String (unique) | refresh token 哈希 |
| expiresAt | DateTime | 过期时刻（滑动续期） |
| createdAt / lastRenewedAt | DateTime | 创建 / 最近续期 |

**每个激活成功的设备 = 一条 ClientCredential**。refresh token 轮换时旧记录删除、新记录插入（旋转式）。

#### PortLease 端口占用

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| teamId | String | 所属团队（配额裁决维度） |
| keyId | String | 持有客服 |
| clientId | String | 持有客户端实例 |
| channelAccountKey | String | 客户端侧账号唯一标识（`channel:accountId`，稳定标识） |
| status | Enum (HELD / RELEASED) | 占用中 / 已释放 |
| acquiredAt | DateTime | 占用时刻 |
| lastSeenAt | DateTime | 最近一次在线证明时刻 |
| releasedAt | DateTime? | 释放时刻 |

**服务端记录为准**（PRD P0-C-20）。回收 = 置 `RELEASED`（不物理删除，保留审计）。

#### TranslationKey 翻译 API Key（管理后台唯一持有）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| engine | Enum (GOOGLE / DEEPL) | 所属引擎 |
| name | String | 备注名 |
| keyEncrypted | String | AES-256-GCM 加密存储（密钥来自环境变量，见 §10） |
| status | Enum (ACTIVE / EXHAUSTED / INVALID / DISABLED) | 可用 / 额度耗尽 / 失效 / 停用 |
| quotaLimit | Int? | 额度上限（字符）；null 表示不设限 |
| quotaUsed | Int | 已消耗字符（冗余计数，见 §8） |
| lastFailureReason | String? | 最近一次失败原因 |
| lastUsedAt | DateTime? | 最近使用时刻 |
| createdAt / updatedAt | DateTime | |

引擎可用性 = 该引擎下存在 `ACTIVE` 的 Key（PRD P0-S-12 AC15）。

#### EngineLanguageSupport 引擎语种能力（PRD P0-S-12 AC12 的关键载体）

| 字段 | 类型 | 说明 |
|------|------|------|
| engine | Enum (GOOGLE / DEEPL) | 引擎 |
| languageCode | String | ISO 639-1（如 `zh`、`en`、`de`） |
| status | Enum (SUPPORTED / UNSUPPORTED) | 支持 / 不支持 |
| updatedAt | DateTime | 最近同步时间 |

唯一约束 `(engine, languageCode)`。维护方式见 §7.4。

#### TranslationUsageLog 翻译用量日志（计量唯一真相源）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| teamId | String | 团队 |
| keyId | String? | 实际落到的翻译 Key |
| engine | Enum (GOOGLE / DEEPL) | 实际引擎 |
| chars | Int | **该次翻译的原文字符数** |
| success | Boolean | 恒为 true（失败不计量，不落此表） |
| createdAt | DateTime | |

约束：**只在翻译接口返回成功时插入**（PRD P0-B-10 计量口径）。重试多次成功只插一条（客户端以最终成功那次调用，见 §7.5）。

#### AuditLog 审计日志

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| actorType | Enum (CLIENT / SUPERVISOR / PLATFORM / SYSTEM) | 行为主体类型 |
| actorId | String | 主体标识 |
| action | String | 动作（如 `credential_tampered`、`fingerprint_mismatch`、`team_disabled`） |
| detail | String? | JSON 详情 |
| ip | String? | 来源 IP |
| createdAt | DateTime | |

#### RevokedToken 凭据撤销名单

| 字段 | 类型 | 说明 |
|------|------|------|
| jti | String (unique) | access token 的 jti |
| reason | Enum (RENEWED / REVOKED) | 续期替换 / 主动吊销 |
| revokeAt | DateTime | 撤销时间 |

用途：① 续期无缝轮换的宽限期（§4.2）；② 密码重置后使会话失效。带 TTL 清理（进程内内存 + 定期清理表）。

#### BackofficeSession 后台会话

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid) | 主键 |
| accountId | String | 后台账号 |
| tokenHash | String (unique) | 会话 token 哈希 |
| expiresAt | DateTime | 过期时刻 |
| createdAt | DateTime | |
| revokedAt | DateTime? | 主动撤销时刻（登出 / 改密 / 重置） |

### 3.3 同步预留字段契约（§2.4 第 5 条 —— 后端设计定稿）

> PRD 要求：消息与账号配置只存客户端本地，但数据模型须为未来同步留出空间，将来上同步时**不必迁移或丢弃已有历史消息**。本契约由后端定义，客户端本地库按此字段集建模。**v1.0 只写默认值，不参与任何业务逻辑**。

#### A. 消息记录（本地消息库，每消息一条）

| 字段分组 | 字段 | 类型 | v1.0 取值 | 用途 |
|---------|------|------|----------|------|
| **业务字段（必写）** | stable_message_id | String | 客户端生成，全局唯一且稳定（见 §9.2） | 去重与计量对齐的唯一依据 |
| | channel | Enum (TELEGRAM / WHATSAPP) | 实际渠道 | |
| | conversation_id | String | 客户端侧会话稳定标识 | |
| | direction | Enum (IN / OUT) | 收 / 发 | |
| | original_text | Text | 原文 | 双语展示 / 对账 |
| | translated_text | Text? | 译文 | 双语展示 |
| | source_lang | String? | 识别出的源语言 | |
| | target_lang | String? | 目标语言 | |
| | translate_status | Enum (pending/translating/succeeded/failed/skipped) | 终态必达 | PRD §6.4 状态机 |
| | created_at | DateTime | 消息时间 | |
| **同步预留（只写默认）** | sync_status | Enum (PENDING / SYNCED / FAILED) | PENDING | 未来同步队列标记 |
| | version | Int | 1 | 乐观锁，同步冲突检测 |
| | updated_at | DateTime | 同 created_at | 同步增量依据 |
| | server_message_id | String? | null | 云端消息 ID 回填 |
| | conversation_server_id | String? | null | 云端会话 ID 回填 |
| | is_deleted | Boolean | false | 软删除标记（撤回/删除的同步） |
| | device_id | String | 本机设备标识 | 多设备归属 |
| | is_edited | Boolean | false | 编辑记录预留 |
| | is_recalled | Boolean | false | 撤回记录预留（PRD P0-M-05 AC16） |

#### B. 账号配置（本地账号配置库，每渠道账号一条）

| 字段分组 | 字段 | 类型 | v1.0 取值 | 用途 |
|---------|------|------|----------|------|
| **业务字段** | channel_account_id | String | 客户端侧稳定标识 | |
| | channel | Enum | 实际渠道 | |
| | account_name | String | 客服自定义名称 | |
| | proxy_config / fingerprint_config / data_dir | JSON / String | 实际配置 | 环境隔离 |
| **同步预留（只写默认）** | config_version | Int | 1 | 未来配置同步版本 |
| | updated_at | DateTime | 修改时刻 | 增量依据 |
| | deleted_at | DateTime? | null | 软删除（配置删除的同步） |

**设计约束**：
1. 预留字段一律可空或有默认值，不得成为业务写入的前置条件；
2. `stable_message_id` 必须是「任意时刻、任意次识别同一条渠道消息都得到相同值」的确定性标识——它是未来同步的主键，也是防重复计费的基础（PRD P0-M-05 消息标识条款；客户端工程实现见 §9.2）；
3. 未来同步上线时，云端模型直接按本契约建表，客户端历史数据按字段一一映射，**零迁移、零丢弃**。

---

## 4. 身份认证与凭据体系（P0-A-02 定稿）

### 4.1 凭据构成与有效期

**客户端凭据（两层）**：

| 凭据 | 载体 | 有效期 | 说明 |
|------|------|--------|------|
| access token | JWT（HS256，含 `sub`=keyId、`client_id`、`device_fp_hash`、`token_type=client`、`jti`） | **15 分钟** | 业务请求鉴权 |
| refresh token | 256 位随机串（Base64url），服务端只存 SHA-256 哈希 | **24 小时**，每次续期滑动重置 | 换取新的 access token |

**后台会话凭据**：不透明随机串（32 字节），服务端存哈希于 `BackofficeSession`，**有效期 30 分钟、滑动续期**（每次 API 调用刷新 `expiresAt`，连续 30 分钟无操作即失效需重登），登出 / 改密 / 重置即撤销。（原 8 小时固定时长登录态已废弃；`BACKOFFICE_SESSION_TTL` 由 28800000ms 改为 1800000ms。）

#### 4.1.1 双令牌设计动机（为何客户端拆 access + refresh）

> PRD P0-A-02 **未规定**凭据形态，只规定行为契约（续期无感知 AC2/AC12、禁用 ≤5min 断权 AC8、单客户端限流 AC11），并明言"凭据有效期与续期时机由技术方案决定"。双令牌是为同时满足上述 AC 而采用的方案。

单一令牌无论取何有效期都会撞上 AC：

- **单一短令牌**（如仅发 15min 签名 token）：泄露/伪造窗口小、可无状态校验，但每 15 分钟就需重激活 → 违反 AC2「客服全程无感知」与 P0-A-01 AC2「隔多久都能自动登录」。
- **单一长令牌**（如 24h 签名 token）：可满足"不重登"，但**签名 JWT 天然不可即时撤销**，只能等到期 → 违反 AC8「禁用后 ≤5 分钟真的断权」。

拆成两个令牌，各补对方短板：

| 令牌 | 形态 | 职责 | 如何支撑 AC |
|------|------|------|------------|
| **access token** | JWT HS256、15min、**无状态** | 每次业务请求鉴权；无 DB 查询、快、可水平扩展 | 短命 → 泄露窗口小；禁用场景靠 `RevokedToken`(jti, 60s) + 密钥状态缓存(≤60s) 实现 AC8 的 ≤5min 断权 |
| **refresh token** | 256 位随机串、**库中存哈希、DB 托管**、24h 滑动、旋转式 | 用于 `POST /api/client/auth/renew` 续期；激活时签发/轮换（§5.1.1） | 因其不透明且落库，服务端可**即时作废/轮换**——这是单签名令牌做不到的：支撑 AC6 静默续期（无需重输密钥）、AC3 旧凭据立即失效（轮换删旧插新）、AC8 禁用即让 refresh 记录失效迫使重激活、AC12 在途请求不失败（旧 access jti 进 60s 宽限名单） |

**结论**：access 管"高频、无状态、性能"，refresh 管"低频、服务端可控、静默续期 + 即时吊销"，正是 OAuth2 式 access+refresh 拆分，用"短命无状态令牌 + 长命服务端托管令牌"化解"体验（无感知续期）"与"安全（即时撤销）"的根本矛盾。后台会话为**人操作、重登可接受**，故只需单一 DB 会话令牌，无需拆两个。

### 4.2 自动续期与无缝轮换（P0-A-02 AC2 / AC3 / AC12 的实现）

**续期流程**：
1. 客户端在 access token 剩余有效期 ≤ **1/3**（即 ≤ 5 分钟）时，调用 `POST /api/client/auth/renew`，携带 refresh token；
2. 服务端校验 refresh token 哈希 → 校验密钥/团队状态与指纹 → **原子轮换**：
   - 旧 access token 的 `jti` 写入 `RevokedToken(reason=RENEWED)`，进入 **60 秒宽限期**；
   - 签发新 access token（新 `jti`）；
   - 删除旧 refresh token 记录，插入新记录（旋转式）；
   - 返回新 access token + 新 refresh token；
3. 客户端收到响应后**立即切换**到新凭据，此后不再使用旧凭据。

**AC3 与 AC12 的调和**：AC3「旧凭据立即失效」从客户端使用角度成立——续期成功即切换，旧凭据不再被使用；AC12「在途请求不得失败」由**60 秒宽限期**兜底——续期请求发出前已在途的请求（携带旧 access token）在宽限期内到达服务端仍被正常处理。宽限期后旧 token 返回 401。60 秒远大于真实网络在途窗口（毫秒级），且仅存在于「该密钥自身续期」导致的替换场景，不扩大攻击面。

**宽限期内请求也需通过指纹校验**（见 §4.4）。

### 4.3 禁用后的快速失效（P0-A-02 AC8 / AC11）

access token 有效期 15 分钟 > 承诺的「禁用后 5 分钟内失效」，因此必须**主动撤销**，不能只靠过期：

**撤销事件 → 机制**：

| 事件 | 生效目标 | 机制 |
|------|---------|------|
| 密钥被禁用（P0-B-09 AC3） | 该密钥所有设备的凭据 | 写 `LicenseKey.status=DISABLED` + 失效进程内状态缓存（TTL 60s） |
| 设备被解绑 / 多开下线（P0-B-09 AC9/AC10/AC11） | 指定设备凭据 | 删除对应 `ClientCredential` + 其 access token jti 写入 `RevokedToken(REVOKED)` |
| 团队被禁用 / 团队到期 | 全团队凭据 | 写 `Team.status` / 到期判定；请求时按团队状态拒绝 |
| 后台账号禁用 / 密码重置 / 改密 | 后台会话 | `BackofficeSession` 置 `revokedAt` |

**请求鉴权链**（客户端 API 每个请求）：
```
① JWT 签名与有效期校验（失败→401, reason=invalid/expired）
② token_type=client 校验（后台凭据调用→401）
③ jti 查撤销名单：RevokedToken 命中且超宽限期→401
④ 查密钥状态（进程内缓存 TTL 60s，未命中查库）→ DISABLED→403
⑤ 查团队状态（缓存同上）→ DISABLED 或已到期→403
⑥ 硬件指纹比对（X-Device-Fingerprint 与 jti 签发时的指纹哈希一致）→ 不匹配→403 + 审计日志（P0-A-02 AC9）
⑦ 单客户端限流（见 §4.5）
```

步骤 ④⑤ 的缓存 TTL = 60s，配合主动失效，**最坏 1 分钟内生效，满足 ≤ 5 分钟承诺**。

### 4.4 硬件指纹绑定校验

- 客户端激活时上报硬件指纹，服务端存 `fingerprintHash = SHA-256(fingerprint + keyId)`；
- access token 签发时把指纹哈希放入 claim（`device_fp_hash`），后续请求带 `X-Device-Fingerprint` 头，服务端比对；
- 不匹配 → 403 + `AuditLog(actorType=CLIENT, action=fingerprint_mismatch)`；
- 指纹变化按「新设备」处理（PRD P0-A-01 AC12）：重新走激活流程（名额判定），**不存在「指纹不匹配」独立失败路径**。

### 4.5 限流阈值与算法（§2.4 第 9 条 定稿）

**维度**：单客户端（`client_id`，由服务端在激活时签发，随 access token 下发）。限流只按客户端维度计数，**绝不按团队或全局聚合**（P0-A-02 AC11）。

**算法**：令牌桶（进程内内存实现，`RateLimiter` 接口抽象；未来多实例换 Redis 实现）。

| 分组 | 桶容量 | 补速 | 建议值依据 |
|------|--------|------|-----------|
| 翻译接口 `/api/client/translate` | 20 | 20 token/s | 与客户端级翻译并发上限（§6.2，20）一致，防止单客户端突发洪峰（P0-T-07 AC15） |
| 其余客户端接口 | 50 | 50 token/s | 覆盖端口心跳、用量查询等常规调用 |
| 激活接口 `/api/client/activate` | 5 | 1 token/s | 激活是低频操作，防爆破 |
| 后台登录接口 | 每账号 10 次 / 30 分钟 | 与 P0-A-19 AC7 锁定策略联动 | 账号级限制 |

**行为**：超限返回 **429**，响应头 `Retry-After` + 响应体 `{ retryAfterMs }`（P0-A-02 AC10）；客户端据此延后重试，不得立即重发。

> 数值为建议值，第 4 周压测后确认（PRD §8 第 4 周）；不得突破的 PRD 承诺是「单客户端限流不波及同事」。

### 4.6 后台账号体系（P0-A-19 实现要点）

- **部署初始化**：启动时若 `AdminAccount(role=PLATFORM)` 不存在，则用环境变量 `PLATFORM_EMAIL` / `PLATFORM_INITIAL_PASSWORD` 创建（不提供新增入口，P0-A-19 AC1）；
- **创建团队**：事务内同时创建 `Team` + `AdminAccount(role=SUPERVISOR)`，初始密码仅响应返回一次（P0-A-19 AC2）；
- **登录**：邮箱+密码 → 校验锁定状态（`lockedUntil`）→ 校验密码 → 失败计数 +1（≥10 锁定 30 分钟）→ 成功清零并签发会话（P0-A-19 AC3/AC6-AC9）；
- **密码策略**：≥8 位且同时含字母与数字（P0-A-19 AC10）；存储用 bcrypt cost=12；
- **改密 / 重置**：使该账号其余会话全部失效（`BackofficeSession.revokedAt`），当前会话保留 / 管理员重置则全部失效（P0-A-19 AC5/AC13）；
- **平台管理员不可禁用**（P0-A-19 AC15）；
- **团队禁用 / 到期** → 主管无法登录（P0-A-19 AC12）。

---

## 5. 密钥激活与硬件绑定（P0-A-01 / P0-B-09 实现）

### 5.1 密钥激活流程

```
客户端 POST /api/client/activate { code, fingerprint, deviceLabel }
→ 服务端：
  ① 查密钥（code 前缀 + 哈希比对）
  ② 状态 = UNUSED/ACTIVE 且未禁用；团队 ACTIVE 且未到期
  ③ 名额判定（事务内行锁，见 5.3）：
     - 未开启多开：已有绑定 → 失败「该密钥已在其他设备激活」
     - 开启多开：绑定数 ≥ 5 → 失败「已达设备数上限 5 台」
     - 剩余名额 > 0 → 创建 DeviceBinding
  ④ 签发 clientId + ClientCredential(refresh) + access token
```

### 5.1.1 重新激活即令牌轮换（2026-09-01 调整）

同一 `(keyId, fingerprint)` 重复激活时，服务端**不再保持旧令牌不变**，而是删除旧 `ClientCredential` 并签发全新凭据（新 `clientId` + 新 `refreshToken` + 新 `accessToken`）——即**每次激活都返回新的 `refreshToken`**。

**目的**：客户端本地 `refreshToken` 丢失（且 `accessToken` 已过期、又未登出）时，凭本地缓存的密钥重新激活即可自助捞回令牌，无需等 24 小时凭据自然过期或找主管解绑。此前"凭据仍有效就不返还 refreshToken"的分支会令该场景陷入死锁。

**代价与客户端约定**（详见 §9.3 客户端令牌管理 checklist）：
- **激活失去令牌级幂等**：重复激活令上一组令牌立即作废，客户端必须以本次响应的新令牌覆盖本地存储（绑定 `DeviceBinding` 仍幂等，不产生第二条）；
- **激活与续期不可并发**：`/auth/renew` 与 `/activate` 同时调用会导致 renew 命中"凭据已失效"（旧凭据被激活删除），客户端须串行——日常续期走 `/renew`，仅在本地 `refreshToken` 丢失 / `/renew` 连续失败时才触发激活兜底；
- 激活接口限流（§4.5，5/1s）已覆盖防滥用；同机多实例互踢由"激活仅作兜底、不周期触发"规避。

### 5.2 密钥明文策略

- 密钥明文仅在生成时返回一次（主管侧）；
- 库中存 `codeHash`（SHA-256）+ `codePrefix`（前 6 位，供主管肉眼区分）；激活时按前缀缩小候选后全量哈希比对；
- 生成格式：`MTRK-` + 4 组 × 4 位 Base32 字符（约 20 字符，可键盘输入）。

### 5.3 并发激活原子性（P0-A-01 AC11）

- 事务内对 `LicenseKey` 行执行 `SELECT ... FOR UPDATE`（Prisma 原生查询），锁住密钥行后做名额判定再插入绑定；
- 配合 `(keyId, fingerprintHash)` 唯一约束双保险；
- 效果：剩余 1 个名额时两设备并发提交，最终只有一台成功，另一台收到名额已满的失败提示。

### 5.4 设备解绑 / 多开下线

- 主管解绑 → 删除 `DeviceBinding` + 删除该设备 `ClientCredential` + 其 jti 入撤销名单（≤5 分钟断权，实际即刻，见 §4.3）；
- 关闭多开（P0-B-09 AC9）：主管选择保留一台 → 其余设备按解绑流程下线；
- 解绑次数不限（P0-B-09 AC4）。

---

## 6. 端口占用裁决与回收（P0-C-20 定稿）

### 6.1 在线证明方式与间隔（技术方案回答）

采用 **心跳续租（heartbeat lease）** 协议：

| 参数 | 值 | 说明 |
|------|-----|------|
| 心跳间隔 `HEARTBEAT_INTERVAL` | **2 分钟** | 客户端周期性上报本机持有端口清单 |
| 租约 TTL `LEASE_TTL` | **24 小时** | 超过该时长未收到证明则自动回收 |
| 回收扫描间隔 `LEASE_SCAN_INTERVAL` | **1 分钟** | 服务端定时任务 |
| 撤销感知 | ≤ 2 分钟 | 心跳响应带回「需关闭的占用」，比 5 分钟承诺更快 |

**协议交互**：

```
客户端                                  服务端
  │  POST /api/client/ports/heartbeat     │
  │  { clientId, leaseIds: [...] }  ─────▶│ ① 刷新各 lease 的 lastSeenAt
  │                                       │ ② 比对：找出服务端已不认可/已回收的 lease
  │  ◀───── { revokedLeaseIds: [...] }     │ ③ 返回需关闭的占用清单
  │ 按清单关闭浏览器实例，账号置「未启动」      │
```

**关键路径覆盖**：

| PRD AC | 机制 |
|--------|------|
| AC1 申请端口 | `POST /api/client/ports/acquire`：事务内校验团队占用数 < 配额 → 建 `PortLease`；**并发防超卖**（对 `Team` 行加锁 + 唯一约束 `(clientId, channelAccountKey, status=HELD)`） |
| AC2 保持在线 | 心跳成功即刷新 `lastSeenAt`，租约持续有效 |
| AC3 停止账号 | `POST /api/client/ports/release`：置 `RELEASED` |
| AC4 正常退出 | `POST /api/client/ports/reset`：一次性释放该客户端全部占用 |
| AC5 24h 无证明 | 扫描任务回收 `lastSeenAt + TTL < now` 的占用 |
| AC7 重启上报归零 | 客户端启动时调 `reset` → 立即回收（不等 24h） |
| AC8 中断恢复 | 客户端断连期间不关实例；恢复后心跳继续。若占用已被回收，心跳响应返回该 lease → 客户端关实例置「未启动」 |
| AC11 手动释放 | 主管/管理员后台调用，置 `RELEASED` + 标记待客户端感知 |
| AC12 撤销感知 | 心跳间隔 2 分钟 → 撤销后最迟 2 分钟内客户端感知并收尾 |

**服务端不可达时的客户端行为**（P0-A-01 AC15）：客户端心跳失败时**不退出登录、不关闭实例**，指数退避重试心跳；只要 24 小时内恢复，账号不受影响。此行为属于客户端工程，服务端只保证「无证明超过 TTL 即回收」。

**两个承诺的上限**（PRD P0-C-20 规则基线）：

| 承诺 | 上限 | 本方案实测值 |
|------|------|------------|
| 卡死端口最迟重新可用 | 24h | 心跳 2min + TTL 24h + 扫描 1min → 最迟 24h+1min（≤ 24h 的量级符合） |
| 服务端/客户端认知不一致 | 5 min | 心跳间隔 2min → 最迟 2min 感知 |

> 所有参数进环境变量（`LEASE_TTL`、`HEARTBEAT_INTERVAL`、`LEASE_SCAN_INTERVAL`），QA 可调短以构造 24h 超时与 5min 感知的验收路径（PRD P0-C-20 技术方案需回答）。

### 6.2 端口配额变更联动

- 管理员下调端口配额到低于当前占用（P0-S-11 AC6）：客户端端口占用页/心跳响应中携带「新配额」；客户端弹窗由客服选择关闭账号，**不强制关闭**（AC7 拒绝启动新账号直至满足配额）；
- 配额变更写进程内缓存并主动失效，1 分钟内全端生效（P0-B-10 AC5）。

---

## 7. 翻译代理与引擎管理（P0-S-12 / P0-T-07 定稿）

### 7.1 翻译接口契约

```
POST /api/client/translate
  { text, sourceLang?, targetLang, direction: IN|OUT }
→ 200 { translatedText, detectedSourceLang, engine, chars }
   429 限流    4xx/5xx 详见错误码（P0-T-07 AC13 可区分错误码）
```

- 客户端每消息调一次（PRD §2.4 第 3 条）；「跳过翻译」（源=目标 / 纯 emoji / 纯 URL / 纯数字）由**客户端**判定，不调接口、不计费（P0-T-07 AC8）；
- 服务端**不负责**会话语言记忆——发送方向的目标语言由客户端按 P0-T-06 规则识别后传入；服务端只按 `targetLang` 路由。

### 7.2 引擎双层选路（P0-S-12 规则基线实现）

```
入参 { text, targetLang, sourceLang }
① 可用引擎集 A = { engine | 存在 ACTIVE Key }
② 语种支持集 S = 按 EngineLanguageSupport 查 targetLang（与 sourceLang 的检测无关）
③ 候选 C = A ∩ S
④ C 为空 → 返回「语言不支持」（P0-T-08 AC3 终态失败）
⑤ C 非空 → 在 C 中随机选一个引擎（不配比、不设优先级，PRD NG-11）
⑥ 引擎内选 Key：按 §7.3 规则
⑦ 调用引擎 → 成功：插入 TranslationUsageLog 计量；失败：按 §7.5 处理
```

**引擎不可用判定**：同引擎所有 Key 均非 `ACTIVE`（EXHAUSTED/INVALID/DISABLED）→ 该引擎移出 A → 自动落到另一引擎（P0-S-12 AC7）；只剩一个引擎则全部请求路由到它（AC8）；双引擎均不可用 → 返回可区分错误码 `TRANSLATION_SERVICE_UNAVAILABLE`（AC9）。

### 7.3 引擎内多 Key 选路（OQ-48 —— 建议方案，待产品决策）

PRD 将 OQ-48 定为**产品决策**（「额度用完那一刻是所有 Key 一起断，还是一个一个断」）。本文档给出技术推荐方案，**以产品结论为准，定稿落回 P0-S-12 第二层规则**：

**推荐：按剩余额度加权随机 + 最近失败避让（混合）**
- 每个 `ACTIVE` Key 的权重 = `max(quotaLimit - quotaUsed, 0)`；随机选择（`weighted random`）；
- 最近 30 分钟内失败率 > 50% 的 Key 暂避 5 分钟（临时降权为 0）；
- 理由：加权随机让多个 Key 的额度按比例消耗，避免「轮询导致所有 Key 几乎同时用满、引擎瞬间整体不可用」；失败避让自动绕开出问题的 Key；相比「按剩余额度最多优先」，本方案不依赖实时用量统计的强一致性。

> 若产品最终选择「轮询」或「按最近失败率避让」单一规则，改动仅限选路函数，不影响其余设计。

### 7.4 语种清单维护方式（P0-S-12 AC12 定稿）

**目标**：引擎新增语种时，**无需发布客户端新版本**即可生效。

**机制**：
1. **种子数据**：部署脚本预置两引擎官方语种清单（Google 131、DeepL 33，ISO 639-1 编码）；
2. **定时同步**：`node-cron` 每日 04:00（UTC）调用
   - Google：`GET https://translation.googleapis.com/language/translate/v2/languages?target=en`
   - DeepL：`GET https://api-free.deepl.com/v2/languages?type=target`
   刷新 `EngineLanguageSupport`（新语种自动置 `SUPPORTED`，消失的置 `UNSUPPORTED` 并保留记录）；
3. **手动兜底**：管理后台「语种支持」页可单独增/删/改（应对引擎接口变更的过渡期）；
4. **运行时读取**：选路时查进程内缓存（TTL 10 分钟，同步任务执行后主动失效）；
5. 客户端**无需感知**语种清单——它只传 `targetLang`，由服务端路由（P0-S-12 AC12）。

### 7.5 翻译重试 / 熔断（P0-T-08 —— 客户端级参数，服务端配合）

> 重试、并发、熔断的执行者在**客户端**（跨账号共享一套计数），服务端只负责：返回可区分错误码、不重复计量、容忍幂等重试。本文档定义参数契约，客户端按此实现。

| 参数 | 建议值 | 说明 |
|------|--------|------|
| 自动重试总预算 | **40 秒**（PRD 承诺，不可突破） | 超时即终态失败，提供手动重试 |
| 退避曲线 | 指数退避 + 抖动：`0.5s → 1s → 2s → 4s → 8s → 8s → 8s` | 最多 **7 次**自动重试；累计 31.5s + 请求耗时余量 < 40s |
| 单条消息并发 | 禁止 | 同一条消息任何时刻至多一个在途翻译请求（P0-T-08 AC6） |
| 客户端级并发上限 | **20** | 跨账号共享；超出排队等待（P0-T-08 AC6 / P0-T-07 AC15） |
| 连续失败熔断 | **10 次**（跨账号累计） | 任一成功即清零（P0-T-08 AC10）；熔断无自动恢复，手动探测（AC8/AC9） |
| 可重试错误 | 超时 / 429 / 5xx / 网络中断 | 429 按 `Retry-After` 延后 |
| 不可重试错误 | `API_KEY_INVALID`、`PARAM_INVALID`、`CONTENT_REJECTED`、`TRANSLATION_SERVICE_UNAVAILABLE` | 直接终态失败（P0-T-08 AC3）；「语言不支持」→ 换引擎（§7.2），双引擎均不支持才终态 |
| 手动重试 | 独立于自动重试 | 不计入 40s 预算；熔断态下手动重试 = 探测请求（P1-T-13 AC3） |

**服务端配合点**：
- 429 一律带 `Retry-After`；
- 同一消息重试多次，客户端只把**最终成功那次**作为计量调用（P0-B-10 AC10）——服务端按「接口返回成功即计量」执行，天然满足「只计一次」；
- 引擎层「Key 失效 → 自动换 Key → 引擎内重试一次」对客户端透明（P0-S-12 AC6：轮换不使在途请求失败，失败也可被客户端自动重试挽回）。

### 7.6 超长消息（P0-T-07 AC10 / P0-B-10 AC12）

- 引擎单次调用上限配置为 `ENGINE_MAX_CHARS = 5000`（引擎适配层常量）；
- 超长文本按**句子边界分片**（每片 ≤ 4500 字符），逐片翻译后**合并为完整译文**返回；
- 任一片失败 → 整条返回失败（**不得返回截断译文 + 成功状态**，P0-T-07 AC10）；
- 计量按**原文总字符数一次**（P0-B-10 AC12）。

---

## 8. 用量计量与配额裁决（P0-B-10 / P0-S-11 实现）

### 8.1 计量口径实现

| 情形 | 处理 |
|------|------|
| 接口返回成功 | 插入 `TranslationUsageLog`（按该次翻译原文字符数）；`Team.translationUsed`、`TranslationKey.quotaUsed` 冗余计数 +1 次原子自增 |
| 接口返回失败 / 未调用 | **不计量**（P0-B-10 AC9） |
| 重试多次后成功 | 只计最终成功那次（P0-B-10 AC10） |
| 跳过翻译（源=目标 / 纯 emoji/URL/数字） | 未调用接口，不计（P0-B-10 AC11） |
| 超长消息 | 按原文总字符一次（P0-B-10 AC12） |
| 译文最终无处可用（撤回/切走/退出） | 只要服务端已返回成功，照常计量（P0-B-10 口径 / P0-M-05 AC17） |

**真相源**：`TranslationUsageLog` 为唯一权威；`Team.translationUsed` / `Key.quotaUsed` 为冗余计数（同事务内更新，可对账）。

### 8.2 翻译配额裁决

- **检查时机**：翻译请求处理前检查 `Team.translationUsed < translationQuota`，达到则返回 `QUOTA_EXHAUSTED`（可区分错误码，P0-T-07 AC12）；
- **原子性**：配额检查和用量自增在同一事务（SQLite 串行化保证）；内测规模下无并发写压力，若未来写冲突显著，迁移 PostgreSQL 后加行锁；
- **配额变更**：管理员改配额 → 进程内缓存主动失效 → **≤1 分钟生效**（实际即时，P0-B-10 AC5）；
- **调大恢复**：累计用量不清零，仅上限变大（P0-B-10 AC15）；**调到低于已用量**：立即阻断，展示「已超出配额」（AC16）；
- **团队禁用后恢复**：累计用量延续（AC17）。

### 8.3 Key 维度计量

- `TranslationUsageLog` 同时带 `keyId`，按 Key 聚合 → 管理后台展示「实时用量 / 额度上限 / 近 24h 调用与失败次数 / 最近使用时刻 / 最近失败原因」（P0-S-12 AC13）；
- 近 24h 统计由定时任务聚合成 `KeyDailyUsage` 缓存表（每小时刷新一次 + 实时计数兜底），避免每次聚合扫全表；
- Key 额度耗尽判定：`quotaUsed >= quotaLimit` → 自动置 `EXHAUSTED`（P0-S-12 AC15），请求自动跳下一个 Key。

### 8.4 时间展示口径

- 所有接口返回时间统一为 UTC ISO 字符串 + `timezone: "Asia/Shanghai"` 标注；前端固定按 `Asia/Shanghai` 渲染（P0-B-10 AC18 / P0-S-11 AC2）；
- 到期判定在 UTC 时间轴上进行（秒级）。

---

## 9. 客户端侧契约（服务端需定义的接口与稳定标识）

### 9.1 客户端调用的服务端接口清单

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/client/activate` | 密钥激活（绑定指纹） |
| POST | `/api/client/auth/renew` | 凭据续期（无缝轮换） |
| POST | `/api/client/auth/logout` | 主动登出（撤销本机凭据） |
| POST | `/api/client/ports/acquire` | 申请端口 |
| POST | `/api/client/ports/heartbeat` | 在线证明 + 撤销感知 |
| POST | `/api/client/ports/release` | 释放单个端口 |
| POST | `/api/client/ports/reset` | 本机占用归零（重启上报） |
| POST | `/api/client/translate` | 翻译代理 |
| GET | `/api/client/team/usage` | 团队端口 / 翻译配额余量（团队级汇总，PRD §4.1 例外 / P0-B-10 AC19） |
| GET | `/api/client/me` | 当前密钥所属团队信息 |
| GET | `/api/client/dashboard` | 客户端首页仪表板（2026-08-24 增补）：一次性返回 serverTime、team（含 daysRemaining）、teamPortHeader、4 张统计卡片（myAccounts / teamPorts[mine vs others] / translation / translationService[OK|DEGRADED|OUTAGE]）、各渠道 5 项状态分布（Telegram/WhatsApp 的 total/online/waitingQr/offlineHeld/notStarted），同时供侧栏「N/M 在线」角标 |

### 9.2 消息稳定标识（§2.4 第 5 条 / P0-M-05 消息标识）

虽然标识在客户端生成，但它是同步主键与防重复计费的基础，服务端须在 `api-docs` 与数据契约中**固定其格式**：

- 格式：`{channel}:{accountId}:{渠道侧消息ID确定性摘要}`；
- 要求：由渠道 Web 端 DOM 中**确定性可提取**的字段（如消息的时间戳 + 发送者 + 内容哈希）派生，跨页面重绘 / 滚动回退 / 重启 / 重新登录均稳定；
- 服务端翻译接口按该标识做幂等（可选实现：同 `stable_message_id` 的同参数请求返回缓存结果，防客户端去重失效时重复计费的双保险）。

### 9.3 客户端令牌管理 checklist（2026-09-01 增补）

> 配合 §5.1.1「重新激活即令牌轮换」机制，客户端须遵循以下约定，避免死锁与令牌互相覆盖。

1. **密钥与令牌分库存储**：密钥（license code）存 OS 钥匙串（macOS Keychain / Windows DPAPI），`accessToken` / `refreshToken` 可存普通应用存储。密钥耐久度须高于令牌——令牌丢失时密钥仍在，才能靠重激活自助捞回。
2. **令牌按 keyId 分桶**：多密钥共存时本地存储为 `Map<keyId, { clientId, accessToken, refreshToken }>`，禁止单一全局槽位，否则激活 B 覆盖 A 的令牌导致 A 死锁。
3. **日常续期走 /renew，激活仅作兜底**：`accessToken` 剩余 ≤ 1/3（5 分钟）时静默调 `/auth/renew`；仅当本地 `refreshToken` 缺失、或 `/renew` 连续失败（建议 ≥2 次）时，才用本地密钥调 `/activate` 兜底捞回令牌。**禁止周期性自动调激活**，避免与 renew 并发互踢。
4. **激活响应以最后到达为准**：网络抖动导致激活重试时服务端会轮换多次，客户端拿到任一响应都应以**最后一个**覆盖本地令牌，丢弃先到的。
5. **激活与 renew 不可并发**：两者均会令旧令牌作废，并发会导致在途 renew 401；客户端须串行调度（续期与兜底激活互斥）。
6. **续期成功立即覆盖**：`/auth/renew` 返回的新 `refreshToken` 须立即覆盖本地旧值（旧的当场作废）。
7. **登出后清本地**：`/auth/logout` 成功后客户端主动清掉本地 `accessToken` / `refreshToken` / `clientId`；下次使用须重新激活。

---

## 10. 安全设计

| 项 | 方案 |
|----|------|
| 密码存储 | bcrypt cost=12；任何接口响应不得出现密码明文或可还原信息（P0-A-19 AC16 常驻回归用例） |
| 翻译 API Key | AES-256-GCM 加密存储，密钥来自环境变量 `API_KEY_ENC_KEY`；响应永远只返回掩码（如 `AIza***3f9`）；任何响应出现明文即缺陷（P0-S-12 AC5 常驻回归用例） |
| 密钥 code | 存 SHA-256 哈希 + 前 6 位前缀；明文仅生成时返回一次 |
| refresh token | 256 位随机数，库中存 SHA-256 哈希；旋转式（每次续期替换） |
| 凭据隔离 | `token_type` claim + 路由前缀双守卫，两套凭据互不通用（P0-A-19 AC17） |
| 指纹校验 | 所有客户端请求校验 `X-Device-Fingerprint` 与签发时指纹一致（P0-A-02 AC9） |
| 防枚举 | 登录失败统一提示「邮箱或密码错误」（P0-A-19 AC6） |
| 传输安全 | 生产环境 Nginx 强制 TLS；客户端凭据禁止出现在日志 |
| 审计 | `AuditLog` 记录：凭据篡改、指纹不匹配、团队/密钥禁用、配额调整、手动释放端口、后台登录锁定等 |
| 请求体校验 | Zod 中间件（现有）覆盖所有入参，金额/配额类字段校验非负整数（P0-S-11 AC13） |
| 幂等 / 防重 | 激活绑定幂等（同 keyId+fingerprint 不产生第二条 DeviceBinding），但令牌每次轮换（§5.1.1）；翻译幂等（§9.2） |

---

## 11. 后台前端方案（后端兼任，PRD §4.3）

**技术选型**：独立 **Vue 3 + Vite + TypeScript + Element Plus** 单页工程，构建产物由本服务端静态托管（`/backoffice/supervisor`、`/backoffice/platform`），复用同一套登录态。

**页面清单**：

| 后台 | 页面 | 对应需求 |
|------|------|---------|
| 用户后台（主管） | 登录 | P0-A-19 |
| | 密钥管理：列表 / 生成 / 禁用 / 多开开关 / 设备列表 / 解绑（含多开关闭时选留设备） | P0-B-09 |
| | IM 账号查看（渠道/状态/所属密钥） | P0-B-10 AC1 |
| | 端口用量（配额/占用/可用，含手动释放） | P0-B-10 AC2-AC3 / P0-C-20 AC11 |
| | 翻译用量（累计/配额/剩余） | P0-B-10 AC4 |
| | 按密钥用量分布（P1） | P1-B-16 |
| 管理后台（平台管理员） | 登录 | P0-A-19 |
| | 团队管理：创建（含主管初始密码一次展示）/ 配额 / 到期时刻 / 禁用 / 手动释放端口 | P0-S-11 |
| | 翻译引擎与 Key 管理：添加 / 停用 / 掩码展示 / 实时用量 / 语种支持维护 / 风险提示（单 Key / 单引擎） | P0-S-12 |
| | 运行监控（P1）：在线账号数 / 端口占用 / 翻译成功率 / 失败原因分布 / 配额耗尽高亮 | P1-S-17 |

**后端对应接口**（`/api/supervisor/*`、`/api/platform/*`）：

```
supervisor: POST /auth/login  POST /auth/logout  POST /auth/change-password
  GET  /licenses  POST /licenses  POST /licenses/:id/disable
  POST /licenses/:id/multi-device  POST /devices/:id/unbind
  GET  /accounts  GET /ports  POST /ports/:leaseId/release  GET /translation-usage
platform:  teams CRUD(无删除)  /teams/:id/disable  /teams/:id/quotas
  /translation-keys  /translation-keys/:id  /engines/languages  /monitoring
```

---

## 12. 可配置项清单（全部环境变量，QA 可调）

| 变量 | 默认值 | 对应承诺/验收 |
|------|--------|--------------|
| `ACCESS_TOKEN_TTL` | 15 分钟 | P0-A-02 续期 |
| `REFRESH_TOKEN_TTL` | 24 小时 | 客服无感知（P0-A-01 AC2） |
| `TOKEN_RENEW_GRACE_MS` | 60 秒 | 续期无缝轮换（P0-A-02 AC12） |
| `KEY_STATUS_CACHE_TTL_MS` | 60 秒 | 禁用后 ≤5 分钟失效（P0-A-02 AC8） |
| `RATE_LIMIT_TRANSLATE_CAP / RATE` | 20 / 20s | 单客户端限流（P0-A-02 AC10/AC11） |
| `RATE_LIMIT_OTHER_CAP / RATE` | 50 / 50s | 同上 |
| `RATE_LIMIT_ACTIVATE_CAP / RATE` | 5 / 1s | 激活防爆破 |
| `HEARTBEAT_INTERVAL` | 2 分钟 | P0-C-20 5 分钟感知 |
| `LEASE_TTL` | 24 小时 | P0-C-20 24 小时回收 |
| `LEASE_SCAN_INTERVAL` | 1 分钟 | 同上 |
| `ENGINE_MAX_CHARS` | 5000 | 超长消息（P0-T-07 AC10） |
| `CHUNK_SIZE` | 4500 | 分片 |
| `LANG_SYNC_CRON` | `0 4 * * *` | 语种清单同步 |
| `PLATFORM_EMAIL / PLATFORM_INITIAL_PASSWORD` | — | 管理员初始化（P0-A-19 AC1） |
| `API_KEY_ENC_KEY` | — | API Key 加密 |
| `LOGIN_LOCK_THRESHOLD / LOGIN_LOCK_MS` | 10 / 30 分钟 | P0-A-19 AC7 |

---

## 13. 与 PRD 验收条件的映射（测试断言基础）

| PRD 承诺 | 服务端设计落点 | 验证方式 |
|----------|--------------|---------|
| 凭据续期客服无感知 | §4.2 无缝轮换 | 测试：续期期间在途请求不 401 |
| 禁用后 ≤5 分钟断权 | §4.3 状态缓存 + 撤销名单 | 测试：禁用密钥后 ≤60s 内 403 |
| 端口 24h 回收 | §6.1 心跳 TTL | 测试：缩短 `LEASE_TTL` 后跑通 AC5 |
| 端口认知不一致 ≤5min | §6.1 心跳间隔 | 测试：缩短 `HEARTBEAT_INTERVAL` 后跑通 AC12 |
| 重试总时长 ≤40s | §7.5 参数契约（客户端） | 测试：注入超时故障，断言终态时间 |
| 连续 10 次失败熔断 | §7.5（客户端） | 测试：跨账号累计 |
| 配额变更 ≤1min 生效 | §8.2 缓存失效 | 测试：调配额后立即生效 |
| 计量口径 | §8.1 | 测试：失败/跳过/重试成功/撤回后成功四种情形 |
| 并发激活不超卖 | §5.3 行锁 + 唯一约束 | 测试：并发抢占最后一名额 |
| 端口防超卖 | §6.1 acquire 事务 | 测试：并发申请至配额上限 |

---

## 14. 待决事项

| # | 事项 | 责任方 | 截止点 |
|---|------|--------|--------|
| 1 | **OQ-48 引擎内多 Key 选路规则**（本文档推荐：按剩余额度加权随机 + 最近失败避让） | 产品 | 第 3 周翻译代理开发前（PRD §7） |
| 2 | 限流阈值 / 翻译并发上限 / 退避参数压测确认 | 后端 + 产品 | 第 4 周（PRD §8） |
| 3 | 客户端硬件指纹生成方案（服务端只比对哈希） | 前端 | 第 1 周 |
| 4 | 消息稳定标识的确定性算法（服务端固定格式契约，客户端实现） | 前端 + 后端 | 第 1 周（PRD go/no-go 关卡） |
| 5 | 翻译引擎 SDK 官方配额/费率核对（Google/DeepL 计费维度） | 后端 | 第 2 周 |
