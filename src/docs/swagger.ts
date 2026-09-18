import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'matreko-server API 文档',
      version: '1.0.0',
      description: 'matreko-server 后端服务接口文档（Express + TypeScript + Prisma）',
    },
    // 注意：此处故意不写死 servers 的 url。
    // swagger-ui-express 在未配置 servers 时，会以当前浏览器地址（window.location.origin）
    // 作为「Try it out」的请求基址——这样通过局域网 IP（如 http://192.168.x.x:3000）
    // 访问文档时，调试请求也会打到正确的 LAN 地址，而不是写死的 localhost。
    // 若写死 http://localhost:${env.port}，在 LAN 环境下「Try it out」会请求到错误的主机。
    tags: [
      { name: 'System', description: '系统接口' },
      { name: 'Auth', description: '后台账号鉴权' },
      { name: 'Team', description: '团队管理' },
      { name: 'License', description: '密钥管理' },
      { name: 'Client', description: '客户端接口' },
      { name: 'Port', description: '端口租约管理' },
      { name: 'TranslationKey', description: '翻译引擎与 Key 管理（平台管理员）' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        // ── 统一响应包装 ──
        ApiResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {},
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'PARAM_INVALID' },
                message: { type: 'string', example: '错误信息' },
                details: {},
              },
            },
          },
        },

        // ── 后台登录 ──
        LoginRequest: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', example: 'admin@matreko.local' },
            password: { type: 'string', example: 'Admin12345' },
          },
        },
        LoginResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                token: { type: 'string', description: '后台会话凭据，作为 Bearer Token 使用' },
                expiresAt: { type: 'string', format: 'date-time' },
                account: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    role: { type: 'string', enum: ['PLATFORM', 'SUPERVISOR'] },
                    teamId: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },

        // ── 密码操作 ──
        ChangePasswordRequest: {
          type: 'object',
          required: ['oldPassword', 'newPassword'],
          properties: {
            oldPassword: { type: 'string', example: 'OldPass123' },
            newPassword: { type: 'string', minLength: 8, example: 'NewPass456' },
          },
        },
        ResetPasswordRequest: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string', description: '目标主管账号 ID' },
          },
        },
        ResetPasswordResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                temporaryPassword: {
                  type: 'string',
                  description: '随机生成的临时密码（仅此一次返回，请妥善保存）',
                },
              },
            },
          },
        },
        DisableAccountRequest: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string' },
          },
        },

        // ── 团队 ──
        CreateTeamRequest: {
          type: 'object',
          required: ['name', 'supervisorEmail', 'expiresAt', 'portQuota'],
          properties: {
            name: { type: 'string', maxLength: 64, example: '华东客服一组' },
            supervisorEmail: { type: 'string', format: 'email', example: 'sup@matreko.local' },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: '到期时刻（日期 + 时分秒），ISO 8601 带时区',
              example: '2027-01-01T00:00:00+08:00',
            },
            portQuota: { type: 'integer', minimum: 0, example: 10 },
            translationQuota: {
              type: 'integer',
              minimum: 0,
              default: 1500000,
              description: '翻译配额总量（字符），默认 150 万',
            },
          },
        },
        CreateTeamResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                team: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    expiresAt: { type: 'string', format: 'date-time' },
                    portQuota: { type: 'integer' },
                    translationQuota: { type: 'integer' },
                    status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
                  },
                },
                supervisor: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                  },
                },
                initialPassword: {
                  type: 'string',
                  description: '主管初始密码，仅此一次返回',
                },
              },
            },
          },
        },

        // ── 团队列表 / 配额修改 / 禁用 ──
        TeamListItem: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
            createdAt: { type: 'string', format: 'date-time', description: '创建时刻（UTC ISO，展示 Asia/Shanghai）' },
            expiresAt: { type: 'string', format: 'date-time', description: '到期时刻（UTC ISO，展示 Asia/Shanghai）' },
            portQuota: { type: 'integer' },
            portsHeld: { type: 'integer', description: '当前端口占用数' },
            translationQuota: { type: 'integer' },
            translationUsed: { type: 'integer', description: '累计已用字符数' },
            supervisor: {
              type: 'object',
              nullable: true,
              description: '该团队主管账号（每团队唯一）',
              properties: {
                accountId: { type: 'string', description: '主管账号 ID' },
                email: { type: 'string', description: '主管账号名称（邮箱）' },
                status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
              },
            },
            timezone: { type: 'string', example: 'Asia/Shanghai' },
          },
        },
        TeamListResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/TeamListItem' },
            },
          },
        },
        UpdateTeamQuotaRequest: {
          type: 'object',
          properties: {
            portQuota: { type: 'integer', minimum: 0, description: '端口配额（非负整数，AC13）' },
            translationQuota: { type: 'integer', minimum: 0, description: '翻译配额总量（字符，非负整数）' },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: '到期时刻（ISO 8601 带时区）；改到过去 = 立即到期，需 confirm=true（AC11）',
            },
            confirm: { type: 'boolean', description: '改到过去时须显式确认影响范围（AC11）' },
          },
        },
        UpdateTeamQuotaResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                team: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
                    createdAt: { type: 'string', format: 'date-time' },
                    expiresAt: { type: 'string', format: 'date-time' },
                    portQuota: { type: 'integer' },
                    translationQuota: { type: 'integer' },
                    translationUsed: { type: 'integer' },
                  },
                },
                changes: {
                  type: 'object',
                  description: '本次变更的字段记录',
                },
                expiresChanged: { type: 'boolean' },
                willExpireImmediately: { type: 'boolean', description: '到期时刻是否被改为过去（立即到期）' },
                noChange: { type: 'boolean', description: '无字段变化（幂等）' },
              },
            },
          },
        },
        DisableTeamRequest: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', description: '首次调用不传时返回影响范围提示，确认后重试' },
          },
        },
        DisableTeamResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                impact: {
                  type: 'object',
                  properties: {
                    activeKeys: { type: 'integer', description: '活跃密钥数（含未激活）' },
                    heldPorts: { type: 'integer', description: '当前端口占用数' },
                  },
                },
                alreadyDisabled: { type: 'boolean', description: '是否已是禁用态（幂等）' },
              },
            },
          },
        },
        EnableTeamResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                alreadyEnabled: { type: 'boolean', description: '是否已是启用态（幂等）' },
                team: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    status: { type: 'string', example: 'ACTIVE' },
                    expiresAt: { type: 'string', format: 'date-time' },
                  },
                },
                expired: { type: 'boolean', description: '到期时刻是否已过（需另行改到期到未来才真正恢复，AC5）' },
              },
            },
          },
        },

        // ── 密钥管理（P0-B-09） ──
        DeviceBindingItem: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            deviceLabel: { type: 'string', nullable: true },
            boundAt: { type: 'string', format: 'date-time', description: '设备激活时间' },
          },
        },
        LicenseItem: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            nickname: { type: 'string', description: '密钥昵称' },
            licenseCode: { type: 'string', example: 'MTRK-MMUD-HUBY-5HWF-GZVQ', description: '完整密钥明文（AES-256-GCM 解密后返回）；DB 中存密文', nullable: true },
            status: { type: 'string', enum: ['UNUSED', 'ACTIVE', 'DISABLED'] },
            multiDeviceEnabled: { type: 'boolean', description: '多开开关' },
            deviceLimit: { type: 'integer', example: 5 },
            createdAt: { type: 'string', format: 'date-time' },
            deviceBindings: {
              type: 'array',
              items: { $ref: '#/components/schemas/DeviceBindingItem' },
              description: '绑定设备列表（含各设备激活时间）',
            },
          },
        },
        CreateLicenseRequest: {
          type: 'object',
          required: ['nickname'],
          properties: {
            nickname: { type: 'string', maxLength: 64, example: '客服张三的密钥' },
            multiDeviceEnabled: { type: 'boolean', default: false, description: '是否开启多设备激活，默认不开启' },
          },
        },
        CreateLicenseResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                licenseKey: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    nickname: { type: 'string' },
                    status: { type: 'string', enum: ['UNUSED', 'ACTIVE', 'DISABLED'] },
                    multiDeviceEnabled: { type: 'boolean' },
                    deviceLimit: { type: 'integer' },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
                },
                plaintextCode: {
                  type: 'string',
                  description: '密钥明文（MTRK-XXXX-XXXX-XXXX-XXXX），仅本次响应返回一次',
                },
              },
            },
          },
        },
        MultiDeviceRequest: {
          type: 'object',
          required: ['enabled'],
          properties: {
            enabled: { type: 'boolean', description: 'true 开启多开（上限 5 台）；false 关闭多开' },
            keepDeviceBindingId: {
              type: 'string',
              description:
                '关闭多开时保留的设备绑定 ID（AC9）。仅在已绑 ≥2 台时必填；' +
                '已绑 0 台时无需提交，已绑 1 台时省略则自动保留该设备',
            },
          },
        },
        DisableLicenseRequest: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              description: '密钥活跃且有绑定设备时须显式确认影响范围（AC7）',
            },
          },
        },

        // ── 客户端激活（P0-A-01） ──
        ActivateRequest: {
          type: 'object',
          required: ['code', 'fingerprint'],
          properties: {
            code: { type: 'string', example: 'MTRK-XXXX-XXXX-XXXX-XXXX', description: '密钥明文' },
            fingerprint: { type: 'string', description: '本机硬件指纹' },
            deviceLabel: { type: 'string', maxLength: 64, description: '设备可识别标识' },
          },
        },
        ActivateResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                alreadyActivated: { type: 'boolean', description: 'true = 该设备此前已激活（幂等）' },
                keyId: { type: 'string' },
                device: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    deviceLabel: { type: 'string', nullable: true },
                    boundAt: { type: 'string', format: 'date-time' },
                  },
                },
                team: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    expiresAt: { type: 'string', format: 'date-time' },
                  },
                },
                clientId: { type: 'string', description: '客户端标识（限流维度）' },
                accessToken: { type: 'string', description: 'Bearer access token' },
                accessTokenExpiresInMs: { type: 'integer' },
                refreshToken: { type: 'string', description: '用于续期的 refresh token' },
                refreshTokenExpiresInMs: { type: 'integer' },
                note: {
                  type: 'string',
                  description: 'AC16：新增设备激活成功时提示原设备仍占用名额',
                },
              },
            },
          },
        },

        // ── 渠道账号（P0-C-03 AC1 / P0-B-10 AC1） ──
        SyncChannelAccountsRequest: {
          type: 'object',
          required: ['accounts'],
          properties: {
            accounts: {
              type: 'array',
              maxItems: 500,
              description:
                '本机全部**未删除**账号构成的完整快照；空数组表示本机已无账号（全部软删）',
              items: {
                type: 'object',
                required: ['channelAccountId', 'channel', 'accountName'],
                properties: {
                  channelAccountId: {
                    type: 'string',
                    maxLength: 128,
                    description: '客户端侧稳定标识（本地 port.id，单机内唯一）',
                  },
                  channel: { type: 'string', enum: ['TELEGRAM', 'WHATSAPP'] },
                  accountName: {
                    type: 'string',
                    maxLength: 64,
                    description: '客服自定义别名（P0-C-18「账号名称」）',
                  },
                },
              },
            },
          },
        },
        ChannelAccountItem: {
          type: 'object',
          properties: {
            channelAccountId: { type: 'string' },
            accountId: { type: 'string', description: '同 channelAccountId（兼容旧前端字段名）' },
            channelAccountKey: { type: 'string', example: 'TELEGRAM:k9x2m' },
            channel: { type: 'string', enum: ['TELEGRAM', 'WHATSAPP'] },
            accountName: { type: 'string' },
            status: {
              type: 'string',
              enum: ['NOT_STARTED', 'WAITING_QR', 'ONLINE', 'OFFLINE'],
              description: '账号状态（不含 RELEASED——那是端口租约语义）',
            },
            online: { type: 'boolean', description: 'status === ONLINE' },
            isHeld: { type: 'boolean', description: '是否占用端口' },
            portsHeld: { type: 'integer', description: '占用端口数（0 或 1）' },
            leaseId: { type: 'string', nullable: true, description: '当前 HELD 租约；未启动为 null' },
            keyId: { type: 'string' },
            keyNickname: { type: 'string' },
            clientId: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time', description: '账号添加时刻' },
            acquiredAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: '当前租约占用时刻；未启动为 null',
            },
            lastSeenAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: '最后一次心跳时刻；未启动为 null',
            },
            releasedAt: { type: 'string', format: 'date-time', nullable: true },
            proxyExit: { type: 'string' },
            timezone: { type: 'string', example: 'Asia/Shanghai' },
          },
        },
        ImAccountsResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ChannelAccountItem' },
                },
                summary: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' },
                    online: { type: 'integer' },
                    offline: { type: 'integer', description: '离线但仍占端口' },
                    waitingQr: { type: 'integer' },
                    notStarted: { type: 'integer', description: '已添加但未启动（不占端口）' },
                    portsHeld: { type: 'integer' },
                  },
                },
                timezone: { type: 'string', example: 'Asia/Shanghai' },
              },
            },
          },
        },
        SyncChannelAccountsResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                created: { type: 'integer' },
                updated: { type: 'integer' },
                deleted: { type: 'integer', description: '本次软删数量' },
                total: { type: 'integer', description: '对账后本机账号总数' },
                accounts: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ChannelAccountItem' },
                },
                timezone: { type: 'string', example: 'Asia/Shanghai' },
              },
            },
          },
        },

        // ── 端口租约（P0-C-20） ──
        AcquirePortRequest: {
          type: 'object',
          required: ['channelAccountKey'],
          properties: {
            channelAccountKey: {
              type: 'string',
              description: '客户端原始上报值（历史字段）：可传 `channel:id` 或裸 id',
              example: 'telegram:123456789',
            },
            channelAccountId: {
              type: 'string',
              description:
                '规范化账号标识（客户端本地 port.id）；不传则从 channelAccountKey 解析。建议升级后的客户端传全',
            },
            channel: {
              type: 'string',
              enum: ['TELEGRAM', 'WHATSAPP'],
              description: '渠道；不传则按 channelAccountKey 冒号前缀识别（识别不出则不落渠道）',
            },
          },
        },
        AcquirePortResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                leaseId: { type: 'string' },
                teamId: { type: 'string' },
                keyId: { type: 'string' },
                clientId: { type: 'string' },
                channelAccountKey: { type: 'string' },
                channelAccountId: { type: 'string', description: '规范化后的账号标识' },
                status: { type: 'string', enum: ['HELD'] },
                acquiredAt: { type: 'string', format: 'date-time' },
                lastSeenAt: { type: 'string', format: 'date-time' },
                alreadyHeld: { type: 'boolean', description: 'true = 同 (clientId, 账号标识) 已有 HELD（幂等）' },
                timezone: { type: 'string', example: 'Asia/Shanghai' },
              },
            },
          },
        },
        HeartbeatRequest: {
          type: 'object',
          required: ['leaseIds'],
          properties: {
            leaseIds: {
              type: 'array',
              items: { type: 'string' },
              description: '本机持有的全部 leaseId',
            },
            channelStatuses: {
              type: 'array',
              description:
                '可选：各租约的渠道业务状态（P0-C-03 AC4/AC8/AC9/AC10）。仅本人名下且仍 HELD 的租约会被写入；老客户端不传则行为不变',
              items: {
                type: 'object',
                required: ['leaseId', 'status'],
                properties: {
                  leaseId: { type: 'string' },
                  status: { type: 'string', enum: ['ONLINE', 'WAITING_QR', 'OFFLINE'] },
                },
              },
            },
          },
        },
        HeartbeatResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                refreshedLeaseIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '本次刷新 lastSeenAt 成功的 leaseId',
                },
                revokedLeaseIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '已回收/已撤销的 leaseId，客户端须关闭对应浏览器实例并置账号「未启动」',
                },
                channelStatusUpdated: {
                  type: 'integer',
                  description: '本次写入 channelStatus 的租约数（未上报 channelStatuses 时恒为 0）',
                },
                overQuota: { type: 'boolean', description: '配额下调导致 held > quota' },
                heldCount: { type: 'integer', description: '团队当前 HELD 数' },
                portQuota: { type: 'integer', description: '团队端口配额' },
                pendingCloseLeaseIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'overQuota 时本客户端需要选择关闭的 leaseId（随心跳下发，P0-S-11 AC6）',
                },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        ReleasePortRequest: {
          type: 'object',
          required: ['leaseId'],
          properties: {
            leaseId: { type: 'string' },
          },
        },
        ReleasePortResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                alreadyReleased: { type: 'boolean', description: 'true = 早已释放（幂等）' },
                leaseId: { type: 'string' },
              },
            },
          },
        },
        ResetPortsResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                releasedCount: { type: 'integer', description: '本次释放的 HELD 端口数' },
                clientId: { type: 'string' },
              },
            },
          },
        },
        ManualReleaseRequest: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              description: '首次调用不传时返回影响提示，确认后重试（AC11）',
            },
          },
        },
        ManualReleaseResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                alreadyReleased: { type: 'boolean', description: 'true = 早已释放（幂等）' },
                leaseId: { type: 'string' },
                teamId: { type: 'string' },
                channelAccountKey: { type: 'string' },
              },
            },
          },
        },
        PortLeaseItem: {
          type: 'object',
          properties: {
            leaseId: { type: 'string' },
            teamId: { type: 'string' },
            teamName: { type: 'string' },
            keyId: { type: 'string' },
            keyNickname: { type: 'string', description: '密钥昵称' },
            licenseCode: {
              type: 'string',
              nullable: true,
              description: '完整密钥明文（AES-256-GCM 解密后返回）',
              example: 'MTRK-8F3A-21C7-9DE4-A1B2',
            },
            clientId: { type: 'string' },
            channelAccountKey: { type: 'string' },
            status: { type: 'string', enum: ['HELD', 'RELEASED'] },
            acquiredAt: { type: 'string', format: 'date-time' },
            lastSeenAt: { type: 'string', format: 'date-time' },
            releasedAt: { type: 'string', format: 'date-time', nullable: true },
            timezone: { type: 'string', example: 'Asia/Shanghai' },
          },
        },
        PortLeaseListResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/PortLeaseItem' },
            },
          },
        },
      },
      responses: {
        BadRequest: {
          description: '请求参数错误 / 业务校验不通过',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
        Unauthorized: {
          description: '缺少凭据 / 会话无效或已过期',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
        Forbidden: {
          description: '无权限 / 账号禁用 / 团队不可用',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
        NotFound: {
          description: '资源不存在',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
        Conflict: {
          description: '资源冲突（邮箱已被使用等）',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
        AccountLocked: {
          description: '账号已锁定（423 Locked），details.lockRemainingMs 为剩余毫秒',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
        RateLimited: {
          description: '请求过于频繁（429），响应头 Retry-After 指示秒数',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
        NoContent: {
          description: '操作成功，无返回体（204）',
        },
      },
    },
  },
  // 扫描所有路由文件中的 JSDoc 注释（@swagger 标准注解）
  apis: ['src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(options);

export function setupSwagger(app: import('express').Express) {
  // JSON 格式的 OpenAPI 规范文件
  app.get('/api-docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });

  // Swagger UI 页面
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: 'API 文档',
      swaggerOptions: {
        persistAuthorization: true,
        tryItOutEnabled: true,
      },
    }),
  );
}
