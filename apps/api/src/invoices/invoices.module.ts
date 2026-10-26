import { Module } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { EINVOICE_PROVIDER, MockGspProvider, type EInvoiceProvider } from "./einvoice.provider";
import { MastersIndiaGspProvider, mastersIndiaConfigFromEnv } from "./masters-india.provider";

/** Masters India GSP when MASTERS_INDIA_USERNAME/PASSWORD are set; otherwise the mock IRP. */
export function createEInvoiceProvider(): EInvoiceProvider {
  const cfg = mastersIndiaConfigFromEnv();
  return cfg ? new MastersIndiaGspProvider(cfg) : new MockGspProvider();
}

@Module({
  controllers: [InvoicesController],
  providers: [InvoicesService, { provide: EINVOICE_PROVIDER, useFactory: createEInvoiceProvider }],
})
export class InvoicesModule {}
