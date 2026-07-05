import { Module } from "@nestjs/common";
import { ConnectorController, ConnectorServiceController } from "./connector.controller";
import { ConnectorService } from "./connector.service";
import { OrdersModule } from "../orders/orders.module";

@Module({
  imports: [OrdersModule],
  controllers: [ConnectorServiceController, ConnectorController],
  providers: [ConnectorService],
})
export class ConnectorModule {}
