import { Controller, Get, Header, Inject } from '@nestjs/common';
import { METRICS } from '../../application/ports.ts';
import type { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics.ts';
import { Public } from './auth.ts';

/** Exposição para o Prometheus. Sem autenticação, como os health checks. */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
