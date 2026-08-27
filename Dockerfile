# syntax=docker/dockerfile:1

# 使用 Node 22 alpine 轻量基础镜像
FROM node:22-alpine

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存（仅当 package*.json 变化时才重装依赖）
# 注意：切勿在此处设置 NODE_ENV=production，否则 npm ci 会省略 devDependencies
#（@types/* 与 tsx 都在 devDependencies 中，省略后 tsc 类型检查会因找不到类型而失败）
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码与 Prisma schema
COPY . .

# 生成 Prisma Client（运行时 db push 需要）
RUN npx prisma generate

# 类型检查：类型错误会让镜像构建失败，避免带病上线
RUN npx tsc --noEmit

# 生产环境变量（必须放在依赖安装与构建步骤之后，否则会影响 npm ci 的依赖安装）
ENV NODE_ENV=production

EXPOSE 3000

# 启动流程：
# 1) prisma db push 按 schema 直接建表（项目无迁移文件，故用 push 而非 migrate deploy）
# 2) tsx 运行源码（tsx 自动解析 tsconfig 中的 @/ 路径别名，
#    避免直接 `node dist/server.js` 因无法解析 @/ 模块而崩溃）
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx tsx src/server.ts"]
