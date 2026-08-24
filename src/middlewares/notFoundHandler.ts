import { RequestHandler } from 'express';
import { AppError } from '@/utils/AppError';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, '接口不存在'));
};
