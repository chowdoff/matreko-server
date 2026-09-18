# 客户端保活与账号登记契约（matreko-client ↔ matreko-server）

> 面向客户端开发。服务端侧改造已落地（见文末「服务端改动清单」），本文档描述客户端需要实现的三个接口契约。
> 关联：`channel-account-design.md`（渠道账号登记设计）、`backend.md` §6（端口租约）、PRD P0-C-03 / P0-C-20 / P0-B-10 AC1。

## 1. 背景：为什么必须做

改造前服务端把「设备在线」判据绑定在 `ClientCredential.lastRenewedAt`（token 续期时间）上，
而客户端只在 access token 即将过期（TTL 3 天，剩余 < 1/5 才触发）或遇到 401 时才续期：

- 激活瞬间写一次 → 设备显示在线；
- 5 分钟后在线窗口过期 → 设备显示离线，**但客户端其实一直在运行**（假离线）；
- 下一次续期最快要 2.4 天后，期间一直是「离线」。

同时客户端**从未调用过端口心跳**，导致 `PortLease.lastSeenAt` 也不刷新，主管端「IM 账号列表」与「端口管理」的状态同样打不准。

## 2. 客户端三件事

| # | 接口 | 作用 | 频率 |
|---|---|---|---|
| ① | `PUT /api/client/accounts` | 账号全量对账（本机账号快照 → 服务端登记表），让主管端看到「已添加但未启动」的账号 | 启动时 + 账号增删改后（1~2s 防抖）+ 周期兜底 |
| ② | `POST /api/client/ports/heartbeat` | 端口租约续期 + 渠道状态上报 + **设备活跃保活** | 每 2 分钟 |
| ③ | `POST /api/client/ports/acquire` | 申请端口时**补传** `channelAccountId` / `channel` | 启动账号时 |

所有客户端接口的鉴权头固定为：

```
Authorization: Bearer <accessToken>
X-Device-Fingerprint: <与激活时一致的设备指纹>
```

## 3. ① 账号全量对账 `PUT /api/client/accounts`

### 请求

```json
{
  "accounts": [
    {
      "channelAccountId": "<本地 port.id>",
      "channel": "TELEGRAM",
      "accountName": "<本地 port.name>",
      "proxyProtocol": "SOCKS5",
      "proxyRegion": "SG"
    }
  ]
}
```

### 语义（必须理解，否则会误删数据）

- **全量快照**：提交本机**全部未删除**账号，不是增量。
  服务端在事务内做对账：快照内的 upsert、快照外的未删除账号置软删。
- **删除账号 = 从快照里移除**即可（服务端软删，不物理删除；重新添加同 id 会自动复位）。
- **空数组合法**：表示本机已无账号（全部软删）。**不要在失败时发送空数组兜底**。
- **天然幂等**：同一快照重复提交 → `created=0, updated=0, deleted=0`。
- 只上报存在性元数据：**不要**上报代理 host/port/账号密码、浏览器指纹、数据目录（P0-C-18 AC18）。
  仅 `proxyProtocol` + `proxyRegion` 这对**出口摘要**要上报 —— 主管端「代理出口」列要用，
  且 P0-C-18 AC4/AC11 的地区一致性校验靠它；它不含任何可复用的凭据。

### 字段约束

| 字段 | 约束 | 来源 |
|---|---|---|
| `channelAccountId` | 1~128 字符，必填，本机内唯一 | 本地 `port.id` |
| `channel` | 枚举 `TELEGRAM` / `WHATSAPP`，必填 | 本地 `port.platform` 大写映射（当前只有 `telegram`） |
| `accountName` | 1~64 字符，必填 | 本地 `port.name` |
| `proxyProtocol` | 可选，枚举 `SOCKS5` / `HTTP` / `HTTPS` / `DIRECT` | 本地代理配置的 type；未配代理填 `DIRECT` |
| `proxyRegion` | 可选，`^[A-Z]{2}(-[A-Z0-9]{1,4})?$`（ISO 3166-1 alpha-2 大写，如 `SG` / `HK`） | 代理「测试出口 IP」得到的地理位置；探测不到就不传（AC12） |

**代理字段的三条规则（务必照做）**：

1. **未实现代理上报的版本 → 直接省略这两个字段**，服务端会保留库中原值，不会清空；
2. **配了代理但出口地探测失败 → 只传 `proxyProtocol`**，`proxyRegion` 不传（合法，显示时只有协议）；
3. **`proxyProtocol: "DIRECT"` 时禁止传 `proxyRegion`**（400）——直连的出口地就是本机，传地区会自相矛盾。
   客服后来改回直连时，传 `DIRECT` 即可让服务端自动清空原有地区。

单次最多 500 条（超出请分批，但注意分批会互相软删，**不要分批**——500 是防御性上限，正常远低于此）。

### 响应

```json
{
  "success": true,
  "data": {
    "created": 1, "updated": 0, "deleted": 2,
    "total": 5,
    "accounts": [ /* 服务端回读的账号列表与状态，字段同主管端列表 */ ],
    "timezone": "Asia/Shanghai"
  }
}
```

`accounts[]` 每项含 `channelAccountId / accountName / channel / status / online / isHeld / portsHeld / leaseId / keyId / keyNickname / licenseCode / proxyProtocol / proxyRegion / clientId / createdAt / acquiredAt / lastSeenAt`，客户端可用于本地自检（例如发现服务端 `leaseId` 与自己记录不一致时对齐）。

> **契约变更（2026-09-18）**：`proxyExit`（展示串，如 `SOCKS5·新加坡`）已从响应中**移除**，
> 换成结构化的 `proxyProtocol` + `proxyRegion`；展示串由用户后台前端拼。
> 新增 `licenseCode`（密钥明文，主管端展示用）。客户端若已在用 `proxyExit`，改读这两个字段。

### 调用时机

1. 应用启动、进入工作台时；
2. 本地账号新增 / 改名 / 删除后（建议 1~2s 防抖合并连续操作）；
3. 周期性兜底（可挂在 ② 的心跳周期里，如每 5 分钟一次，或每次心跳前比对本地快照哈希，仅在有变化时提交）。

## 4. ② 心跳 `POST /api/client/ports/heartbeat`

### 请求

```json
{
  "leaseIds": ["cuid_lease_a", "cuid_lease_b"],
  "channelStatuses": [
    { "leaseId": "cuid_lease_a", "status": "ONLINE" },
    { "leaseId": "cuid_lease_b", "status": "WAITING_QR" }
  ]
}
```

- `leaseIds`：本机当前持有的**全部** lease；本机没占用端口时传 `[]`（合法，仍然会做设备保活）。
- `channelStatuses`：每个 lease 的渠道业务状态，枚举 `ONLINE` / `WAITING_QR` / `OFFLINE`。
  只在**本 clientId 名下且仍 HELD** 的租约上生效，越权写被忽略。**建议每次心跳都全量上报**，
  否则主管端只能按 `lastSeenAt` 兜底推断状态。

### 响应（客户端必须处理）

```json
{
  "success": true,
  "data": {
    "refreshedLeaseIds": ["cuid_lease_a"],
    "revokedLeaseIds": ["cuid_lease_b"],
    "channelStatusUpdated": 2,
    "deviceActiveAt": "2026-09-18T06:30:00.000Z",
    "overQuota": false,
    "heldCount": 3,
    "portQuota": 5,
    "pendingCloseLeaseIds": ["..."],
    "timestamp": "2026-09-18T06:30:00.000Z"
  }
}
```

> `pendingCloseLeaseIds` 仅在 `overQuota=true` 时出现（可选字段），其余字段恒在。

| 字段 | 客户端动作 |
|---|---|
| `refreshedLeaseIds` | 无需动作，仅确认续期成功 |
| `revokedLeaseIds` | 立即停止对应账号（关 webview / 清理本地 `leaseId`），提示「该账号已被主管释放」 |
| `channelStatusUpdated` | 本次写入的渠道状态条数，可忽略 |
| `deviceActiveAt` | 本次设备保活时间（服务端已记录本机活跃）。凭据被删除（解绑/登出）时请求会**先在鉴权层返回 401**（见下表），因此该字段正常恒为时间字符串 |
| `overQuota: true` | 团队配额被下调，需用 `pendingCloseLeaseIds` 弹「选择要关闭的账号」窗口 |
| `pendingCloseLeaseIds` | 仅 `overQuota=true` 时返回，为本机全部 HELD lease，供客户端选择关闭 |

### 失败与失效处理

| 响应 | 含义 | 客户端动作 |
|---|---|---|
| `200` | 正常 | 按上表处理字段 |
| `401 CREDENTIAL_REVOKED` | 本机凭据已被删除（主管解绑 / 设备登出 / 凭据过期） | 清空本地 `leaseId`，回激活页重新激活 |
| `403 KEY_DISABLED` | 密钥被主管禁用 | 停止全部账号，提示「密钥已禁用，请联系主管」 |
| `403 TEAM_UNAVAILABLE` | 团队不可用 / 已到期 | 同上，提示联系管理员 |
| `403 FINGERPRINT_MISMATCH` | 设备指纹与激活时不一致（换键鼠 / 网卡 / 迁移虚拟机） | 按**新设备**重新激活（需密钥有名额） |
| `429` | 单端限流 | 按 `Retry-After` 退避重试；**不计入「失联 3 次」** |

### 频率与超时

- **2 分钟一次**（与 `HEARTBEAT_INTERVAL` 一致）；服务端在线窗口 5 分钟，留了一倍余量。
- 单次请求失败不要立刻清空本地状态：连续失败 3 次后再提示「与服务器失联」。
- 应用进入后台/睡眠恢复后，立即补一次心跳。

## 5. ③ 端口申请 `POST /api/client/ports/acquire`（补传字段）

```json
{
  "channelAccountKey": "telegram:<本地 port.id>",
  "channelAccountId": "<本地 port.id>",
  "channel": "TELEGRAM"
}
```

- `channelAccountKey` 是历史字段，保留即可（服务端仍落库）。
- **新增传全 `channelAccountId` + `channel`**：服务端据此与 `channel_accounts` 精确匹配（IM 账号列表才不会串号）；
  不传时会退化为按 `channel:xxx` 前缀解析，多设备同名账号可能匹配错。
- 服务端在 acquire 时会顺带补登账号（若尚未对账），但 `accountName` 会退化为账号 id，
  等下一次 ① 对账覆盖为真实别名 —— 所以 ① 仍然必须实现。
- 响应中的 `alreadyHeld: true` 表示同账号幂等返回（不要重复创建本地账号）。

## 6. 主管端状态如何生成（客户端自检参考）

**IM 账号列表**（`GET /api/supervisor/accounts`，数据源＝登记表 LEFT JOIN HELD 租约）：

| 主管端 status | 条件 |
|---|---|
| 未启动 | 有登记记录，无 HELD 租约 |
| 等待扫码 | HELD + 心跳上报 `WAITING_QR` |
| 在线 | HELD + 心跳上报 `ONLINE` |
| 离线（仍占端口） | HELD + 心跳上报 `OFFLINE`；或未上报且 `lastSeenAt` 超窗口 |

**设备管理**（`GET /api/supervisor/devices`）：

| 判据优先级 | 来源 | 说明 |
|---|---|---|
| `ClientCredential.lastActiveAt` | 本心跳接口刷新 | 客户端实现心跳后走这条 |
| `ClientCredential.lastRenewedAt` | token 续期 | 老客户端回落（会假离线） |
| `DeviceBinding.boundAt` | 绑定时间 | 从未取得凭据 |

响应项新增 `lastSeenSource`（`HEARTBEAT` / `RENEW` / `BINDING`），可用来确认客户端心跳是否真的打上去了。

## 7. 验收清单（客户端自测）

1. 激活后 5 分钟以上，主管端「设备管理」页该设备仍显示**在线**，且 `lastSeenSource === 'HEARTBEAT'`；
2. 关闭客户端进程，5 分钟后主管端显示**离线**（说明是心跳驱动，而不是永久在线）；
3. 本地新增 1 个账号 → 主管端 IM 账号列表立刻出现该账号，状态「未启动」；
4. 启动该账号（acquire）→ 状态变「在线」（首次上报前可能是「等待扫码」）；
5. 删除本地账号 → 主管端列表该账号消失（软删，重新添加同 id 会回来）；
6. 重复提交同一份账号快照 → 响应 `created=updated=deleted=0`；
7. 主管在后台手动释放该端口 → 下一次心跳返回的 `revokedLeaseIds` 含该 lease，本地账号被自动关闭。

## 8. 服务端改动清单（已完成，供对照）

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | `ClientCredential` 新增 `lastActiveAt DateTime?`（设备活跃时间，与续期语义分离） |
| `src/services/port.service.ts` | `heartbeat()` 顺带 `updateMany ClientCredential.lastActiveAt = now`（按 clientId），响应新增 `deviceActiveAt` |
| `src/services/deviceMgmt.service.ts` | 在线判据改为 `lastActiveAt ?? lastRenewedAt ?? boundAt`；窗口改用 `env.onlineWindowMs`（去硬编码）；响应新增 `lastSeenSource`；提示文案随窗口同步 |
| `src/services/activate.service.ts` | 激活建凭据时显式写 `lastActiveAt`（激活即在线，不再依赖续期时间） |
| `src/services/token.service.ts` | 续期重建凭据时带上 `lastActiveAt`（避免续期瞬间闪离线）；修正「滑动续期 24h」陈旧注释 |
| `src/routes/client.routes.ts` | renew 的 swagger 文案同步（14 天 + 明确「不要用高频续期做保活」） |

**向后兼容**：老客户端（不调心跳）行为与改造前完全一致 —— `lastActiveAt` 为 null 时回落续期时间，
HTTP 契约只增字段、不改字段，无需客户端同步发布。
