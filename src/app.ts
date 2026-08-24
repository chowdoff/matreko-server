import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from '@/config/env';
import { errorHandler } from '@/middlewares/errorHandler';
import { notFoundHandler } from '@/middlewares/notFoundHandler';
import { setupSwagger } from '@/docs/swagger';
import { supervisorAuthRouter, platformAuthRouter } from '@/routes/auth.routes';
import { teamRouter } from '@/routes/team.routes';
import { licenseRouter } from '@/routes/license.routes';
import { clientRouter } from '@/routes/client.routes';
import { clientPortRouter, supervisorPortRouter, platformPortRouter } from '@/routes/port.routes';
import { clientTranslateRouter, translationKeyRouter } from '@/routes/translation.routes';
import { supervisorUsageRouter } from '@/routes/usage.routes';
import { platformMonitoringRouter } from '@/routes/monitoring.routes';

export function createApp(): Express {
  const app = express();

  // 安全中间件
  // 本服务在局域网以明文 HTTP 提供（3000 端口无 TLS）。helmet 默认会下发
  // Strict-Transport-Security（强制仅 HTTPS）与 Content-Security-Policy: default-src 'none'，
  // 二者都会破坏 Swagger UI：
  //   - HSTS 让浏览器把 swagger-ui-bundle.js 等资源强制升级为 HTTPS → 握手失败（ERR_SSL_PROTOCOL_ERROR）；
  //   - CSP「default-src 'none'」直接拦截 UI 自带的同源 JS/CSS。
  // 处理策略：
  //   - /api-docs* 完全跳过 helmet（文档页需自行加载同源资源）；
  //   - 其余路由：仅当「确为 HTTPS 连接」时下发 HSTS，明文 HTTP 下不伪造 HSTS。
  const helmetFull = helmet();
  const helmetPlain = helmet({ hsts: false, contentSecurityPolicy: false });
  app.use((req, res, next) => {
    if (req.path.startsWith('/api-docs')) return next();
    return (req.secure ? helmetFull : helmetPlain)(req, res, next);
  });

  // CORS
  app.use(
    cors({
      origin: env.corsOrigin,
    }),
  );

  // 请求解析
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 日志
  if (env.isDev) {
    app.use(morgan('dev'));
  }

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API 路由
  // 后台鉴权：两套前缀隔离 supervisor / platform（P0-A-19 AC17）
  app.use('/api/supervisor/auth', supervisorAuthRouter);
  app.use('/api/platform/auth', platformAuthRouter);

  // 平台管理：团队管理（P0-S-11）
  app.use('/api/platform', teamRouter);

  // 主管侧：密钥管理与设备解绑（P0-B-09）
  app.use('/api/supervisor', licenseRouter);

  // 主管侧：端口管理（P0-C-20 AC11）
  app.use('/api/supervisor', supervisorPortRouter);

  // 主管侧：用量查询（P0-B-10 AC1/AC4/AC8 / P1-B-16）
  app.use('/api/supervisor', supervisorUsageRouter);

  // 管理员侧：端口管理（P0-C-20 AC11，全平台）
  app.use('/api/platform', platformPortRouter);

  // 客户端接口（P0-A-01 / P0-A-02 / P0-C-20 / 翻译代理）
  app.use('/api/client', clientRouter);
  app.use('/api/client', clientPortRouter);
  app.use('/api/client', clientTranslateRouter);

  // 管理后台：翻译引擎与 Key 管理（P0-S-12，平台管理员专属）
  app.use('/api/platform', translationKeyRouter);

  // 管理后台：运行监控 overview（P1-S-17 AC1，平台管理员专属）
  app.use('/api/platform', platformMonitoringRouter);

  // Swagger 文档（/api-docs）+ OpenAPI JSON（/api-docs.json）
  setupSwagger(app);

  // 404 处理
  app.use(notFoundHandler);

  // 错误处理（必须放最后）
  app.use(errorHandler);

  return app;
}
