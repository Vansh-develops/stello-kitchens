import { Module } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { EINVOICE_PROVIDER, MockGspProvider } from "./einvoice.provider";

@Module({
  controllers: [InvoicesController],
  providers: [InvoicesService, { provide: EINVOICE_PROVIDER, useClass: MockGspProvider }],
})
export class InvoicesModule {}
