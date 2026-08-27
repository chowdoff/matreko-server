# 服务器部署指南（matreko-server）

基于 **GitHub Actions + Docker + GitHub Container Registry (ghcr.io)** 的自动发布流水线。
推送 `main` 后自动：构建镜像 → 推送到 ghcr → SSH 进服务器拉取并重启容器。

---

## 0. 前置条件
- 一台有公网 IP 的云服务器（以下以 Ubuntu 22.04 为例）
- 安全组/防火墙开放 **3000**（应用）与 **22**（SSH）端口
- 一个 GitHub PAT，权限勾选 `read:packages`（用于服务器拉取 ghcr 镜像）

---

## 1. 在 GitHub 配置 Secrets
仓库 `Settings → Secrets and variables → Actions → New repository secret`：

| Secret | 值 |
|---|---|
| `SSH_HOST` | 服务器公网 IP |
| `SSH_USER` | SSH 登录用户名（如 `ubuntu` / `root`） |
| `SSH_PRIVATE_KEY` | 部署私钥内容（见第 3 步生成的 `matreko-deploy` 私钥） |
| `SSH_PORT` | 可选，默认 `22` |

> 未配置这些 Secret 前，流水线只会构建镜像、跳过部署（不报错）；配置后下一次 push 即自动部署。

---

## 2. 服务器安装 Docker
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 退出重登后免 sudo 运行 docker
```

---

## 3. 生成部署 SSH 密钥
在本机或服务器执行：
```bash
ssh-keygen -t ed25519 -f matreko-deploy -N ""
cat matreko-deploy.pub        # 追加到服务器 ~/.ssh/authorized_keys
cat matreko-deploy            # 内容填入 GitHub Secret: SSH_PRIVATE_KEY
```

---

## 4. 克隆仓库并配置环境
```bash
git clone https://github.com/chowdoff/matreko-server.git /opt/matreko
cd /opt/matreko
cp deploy/env.example .env
nano .env   # 修改以下必填项
```
必须修改：
- `PLATFORM_EMAIL` / `PLATFORM_INITIAL_PASSWORD`
- `API_KEY_ENC_KEY` / `JWT_SECRET` / `LICENSE_CODE_ENC_KEY`（用下面的命令生成随机值）

生成密钥示例：
```bash
openssl rand -base64 32   # 用作 API_KEY_ENC_KEY / LICENSE_CODE_ENC_KEY
openssl rand -hex 32      # 用作 JWT_SECRET
```

---

## 5. 登录 ghcr 并首次启动
```bash
echo "<你的PAT>" | docker login ghcr.io -u chowdoff --password-stdin
docker compose up -d
```
之后每次 `git push origin main` 会自动构建镜像并 SSH 拉取重启。

---

## 6. 数据持久化
- SQLite 文件位于容器卷 `./data/prod.db`，映射到宿主机 `/opt/matreko/data`，重部署不丢数据。
- 仅支持**单实例写入**；如需多实例并发，请迁移到 PostgreSQL（并改 `prisma/schema.prisma` 的 provider）。

---

## 7. 常用运维
```bash
docker compose logs -f app   # 查看日志
docker compose restart app   # 重启
docker compose down          # 停止
docker compose pull && docker compose up -d   # 手动更新到最新镜像
```

---

## 8. 排错
- **容器起不来 / 报找不到 `@/` 模块**：说明用了 `node dist/server.js`。本镜像用 `tsx` 跑源码，正常不会出现；若自行改过 CMD 请改回 `npx tsx src/server.ts`。
- **数据库表不存在**：首次启动 `prisma db push` 会自动建表；若失败检查 `DATABASE_URL` 是否指向 `/data` 卷内路径。
- **拉取镜像 401**：服务器 `docker login ghcr.io` 用的 PAT 需有 `read:packages` 权限。
