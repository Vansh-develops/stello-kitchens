import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  // rawBody: true preserves the exact received bytes on req.rawBody so inbound
  // aggregator webhooks can be HMAC/ed25519-verified against their signatures.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const port = process.env.PORT ? Number(process.env.PORT) : 3003;
  await app.listen(port);
  new Logger("Connector").log(`Aggregator connector listening on http://localhost:${port}`);
}

bootstrap();
