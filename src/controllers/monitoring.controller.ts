import { Request, Response, NextFunction } from 'express';
import { monitoringService } from '@/services/monitoring.service';
import { ApiResponse } from '@/utils/ApiResponse';

export class MonitoringController {
  /** 平台级运行监控 overview（P1-S-17 AC1） */
  getOverview = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await monitoringService.getOverview();
      ApiResponse.success(res, data);
    } catch (err) {
      next(err);
    }
  };
}

export const monitoringController = new MonitoringController();
