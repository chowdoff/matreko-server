import { Response } from 'express';

export class ApiResponse {
  static success<T>(res: Response, data: T, statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      data,
    });
  }

  static created<T>(res: Response, data: T) {
    return this.success(res, data, 201);
  }

  static error(
    res: Response,
    message: string,
    statusCode = 400,
    code = 'INTERNAL_ERROR',
    details?: unknown,
  ) {
    return res.status(statusCode).json({
      success: false,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    });
  }

  static noContent(res: Response) {
    return res.status(204).send();
  }
}
