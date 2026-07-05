import { BadRequestException, Injectable } from "@nestjs/common";
import type { PlatformAdapter } from "./types";
import { ZomatoAdapter } from "./zomato.adapter";
import { OndcAdapter, SwiggyAdapter, UrbanPiperAdapter } from "./other.adapters";

@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>();

  constructor() {
    for (const a of [new ZomatoAdapter(), new SwiggyAdapter(), new OndcAdapter(), new UrbanPiperAdapter()]) {
      this.adapters.set(a.platform.toLowerCase(), a);
    }
  }

  get(platform: string): PlatformAdapter {
    const adapter = this.adapters.get(platform.toLowerCase());
    if (!adapter) throw new BadRequestException(`No adapter for platform "${platform}"`);
    return adapter;
  }
}
