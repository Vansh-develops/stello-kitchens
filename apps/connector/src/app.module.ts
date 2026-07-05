import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AdapterRegistry } from "./adapters/registry";
import { MainApiService } from "./main-api.service";
import { IngestProcessor, INGEST_QUEUE } from "./ingest.processor";
import { WebhooksController } from "./webhooks.controller";
import { PushController } from "./push.controller";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>("REDIS_HOST") ?? "localhost",
          port: Number(config.get<string>("REDIS_PORT") ?? 6379),
        },
      }),
    }),
    BullModule.registerQueue({ name: INGEST_QUEUE }),
  ],
  controllers: [WebhooksController, PushController, HealthController],
  providers: [AdapterRegistry, MainApiService, IngestProcessor],
})
export class AppModule {}
