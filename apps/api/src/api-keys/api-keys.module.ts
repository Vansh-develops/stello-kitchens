import { Global, Module } from "@nestjs/common";
import { ApiKeyService } from "./api-key.service";
import { ApiKeysController } from "./api-keys.controller";

/** Global so the app-wide auth guard can authenticate API keys. */
@Global()
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeysModule {}
