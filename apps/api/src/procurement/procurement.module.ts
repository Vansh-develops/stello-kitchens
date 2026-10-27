import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import {
  InsightsController,
  PayablesController,
  ProcurementController,
  StocktakeController,
} from "./procurement.controller";
import { PurchaseOrdersService } from "./purchase-orders.service";
import { PayablesService } from "./payables.service";
import { StocktakeService } from "./stocktake.service";
import { PlanningService } from "./planning.service";
import { InsightsService } from "./insights.service";

// Procurement, stock control & insights: purchase orders + GRNs, vendor
// payables, stocktake, reorder/par planning, demand forecasting, menu engineering.
@Module({
  imports: [InventoryModule],
  controllers: [ProcurementController, PayablesController, StocktakeController, InsightsController],
  providers: [PurchaseOrdersService, PayablesService, StocktakeService, PlanningService, InsightsService],
})
export class ProcurementModule {}
