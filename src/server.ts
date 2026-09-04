import { createApp } from '@/app';
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { authService } from '@/services/auth.service';
import { portService } from '@/services/port.service';
import { usageService } from '@/services/usage.service';
import { ensureLanguageSupport, syncLanguageSupport } from '@/services/translation/langSupport';
import cron from 'node-cron';

const app = createApp();

// 启动流程：先初始化平台管理员（P0-A-19 AC1），再开始监听
async function start(): Promise<void> {
  await prisma.$connect();
  await authService.ensurePlatformAdmin();

  // 语种清单预置（T4-04）：EngineLanguageSupport 为空时写入默认 Google/DeepL 清单
  await ensureLanguageSupport();

  // 端口租约回收扫描任务（P0-C-20 AC5/AC6，backend §6.1）
  // 按 LEASE_SCAN_INTERVAL 定期扫描 lastSeenAt + LEASE_TTL < now 且 status=HELD 的租约
  const leaseScanMinutes = Math.max(1, Math.floor(env.leaseScanIntervalMs / 60_000));
  cron.schedule(`*/${leaseScanMinutes} * * * *`, async () => {
    try {
      const released = await portService.sweepExpiredLeases();
      if (released > 0) {
        console.log(`[cron] 租约回收：${released} 个过期端口已释放`);
      }
    } catch (err) {
      console.error('[cron] 租约回收扫描失败:', err);
    }
  });
  console.log(`[cron] 租约回收扫描已启动，间隔 ${leaseScanMinutes} 分钟（LEASE_TTL=${env.leaseTtlMs}ms）`);

  // 引擎语种清单每日同步（T4-04 / backend §7.4）：LANG_SYNC_CRON（默认 04:00 UTC，best-effort）
  cron.schedule(env.langSyncCron, async () => {
    try {
      await syncLanguageSupport();
    } catch (err) {
      console.error('[cron] 语种清单同步失败:', err);
    }
  });
  console.log(`[cron] 引擎语种清单同步已启动，计划：${env.langSyncCron}（UTC）`);

  // 近 24h 用量聚合任务（T5-03 / backend §8.3）：每小时聚合一次 KeyDailyUsage 缓存表
  cron.schedule('0 * * * *', async () => {
    try {
      const aggregated = await usageService.aggregateKeyDailyUsage();
      if (aggregated > 0) {
        console.log(`[cron] KeyDailyUsage 聚合：${aggregated} 条记录已更新`);
      }
    } catch (err) {
      console.error('[cron] KeyDailyUsage 聚合失败:', err);
    }
  });
  console.log('[cron] KeyDailyUsage 每小时聚合任务已启动');

  const server = app.listen(env.port, () => {
    console.log(`🚀 服务已启动: http://localhost:${env.port}`);
    console.log(`📋 环境: ${env.nodeEnv}`);
  });

  // ── 连接保持参数（修复浏览器随机 ERR_FAILED / 误报 CORS）───────────────
  // Node 默认 keepAliveTimeout 仅 5s，而浏览器（尤其常驻客户端、2 分钟心跳轮询）
  // 会长期复用连接池里的 TCP 连接。当服务端在 5s 空闲后发出 FIN 关闭连接、
  // 浏览器尚未感知并恰好复用该连接发请求时，请求会在对端已关闭的连接上发出，
  // 浏览器收不到任何响应，只能报 net::ERR_FAILED，并因「无响应头可判」
  // 误报为 CORS 错误（No 'Access-Control-Allow-Origin' header）。
  // 症状：curl 始终正常、前端随机偶发、概率低 —— 典型的 keep-alive 竞态。
  //
  // 修复：将空闲超时抬到 65s（大于浏览器/常见 LB 的 60s），让服务端
  // 永远不要先于客户端关闭连接；headersTimeout 必须严格大于 keepAliveTimeout，
  // 否则 Node 会打印告警并强制对齐（Node >= 13 的约束）。
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // 单个连接上的请求间隔上限（Node >= 18 支持），防止慢速连接长期占位
  server.requestTimeout = 30_000;

  // 优雅关闭
  // exitCode: 正常信号退出用 0；异常退出（uncaughtException）用 1，
  //           便于 Docker / 监控系统识别为异常重启。
  // 兜底：server.close() 的回调需等待所有在途连接结束，若连接迟迟不释放
  //       （长轮询 / 客户端不响应 FIN），进程会永久挂起无法被 restart 策略拉起。
  //       故设置 10s 强制退出计时器，超时则立即 exit，保证容器能重启恢复服务。
  function gracefulShutdown(signal: string, exitCode = 0) {
    console.log(`\n收到 ${signal} 信号，正在关闭服务...`);

    const forceExitTimer = setTimeout(() => {
      console.warn(`[shutdown] 优雅关闭超时（10s），强制退出（code=${exitCode}）`);
      process.exit(exitCode);
    }, 10_000);
    // 不阻止事件循环退出
    forceExitTimer.unref();

    server.close(async () => {
      clearTimeout(forceExitTimer);
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[shutdown] Prisma 断开失败:', err);
      }
      console.log('服务已关闭');
      process.exit(exitCode);
    });
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // ── 异常兜底 ──────────────────────────────────────────────────────────
  // 未处理的 Promise 拒绝：仅记录，**不退出进程**。
  // 生产环境中一个局部的 async 错误（某个 Promise 漏了 catch）不应拉垮整个服务——
  // 原实现直接 gracefulShutdown + process.exit(0)，会让服务整体下线数秒，
  // 期间所有请求失败且退出码为 0，从 docker ps 的 STATUS 看不出异常（须看 RESTARTS）。
  // 这是「前端随机 ERR_FAILED」的第二个成因。此处降级为记录日志，交由请求级
  // errorHandler 处理可感知的错误；无法归因的 rejection 记日志后继续服务。
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection] 未处理的 Promise 拒绝（服务继续运行）:', reason);
  });

  // 未捕获异常：进程状态可能已损坏，无法安全继续，按 Node 官方建议退出并由
  // 容器 restart 策略拉起。退出码用 1 以便 Docker / 监控识别为异常退出。
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException] 未捕获的异常，即将退出:', err);
    gracefulShutdown('uncaughtException', 1);
  });
}

start().catch((err) => {
  console.error('服务启动失败:', err);
  process.exit(1);
});
