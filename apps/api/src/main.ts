import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AppModule } from "./app.module";

/**
 * Allowed browser origins for cross-origin API calls. Configure via
 * CORS_ORIGINS (comma-separated). In production, default to the known staff
 * domain rather than reflecting any origin; in dev, reflect for convenience.
 */
function corsOrigin(): boolean | string[] {
  const configured = process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (configured && configured.length > 0) return configured;
  if (process.env.NODE_ENV === "production") return ["https://kitchens.stellotechs.com"];
  return true;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Behind the host nginx: trust the first proxy hop so req.ip (and the rate
  // limiter) use the real client IP from X-Forwarded-For, not nginx's address.
  app.set("trust proxy", 1);
  // Security headers. CSP is left off — this is a JSON API, not an HTML origin.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.setGlobalPrefix("api/v1");
  app.enableCors({ origin: corsOrigin(), credentials: true });
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}/api/v1`);
}

bootstrap();
