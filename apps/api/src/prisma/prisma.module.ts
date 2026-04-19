import {
  Global,
  Injectable,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MetricsService } from '../observability/metrics/metrics.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  // MetricsService is Optional so integration specs that compile a subset of
  // the module graph still work. When absent we simply skip the $use middleware.
  constructor(@Optional() private readonly metrics?: MetricsService) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.metrics) {
      const m = this.metrics;
      // Prisma $use middleware — records every query duration without
      // touching call sites. `params.model` can be undefined for raw queries.
      this.$use(async (params, next) => {
        const op = m.bucket('dbOp', params.action);
        const model = params.model ?? 'raw';
        const start = process.hrtime.bigint();
        try {
          const out = await next(params);
          return out;
        } finally {
          const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
          m.dbQueryDurationSeconds.labels(op, model).observe(durationSec);
        }
      });
    }
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
