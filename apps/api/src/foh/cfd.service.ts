import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes, randomInt } from "node:crypto";
import type { AuthUser, CfdSessionDto, CfdState } from "@stello/shared";
import type { CfdSession, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { CfdGateway } from "./cfd.gateway";

const PAIRING_TTL_MS = 15 * 60_000;
const PAIRED_TTL_MS = 30 * 24 * 3600_000;

/**
 * Customer-facing display. The display (unauthenticated) asks for a session and
 * shows a 6-digit pairing code; a POS user types that code to bind the display
 * to their outlet. From then on the POS pushes its running cart / payment state
 * and the display renders it (socket push on the /cfd namespace + polling).
 */
@Injectable()
export class CfdService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: CfdGateway,
  ) {}

  async start(): Promise<{ token: string; pairingCode: string; expiresAt: string }> {
    return runUnscoped(async () => {
      await this.prisma.cfdSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      for (let attempt = 0; attempt < 5; attempt++) {
        const pairingCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
        const clash = await this.prisma.cfdSession.findUnique({ where: { pairingCode } });
        if (clash) continue;
        const s = await this.prisma.cfdSession.create({
          data: { token: randomBytes(24).toString("base64url"), pairingCode, expiresAt: new Date(Date.now() + PAIRING_TTL_MS) },
        });
        return { token: s.token, pairingCode, expiresAt: s.expiresAt.toISOString() };
      }
      throw new BadRequestException("Could not allocate a pairing code, try again");
    });
  }

  /** Display polls its own session by secret token. */
  async byToken(token: string): Promise<CfdSessionDto> {
    const s = await runUnscoped(() => this.prisma.cfdSession.findUnique({ where: { token } }));
    if (!s || s.expiresAt < new Date()) throw new NotFoundException("Display session expired");
    return this.toDto(s);
  }

  async pair(user: AuthUser, outletId: string, code: string): Promise<{ id: string }> {
    this.assertOutlet(user, outletId);
    // Unpaired sessions carry no tenant yet, so the lookup must bypass tenant scoping;
    // the conditional update below claims it for this tenant exactly once.
    const claimed = await runUnscoped(async () => {
      const s = await this.prisma.cfdSession.findUnique({ where: { pairingCode: code } });
      if (!s || s.tenantId || s.expiresAt < new Date()) return null;
      const res = await this.prisma.cfdSession.updateMany({
        where: { id: s.id, tenantId: null },
        data: {
          tenantId: user.tenantId,
          outletId,
          pairedById: user.id,
          pairedAt: new Date(),
          pairingCode: `paired-${s.id}`,
          expiresAt: new Date(Date.now() + PAIRED_TTL_MS),
          state: { mode: "IDLE", label: null, lines: [], subtotal: 0, discount: 0, tax: 0, total: 0, upi: null },
        },
      });
      return res.count === 1 ? s.id : null;
    });
    if (!claimed) throw new BadRequestException("That code is not valid — check the display and try again");
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "CFD_PAIRED", entity: "cfd_session", entityId: claimed, data: { outletId } },
    });
    await this.broadcast(claimed);
    return { id: claimed };
  }

  async pushState(user: AuthUser, outletId: string, id: string, state: CfdState): Promise<{ ok: true }> {
    await this.requireOwned(user, outletId, id);
    await this.prisma.cfdSession.update({
      where: { id },
      data: { state: state as unknown as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + PAIRED_TTL_MS) },
    });
    await this.broadcast(id);
    return { ok: true };
  }

  async unpair(user: AuthUser, outletId: string, id: string): Promise<{ id: string }> {
    await this.requireOwned(user, outletId, id);
    await this.prisma.cfdSession.delete({ where: { id } });
    this.gateway.emitUnpaired(id);
    return { id };
  }

  private async requireOwned(user: AuthUser, outletId: string, id: string) {
    this.assertOutlet(user, outletId);
    const s = await this.prisma.cfdSession.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!s) throw new NotFoundException("Display not paired with this outlet");
    return s;
  }

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  private async broadcast(id: string) {
    const s = await runUnscoped(() => this.prisma.cfdSession.findUnique({ where: { id } }));
    if (s) this.gateway.emitState(id, await this.toDto(s));
  }

  private async toDto(s: CfdSession): Promise<CfdSessionDto> {
    const outlet = s.outletId
      ? await runUnscoped(() =>
          this.prisma.outlet.findFirst({ where: { id: s.outletId!, tenantId: s.tenantId! }, include: { brand: true } }),
        )
      : null;
    return {
      id: s.id,
      paired: !!s.tenantId,
      pairingCode: s.tenantId ? null : s.pairingCode,
      brandName: outlet?.brand.name ?? null,
      outletName: outlet?.name ?? null,
      themeId: outlet?.brand.themeId ?? null,
      state: (s.state as CfdState | null) ?? null,
    };
  }
}
