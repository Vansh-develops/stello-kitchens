import { Module } from "@nestjs/common";
import { PreferencesController } from "./preferences.controller";

@Module({ controllers: [PreferencesController] })
export class PreferencesModule {}
