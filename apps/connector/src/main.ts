import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ? Number(process.env.PORT) : 3003;
  await app.listen(port);
  new Logger("Connector").log(`Aggregator connector listening on http://localhost:${port}`);
}

bootstrap();
