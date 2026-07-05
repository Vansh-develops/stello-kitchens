import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api/v1");
  app.enableCors({ origin: true, credentials: true });
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}/api/v1`);
}

bootstrap();
