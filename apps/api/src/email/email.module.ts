import { Global, Module } from "@nestjs/common";
import { EMAIL_PROVIDER, LoggingEmailProvider } from "./email.provider";
@Global()
@Module({
  providers: [{ provide: EMAIL_PROVIDER, useClass: LoggingEmailProvider }],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
