import { ErrorRequestHandler } from 'express';
import { env } from '@/config/env';
import { AppError } from '@/utils/AppError';
import { Prisma } from '@prisma/client';
import { ErrorCode, ErrorCodeValue } from '@/constants/errorCodes';

export const errorHandler: ErrorRequestHandler = (
  err,
  _req,
  res,
  _next,
) => {
  let statusCode = 500;
  let message = '服务器内部错误';
  let code: ErrorCodeValue = ErrorCode.INTERNAL_ERROR;
  let details: unknown | undefined;
  let retryAfterMs: number | undefined;
  let retryAfterSec: number | undefined;

  // 自定义业务错误
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    // AppError.code 允许自定义字符串，此处收敛为 ErrorCodeValue 响应
    code = err.code as ErrorCodeValue;
    details = err.details;

    // 限流：429 + Retry-After（P0-A-02 AC10）
    if (statusCode === 429 && details && typeof details === 'object') {
      const d = details as { retryAfterMs?: number };
      retryAfterMs = d.retryAfterMs ?? 0;
      retryAfterSec = Math.ceil(retryAfterMs / 1000);
    }
  }

  // Prisma 已知错误
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        statusCode = 409;
        message = '唯一约束冲突，资源已存在';
        code = ErrorCode.CONFLICT;
        break;
      case 'P2025':
        statusCode = 404;
        message = '资源不存在';
        code = ErrorCode.NOT_FOUND;
        break;
      case 'P2003':
        statusCode = 400;
        message = '外键约束失败';
        code = ErrorCode.PARAM_INVALID;
        break;
      default:
        statusCode = 400;
        message = `数据库错误: ${err.code}`;
        code = ErrorCode.INTERNAL_ERROR;
    }
  }

  // 开发环境打印完整错误堆栈
  if (env.isDev) {
    console.error(err);
  }

  if (retryAfterSec !== undefined) {
    res.setHeader('Retry-After', String(retryAfterSec));
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      ...(env.isDev && err.stack ? { stack: err.stack } : {}),
    },
  });
};
