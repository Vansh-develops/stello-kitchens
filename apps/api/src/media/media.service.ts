import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { MEDIA_LIMITS, type AuthUser } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { MEDIA_STORAGE, type MediaStorage } from "./media.storage";
import { validateImage } from "./image-inspect";

@Injectable()
export class MediaService {
  private readonly logger = new Logger("Media");

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  private maxBytes(): number {
    const configured = Number(process.env.MEDIA_MAX_BYTES);
    return Number.isFinite(configured) && configured > 0 ? configured : MEDIA_LIMITS.maxBytes;
  }

  /** Validate + store a menu item photo; replaces (and deletes) any previous one. */
  async setItemImage(user: AuthUser, outletId: string, itemId: string, file: { buffer: Buffer } | undefined) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
    if (!file?.buffer) throw new BadRequestException("Attach an image file in the `file` field");
    const item = await this.prisma.item.findFirst({ where: { id: itemId, tenantId: user.tenantId, outletId, deletedAt: null } });
    if (!item) throw new NotFoundException("Item not found");
    let info;
    try {
      info = validateImage(file.buffer, this.maxBytes());
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    // Tenant-prefixed, unguessable key; the extension comes from the sniffed type.
    const key = `items/${user.tenantId}/${itemId}-${randomBytes(6).toString("hex")}.${info.ext}`;
    const { url } = await this.storage.put(key, file.buffer, info.type);
    await this.prisma.item.update({ where: { id: itemId }, data: { imageUrl: url } });
    await this.dropOld(item.imageUrl);
    this.realtime.notifyOutlet(outletId);
    return { id: itemId, imageUrl: url, width: info.width, height: info.height };
  }

  async clearItemImage(user: AuthUser, outletId: string, itemId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
    const item = await this.prisma.item.findFirst({ where: { id: itemId, tenantId: user.tenantId, outletId } });
    if (!item) throw new NotFoundException("Item not found");
    await this.prisma.item.update({ where: { id: itemId }, data: { imageUrl: null } });
    await this.dropOld(item.imageUrl);
    this.realtime.notifyOutlet(outletId);
    return { id: itemId, imageUrl: null };
  }

  /** Public read of a locally stored object (S3 objects are served by the bucket/CDN). */
  async read(key: string): Promise<Buffer | null> {
    return this.storage.read ? this.storage.read(key) : null;
  }

  private async dropOld(url: string | null) {
    const key = url ? this.storage.keyFromUrl(url) : null;
    if (!key) return;
    await this.storage.remove(key).catch((e) => this.logger.warn(`Could not delete ${key}: ${(e as Error).message}`));
  }
}
