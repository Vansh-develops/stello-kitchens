import { Module } from "@nestjs/common";
import { MenuController } from "./menu.controller";
import { MenuAdminController } from "./menu-admin.controller";
import { MenuAdminService } from "./menu-admin.service";
import { CombosModule } from "../combos/combos.module";

@Module({
  imports: [CombosModule],
  controllers: [MenuController, MenuAdminController],
  providers: [MenuAdminService],
})
export class MenuModule {}
