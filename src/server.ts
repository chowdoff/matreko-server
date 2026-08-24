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

  // 优雅关闭
  async function gracefulShutdown(signal: string) {
    console.log(`\n收到 ${signal} 信号，正在关闭服务...`);
    server.close(async () => {
      await prisma.$disconnect();
      console.log('服务已关闭');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // 未捕获异常处理
  process.on('unhandledRejection', (err) => {
    console.error('未处理的 Promise 拒绝:', err);
    gracefulShutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    console.error('未捕获的异常:', err);
    gracefulShutdown('uncaughtException');
  });
}

start().catch((err) => {
  console.error('服务启动失败:', err);
  process.exit(1);
});
