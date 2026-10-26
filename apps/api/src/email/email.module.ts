import { Global, Module } from "@nestjs/common";
import { EMAIL_PROVIDER, LoggingEmailProvider, type EmailProvider } from "./email.provider";
import { SmtpEmailProvider, smtpConfigFromEnv } from "./smtp.email.provider";

/** SMTP when SMTP_HOST is set; otherwise the logging provider (dev/tests). */
export function createEmailProvider(): EmailProvider {
  const cfg = smtpConfigFromEnv();
  return cfg ? new SmtpEmailProvider(cfg) : new LoggingEmailProvider();
}

@Global()
@Module({
  providers: [{ provide: EMAIL_PROVIDER, useFactory: createEmailProvider }],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
