import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { OutletsModule } from "./outlets/outlets.module";
import { MenuModule } from "./menu/menu.module";
import { OrdersModule } from "./orders/orders.module";
import { KdsModule } from "./kds/kds.module";
import { InventoryModule } from "./inventory/inventory.module";
import { ConnectorModule } from "./connector/connector.module";
import { CrmModule } from "./crm/crm.module";
import { ReportsModule } from "./reports/reports.module";
import { PaymentsModule } from "./payments/payments.module";
import { InvoicesModule } from "./invoices/invoices.module";
import { SyncModule } from "./sync/sync.module";
import { CentralKitchenModule } from "./central-kitchen/central-kitchen.module";
import { ScanOrderModule } from "./scan-order/scan-order.module";
import { HardwareModule } from "./hardware/hardware.module";
import { CombosModule } from "./combos/combos.module";
import { DevicesModule } from "./devices/devices.module";
import { LoyaltyModule } from "./loyalty/loyalty.module";
import { BrandsModule } from "./brands/brands.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global baseline rate limit (per client IP): 300 req / 60s. Login is
    // tightened further with a per-route @Throttle in the auth controller.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
    PrismaModule,
    RealtimeModule,
    AuthModule,
    OutletsModule,
    MenuModule,
    OrdersModule,
    KdsModule,
    InventoryModule,
    ConnectorModule,
    CrmModule,
    ReportsModule,
    PaymentsModule,
    InvoicesModule,
    SyncModule,
    CentralKitchenModule,
    ScanOrderModule,
    HardwareModule,
    CombosModule,
    DevicesModule,
    LoyaltyModule,
    BrandsModule,
    HealthModule,
  ],
  providers: [
    // ThrottlerGuard first so rate limiting applies even to unauthenticated
    // routes (e.g. login) before the auth guard runs.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
