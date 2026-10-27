import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  GiftCardBalanceDto,
  GiftCardDetailDto,
  GiftCardDto,
  GiftCardKind,
  GiftCardStatus,
  GiftCardTxnDto,
  IssueGiftCardInput,
} from "@stello/shared";
import { fromPaise, istDateOf, normaliseGiftCode, toPaise } from "@stello/shared";
import { Prisma } from "@prisma/client";
import { randomInt } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
// No 0/O/1/I — codes are read aloud and typed at the counter.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** "GC" / "SC" + 12 random characters (~60 bits): not guessable, easy to type. */
export function newGiftCode(prefix: "GC" | "SC"): string {
  let s = prefix;
  for (let i = 0; i < 12; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** Display form: GC-XXXX-XXXX-XXXX. */
export const formatGiftCode = (code: string) => code.replace(/^(..)(....)(....)(....)$/, "$1-$2-$3-$4");

const dateStr = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const isExpired = (expiresOn: Date | null) => !!expiresOn && dateStr(expiresOn)! < istDateOf(new Date());

type LockedCard = { id: string; balance: Prisma.Decimal; status: string; expiresOn: Date | null };

/**
 * Redeem gift card payments inside the settlement transaction. Each card row is
 * locked (in a stable order, so two settlements touching the same cards cannot
 * deadlock) before its balance is checked and decremented — concurrent
 * redemptions of one card serialise and can never overspend it. Any failure
 * throws and rolls the whole settlement back.
 */
export async function redeemGiftCardsTx(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; outletId: string; orderId: string; userId: string | null; payments: { code: string; amount: number }[] },
): Promise<void> {
  const byCode = new Map<string, number>();
  for (const p of params.payments) {
    const code = normaliseGiftCode(p.code);
    byCode.set(code, (byCode.get(code) ?? 0) + toPaise(p.amount));
  }
  for (const code of [...byCode.keys()].sort()) {
    const amount = byCode.get(code)!;
    const rows = await tx.$queryRaw<LockedCard[]>`
      SELECT id, balance, status, "expiresOn" FROM gift_cards
      WHERE "tenantId" = ${params.tenantId} AND code = ${code} FOR UPDATE`;
    const card = rows[0];
    if (!card) throw new BadRequestException(`Gift card ${formatGiftCode(code)} not found`);
    if (card.status !== "ACTIVE") throw new BadRequestException(`Gift card ${formatGiftCode(code)} is void`);
    if (isExpired(card.expiresOn)) throw new BadRequestException(`Gift card ${formatGiftCode(code)} has expired`);
    const balance = toPaise(N(card.balance));
    if (balance < amount) {
      throw new BadRequestException(`Gift card ${formatGiftCode(code)} balance is ₹${fromPaise(balance).toFixed(2)}`);
    }
    const after = fromPaise(balance - amount);
    await tx.giftCard.update({ where: { id: card.id }, data: { balance: after } });
    await tx.giftCardTxn.create({
      data: {
        tenantId: params.tenantId,
        giftCardId: card.id,
        outletId: params.outletId,
        type: "REDEEM",
        amount: -fromPaise(amount),
        balanceAfter: after,
        orderId: params.orderId,
        userId: params.userId,
      },
    });
  }
}

/** Issue store credit (e.g. for a refund) inside the caller's transaction. Returns the new code. */
export async function issueStoreCreditTx(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; outletId: string; amount: number; orderId: string | null; userId: string | null; note?: string | null; customerPhone?: string | null; customerName?: string | null },
): Promise<string> {
  const code = newGiftCode("SC");
  const card = await tx.giftCard.create({
    data: {
      tenantId: params.tenantId,
      issuedOutletId: params.outletId,
      code,
      kind: "STORE_CREDIT",
      initialValue: params.amount,
      balance: params.amount,
      customerName: params.customerName ?? null,
      customerPhone: params.customerPhone ?? null,
      note: params.note ?? null,
      issuedById: params.userId,
    },
  });
  await tx.giftCardTxn.create({
    data: {
      tenantId: params.tenantId,
      giftCardId: card.id,
      outletId: params.outletId,
      type: "STORE_CREDIT",
      amount: params.amount,
      balanceAfter: params.amount,
      orderId: params.orderId,
      userId: params.userId,
      note: params.note ?? "Refund to store credit",
    },
  });
  return code;
}

@Injectable()
export class GiftCardsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async issue(user: AuthUser, outletId: string, input: IssueGiftCardInput): Promise<GiftCardDto> {
    this.assertOutlet(user, outletId);
    if (input.expiresOn && input.expiresOn < istDateOf(new Date())) throw new BadRequestException("Expiry is in the past");
    const card = await this.prisma.$transaction(async (tx) => {
      const code = newGiftCode("GC");
      const card = await tx.giftCard.create({
        data: {
          tenantId: user.tenantId,
          issuedOutletId: outletId,
          code,
          initialValue: input.amount,
          balance: input.amount,
          expiresOn: input.expiresOn ? new Date(`${input.expiresOn}T00:00:00Z`) : null,
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          note: input.note ?? null,
          issuedById: user.id,
        },
      });
      await tx.giftCardTxn.create({
        data: {
          tenantId: user.tenantId,
          giftCardId: card.id,
          outletId,
          type: "ISSUE",
          amount: input.amount,
          balanceAfter: input.amount,
          paymentMode: input.paymentMode,
          userId: user.id,
          note: input.note ?? null,
        },
      });
      // Cash taken for the card goes into the open drawer (a liability, not a sale).
      if (input.paymentMode === "CASH") {
        const session = await tx.cashSession.findFirst({ where: { tenantId: user.tenantId, outletId, status: "OPEN" } });
        if (session) {
          await tx.cashMovement.create({
            data: { sessionId: session.id, type: "PAY_IN", amount: input.amount, category: "GIFT_CARD_SALE", note: `Gift card ${formatGiftCode(code)}` },
          });
        }
      }
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: "GIFT_CARD_ISSUED",
          entity: "gift_card",
          entityId: card.id,
          data: { amount: input.amount, paymentMode: input.paymentMode, outletId },
        },
      });
      return card;
    });
    return this.toDto(card);
  }

  async list(user: AuthUser, q?: string): Promise<GiftCardDto[]> {
    const term = q?.trim();
    const cards = await this.prisma.giftCard.findMany({
      where: {
        tenantId: user.tenantId,
        ...(term
          ? { OR: [{ code: { contains: normaliseGiftCode(term) } }, { customerPhone: { contains: term } }, { customerName: { contains: term, mode: "insensitive" as const } }] }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return cards.map((c) => this.toDto(c));
  }

  async detail(user: AuthUser, id: string): Promise<GiftCardDetailDto> {
    const card = await this.prisma.giftCard.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { txns: { orderBy: { createdAt: "desc" } } },
    });
    if (!card) throw new NotFoundException("Gift card not found");
    return {
      ...this.toDto(card),
      ledger: card.txns.map(
        (t): GiftCardTxnDto => ({
          id: t.id,
          type: t.type as GiftCardTxnDto["type"],
          amount: N(t.amount),
          balanceAfter: N(t.balanceAfter),
          orderId: t.orderId,
          outletId: t.outletId,
          paymentMode: t.paymentMode,
          note: t.note,
          createdAt: t.createdAt.toISOString(),
        }),
      ),
    };
  }

  /** POS balance check. Same response shape for unknown codes — no enumeration hints beyond "not found". */
  async balance(user: AuthUser, outletId: string, rawCode: string): Promise<GiftCardBalanceDto> {
    this.assertOutlet(user, outletId);
    const code = normaliseGiftCode(rawCode ?? "");
    const card = code ? await this.prisma.giftCard.findFirst({ where: { tenantId: user.tenantId, code } }) : null;
    if (!card) return { code: rawCode, kind: "GIFT_CARD", balance: 0, usable: false, reason: "Card not found", expiresOn: null };
    const expired = isExpired(card.expiresOn);
    const reason = card.status !== "ACTIVE" ? "Card is void" : expired ? "Card has expired" : N(card.balance) <= 0 ? "No balance left" : null;
    return {
      code: formatGiftCode(card.code),
      kind: card.kind as GiftCardKind,
      balance: N(card.balance),
      usable: !reason,
      reason,
      expiresOn: dateStr(card.expiresOn),
    };
  }

  async void(user: AuthUser, id: string, reason: string): Promise<GiftCardDto> {
    const card = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedCard[]>`
        SELECT id, balance, status, "expiresOn" FROM gift_cards WHERE id = ${id} AND "tenantId" = ${user.tenantId} FOR UPDATE`;
      const locked = rows[0];
      if (!locked) throw new NotFoundException("Gift card not found");
      if (locked.status === "VOID") throw new BadRequestException("Gift card is already void");
      const existing = await tx.giftCard.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
      const updated = await tx.giftCard.update({
        where: { id },
        data: { status: "VOID", balance: 0, voidedAt: new Date(), voidReason: reason },
      });
      await tx.giftCardTxn.create({
        data: {
          tenantId: user.tenantId,
          giftCardId: id,
          outletId: existing.issuedOutletId,
          type: "VOID",
          amount: -N(locked.balance),
          balanceAfter: 0,
          userId: user.id,
          note: reason,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: "GIFT_CARD_VOIDED",
          entity: "gift_card",
          entityId: id,
          data: { forfeited: N(locked.balance), reason },
        },
      });
      return updated;
    });
    return this.toDto(card);
  }

  private toDto(c: {
    id: string;
    code: string;
    kind: string;
    initialValue: Prisma.Decimal;
    balance: Prisma.Decimal;
    status: string;
    expiresOn: Date | null;
    customerName: string | null;
    customerPhone: string | null;
    issuedOutletId: string;
    createdAt: Date;
  }): GiftCardDto {
    return {
      id: c.id,
      code: formatGiftCode(c.code),
      kind: c.kind as GiftCardKind,
      initialValue: N(c.initialValue),
      balance: N(c.balance),
      status: c.status as GiftCardStatus,
      expired: isExpired(c.expiresOn),
      expiresOn: dateStr(c.expiresOn),
      customerName: c.customerName,
      customerPhone: c.customerPhone,
      issuedOutletId: c.issuedOutletId,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
