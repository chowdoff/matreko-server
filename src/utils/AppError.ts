import { ErrorCode, ErrorCodeValue } from '@/constants/errorCodes';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code: ErrorCodeValue | string = ErrorCode.INTERNAL_ERROR,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static of(
    statusCode: number,
    code: ErrorCodeValue | string,
    message: string,
    details?: unknown,
  ) {
    return new AppError(statusCode, message, code, details);
  }

  static badRequest(message = '请求参数错误', details?: unknown) {
    return new AppError(400, message, ErrorCode.PARAM_INVALID, details);
  }

  static unauthorized(
    message = '未授权',
    code: ErrorCodeValue | string = ErrorCode.UNAUTHORIZED,
  ) {
    return new AppError(401, message, code);
  }

  static forbidden(
    message = '禁止访问',
    code: ErrorCodeValue | string = ErrorCode.KEY_DISABLED,
  ) {
    return new AppError(403, message, code);
  }

  static notFound(message = '资源不存在') {
    return new AppError(404, message, ErrorCode.NOT_FOUND);
  }

  static conflict(
    message = '资源冲突',
    code: ErrorCodeValue | string = ErrorCode.CONFLICT,
    details?: unknown,
  ) {
    return new AppError(409, message, code, details);
  }

  static tooManyRequests(message = '请求过于频繁', retryAfterMs = 0) {
    const err = new AppError(429, message, ErrorCode.RATE_LIMITED, {
      retryAfterMs,
    });
    return err;
  }

  /** 后台账号锁定（P0-A-19 AC7），423 Locked */
  static locked(message = '账号已锁定', lockRemainingMs = 0) {
    return new AppError(423, message, ErrorCode.ACCOUNT_LOCKED, {
      lockRemainingMs,
    });
  }

  static internal(message = '服务器内部错误') {
    return new AppError(500, message, ErrorCode.INTERNAL_ERROR);
  }
}
