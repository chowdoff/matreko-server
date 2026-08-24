# matreko-server

基于 Express + TypeScript + Prisma + SQLite 的常规后端服务框架，内置分层架构、统一错误处理、参数校验、Swagger 自动文档与热重载开发体验。

## 技术栈

| 类别 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js >= 18 | 推荐 LTS 版本 |
| 语言 | TypeScript 5.7 | 严格模式，路径别名 `@/` → `src/` |
| Web 框架 | Express 4 | 轻量灵活，生态成熟 |
| 数据库 | SQLite | 零配置文件型数据库，开发友好 |
| ORM | Prisma 6 | 类型安全，迁移/Studio 工具齐全 |
| 参数校验 | Zod 3 | Schema 即类型，与 TypeScript 深度集成 |
| 安全 | Helmet | 自动设置安全 HTTP 头 |
| 跨域 | CORS | 可配置允许来源 |
| 日志 | Morgan | HTTP 请求日志（开发环境） |
| API 文档 | Swagger UI + swagger-jsdoc | JSDoc 注解自动生成可交互文档 |
| 代码规范 | ESLint 9 + Prettier 3 | 统一代码风格 |
| 开发工具 | tsx | 支持 TS 直接运行 + 文件监听热重载 |

## 目录结构

```
matreko-server/
├── prisma/
│   ├── schema.prisma          # 数据库模型定义
│   └── migrations/            # 迁移历史（自动生成）
├── src/
│   ├── config/
│   │   └── env.ts             # 环境变量集中管理
│   ├── docs/
│   │   └── swagger.ts         # Swagger 配置 + Schema 组件
│   ├── lib/
│   │   └── prisma.ts          # Prisma 客户端单例
│   ├── middlewares/
│   │   ├── errorHandler.ts    # 统一错误处理（含 Prisma 错误映射）
│   │   ├── notFoundHandler.ts # 404 处理
│   │   └── validate.ts        # Zod 参数校验中间件
│   ├── routes/                # 路由定义（待业务模块落地）
│   ├── controllers/           # 控制器
│   ├── services/              # 业务逻辑
│   ├── schemas/               # Zod 校验规则
│   ├── utils/
│   │   ├── AppError.ts        # 自定义业务错误类
│   │   └── ApiResponse.ts     # 统一响应格式
│   ├── app.ts                 # Express 应用与中间件装配
│   └── server.ts              # 入口文件（启动 + 优雅关闭）
├── .env                       # 环境变量（不入库）
├── .env.example               # 环境变量示例
├── eslint.config.mjs          # ESLint 配置
├── .prettierrc                # Prettier 配置
├── .gitignore
├── package.json
└── tsconfig.json
```

## 环境要求

- **Node.js** >= 18
- **npm** >= 9（或 pnpm / yarn 均可）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制示例文件并按需修改：

```bash
cp .env.example .env
```

`.env` 配置项：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务监听端口 |
| `NODE_ENV` | `development` | 运行环境（`development` / `production`） |
| `DATABASE_URL` | `file:./dev.db` | Prisma 数据库连接字符串，SQLite 为文件路径 |
| `CORS_ORIGIN` | `*` | 允许的跨域来源，多个用逗号分隔 |

### 3. 初始化数据库

```bash
# 生成 Prisma Client
npx prisma generate

# 创建数据库表结构（首次会生成迁移文件）
npx prisma migrate dev --name init
```

### 4. 启动服务

**开发模式（热重载，推荐）：**

```bash
npm run dev
```

启动后控制台输出：

```
🚀 服务已启动: http://localhost:3000
📋 环境: development
```

**生产模式：**

```bash
npm run build    # 编译 TypeScript → dist/
npm start        # 运行编译后的代码
```

### 5. 验证

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2026-08-17T..."}
```

## 停止服务

**开发模式：** 在终端按 `Ctrl + C` 即可。

服务内置优雅关闭机制（`src/server.ts`），收到 `SIGTERM` / `SIGINT` 信号时会：
1. 停止接收新请求
2. 等待正在处理的请求完成
3. 断开 Prisma 数据库连接
4. 退出进程

生产环境可用 `kill -TERM <pid>` 或容器编排工具发送 `SIGTERM` 触发优雅关闭。

## 中间件配置

中间件在 `src/app.ts` 中按顺序装配，执行顺序如下：

| 顺序 | 中间件 | 配置说明 |
|------|--------|----------|
| 1 | **Helmet** | `helmet()` — 自动设置 X-Content-Type-Options、X-Frame-Options 等安全响应头 |
| 2 | **CORS** | `cors({ origin: env.corsOrigin })` — 跨域来源由 `CORS_ORIGIN` 环境变量控制，默认允许所有来源 |
| 3 | **express.json()** | 解析 `application/json` 请求体 |
| 4 | **express.urlencoded()** | 解析 `application/x-www-form-urlencoded` 请求体，`extended: true` 支持嵌套对象 |
| 5 | **Morgan** | `morgan('dev')` — 仅在开发环境启用，输出彩色 HTTP 请求日志 |
| 6 | **业务路由** | `/health` 健康检查，业务模块路由按需挂载 |
| 7 | **Swagger** | `/api-docs`（UI）+ `/api-docs.json`（OpenAPI 规范） |
| 8 | **notFoundHandler** | 未匹配的路由返回 404 |
| 9 | **errorHandler** | 统一错误处理（必须放最后），捕获业务错误与 Prisma 错误 |

### 错误处理机制

- **业务错误**：抛出 `AppError`（`src/utils/AppError.ts`），支持 `badRequest` / `unauthorized` / `notFound` / `conflict` 等快捷方法
- **Prisma 错误**：自动映射常见错误码（`P2002` 唯一冲突→409，`P2025` 记录不存在→404，`P2003` 外键约束→400）
- **统一响应格式**：所有错误返回 `{ success: false, error: { message, details? } }`，开发环境附带 `stack`

### 参数校验

使用 Zod 在 `src/schemas/` 定义校验规则，通过 `validate` 中间件（`src/middlewares/validate.ts`）应用到路由：

```typescript
router.post('/', validate(createSchema), controller.create);
```

支持校验 `body` / `query` / `params` 三种来源，校验失败自动返回 400 + 字段级错误详情。

## 数据库

### Prisma 常用命令

| 命令 | 说明 |
|------|------|
| `npm run prisma:migrate` | 创建新迁移并应用（开发环境） |
| `npx prisma migrate deploy` | 应用已有迁移（生产环境） |
| `npm run prisma:generate` | 重新生成 Prisma Client（修改 schema 后） |
| `npm run prisma:studio` | 打开 Prisma Studio 可视化管理数据库 |

### 修改数据模型

1. 编辑 `prisma/schema.prisma`
2. 运行 `npx prisma migrate dev --name <描述>` 生成迁移
3. Prisma Client 自动重新生成

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/api-docs` | Swagger UI 交互文档 |
| GET | `/api-docs.json` | OpenAPI 3.0.3 规范 JSON |

### API 文档

服务启动后可访问两种接口文档：

| 地址 | 说明 |
|------|------|
| `http://localhost:3000/api-docs` | **Swagger UI** — 可交互测试页面，支持 Try it out 直接填参执行 |
| `http://localhost:3000/api-docs.json` | OpenAPI 3.0.3 规范 JSON，可导入 Postman / Apifox |

## 架构设计

### 分层架构

请求流转路径：

```
HTTP Request
  → Route（路由，定义 URL + HTTP 方法 + Swagger 注解）
    → Controller（控制器，处理 HTTP 请求/响应，参数校验）
      → Service（业务逻辑，调用 Prisma 操作数据库）
        → Prisma（ORM，执行 SQL）
```

| 层 | 职责 | 文件位置 |
|----|------|----------|
| Route | 路由定义、Swagger 注解 | `src/routes/` |
| Controller | 请求解析、响应封装、错误转发 | `src/controllers/` |
| Service | 业务逻辑、数据操作 | `src/services/` |
| Schema | Zod 校验规则 + 类型推导 | `src/schemas/` |

### 统一响应格式

```typescript
// 成功
{ "success": true, "data": {} }

// 失败
{ "success": false, "error": { "message": "错误信息", "details": {} } }
```

通过 `ApiResponse` 工具类（`src/utils/ApiResponse.ts`）统一封装，避免每个接口手写 `res.status().json()`。

## 新增业务模块

以「订单 Order」为例，按四层创建文件：

**1. Schema** — `src/schemas/order.schema.ts`

```typescript
import { z } from 'zod';

export const createOrderSchema = z.object({
  title: z.string().min(1),
  amount: z.number().positive(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
```

**2. Service** — `src/services/order.service.ts`

```typescript
import { prisma } from '@/lib/prisma';

export class OrderService {
  async findAll() {
    return prisma.order.findMany();
  }
}
export const orderService = new OrderService();
```

**3. Controller** — `src/controllers/order.controller.ts`

```typescript
import { orderService } from '@/services/order.service';
import { ApiResponse } from '@/utils/ApiResponse';

export class OrderController {
  findAll = async (_req, res, next) => {
    try {
      const orders = await orderService.findAll();
      ApiResponse.success(res, orders);
    } catch (err) { next(err); }
  };
}
export const orderController = new OrderController();
```

**4. Route** — `src/routes/order.routes.ts`（含 Swagger 注解）

```typescript
import { Router } from 'express';
import { orderController } from '@/controllers/order.controller';

const router = Router();

/**
 * @openapi
 * /api/orders:
 *   get:
 *     summary: 获取所有订单
 *     tags: [Orders]
 *     responses:
 *       200: { description: 成功 }
 */
router.get('/', orderController.findAll);

export { router as orderRouter };
```

**5. 注册路由** — 在 `src/app.ts` 中添加：

```typescript
import { orderRouter } from '@/routes/order.routes';
// ...
app.use('/api/orders', orderRouter);
```

**6. 注册 Tag** — 在 `src/docs/swagger.ts` 的 `tags` 数组中添加 `{ name: 'Orders', description: '订单管理' }`。

**7. 数据模型**（如需新表）— 在 `prisma/schema.prisma` 添加 model 后运行 `npx prisma migrate dev --name add_order`。

## npm 脚本

| 脚本 | 说明 |
|------|------|
| `npm run dev` | 开发模式启动（热重载） |
| `npm run build` | 编译 TypeScript → `dist/` |
| `npm start` | 生产模式启动 |
| `npm run lint` | ESLint 代码检查 |
| `npm run lint:fix` | ESLint 自动修复 |
| `npm run format` | Prettier 格式化 |
| `npm run prisma:generate` | 生成 Prisma Client |
| `npm run prisma:migrate` | 创建并应用迁移 |
| `npm run prisma:studio` | 打开 Prisma Studio |

## 代码规范

- **ESLint**（`eslint.config.mjs`）：TypeScript 推荐规则，未使用变量报错（`_` 前缀忽略），`any` 类型告警
- **Prettier**（`.prettierrc`）：单引号、分号、尾逗号、80 字符宽度、LF 换行

提交前建议运行：

```bash
npm run lint && npm run format
```
