import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * Prometheus exposition endpoint. Kept public (no JWT) because Prometheus
 * scrapers don't carry our auth headers — deployment-level network policies
 * (ServiceMonitor + NetworkPolicy) must gate this path.
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get('metrics')
  @Header('Cache-Control', 'no-cache')
  async render(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', await this.metrics.contentType());
    res.send(await this.metrics.render());
  }
}
