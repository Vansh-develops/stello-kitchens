import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import {
  isOwnerLevel,
  type AuthUser,
  type MfaEnabledDto,
  type MfaSetupDto,
  type MfaStatusDto,
  type SecuritySettingsDto,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { hashToken } from "../common/token";
import { openSecret, sealSecret } from "../common/secret-box";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp";

const RECOVERY_CODE_COUNT = 10;

/** `abcd-efgh-ijkl` style code from an unambiguous alphabet (~59 bits). */
function newRecoveryCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const chars = [...randomBytes(12)].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}
const normaliseRecovery = (code: string) => code.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * TOTP second factor: enrolment (secret -> QR/manual key -> confirm with a code),
 * login verification with replay protection, single-use hashed recovery codes,
 * disable with password re-check, and the per-tenant "owners must use 2FA"
 * policy. Lookups run unscoped-by-userId on purpose: the login step-up happens
 * before any tenant context exists, and userId is the primary key.
 */
@Injectable()
export class MfaService {
  constructor(private readonly prisma: PrismaService) {}

  private record(userId: string) {
    return runUnscoped(() => this.prisma.userMfa.findUnique({ where: { userId } }));
  }

  async isEnabled(userId: string): Promise<boolean> {
    return !!(await this.record(userId))?.enabledAt;
  }

  async policy(tenantId: string): Promise<SecuritySettingsDto> {
    const row = await runUnscoped(() => this.prisma.tenantSecurity.findUnique({ where: { tenantId } }));
    return { requireOwnerMfa: row?.requireOwnerMfa ?? false };
  }

  /** What the password step must be followed by for this user. */
  async loginRequirement(user: AuthUser): Promise<"none" | "verify" | "enroll"> {
    if (await this.isEnabled(user.id)) return "verify";
    if (isOwnerLevel(user.permissions) && (await this.policy(user.tenantId)).requireOwnerMfa) return "enroll";
    return "none";
  }

  async status(user: AuthUser): Promise<MfaStatusDto> {
    const rec = await this.record(user.id);
    const remaining = rec?.enabledAt
      ? await runUnscoped(() => this.prisma.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } }))
      : 0;
    const policy = await this.policy(user.tenantId);
    return {
      enabled: !!rec?.enabledAt,
      enabledAt: rec?.enabledAt?.toISOString() ?? null,
      recoveryCodesRemaining: remaining,
      requiredByPolicy: policy.requireOwnerMfa && isOwnerLevel(user.permissions),
    };
  }

  /** Start (or restart) enrolment: a fresh secret, pending until confirmed. */
  async beginSetup(user: { id: string; tenantId: string; email: string }): Promise<MfaSetupDto> {
    const existing = await this.record(user.id);
    if (existing?.enabledAt) throw new BadRequestException("Two-factor authentication is already on");
    const secret = generateTotpSecret();
    await runUnscoped(() =>
      this.prisma.userMfa.upsert({
        where: { userId: user.id },
        create: { userId: user.id, tenantId: user.tenantId, secretEnc: sealSecret(secret) },
        update: { secretEnc: sealSecret(secret), enabledAt: null, lastUsedStep: null },
      }),
    );
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  /** Confirm enrolment with a first code; returns the one-time recovery codes. */
  async confirmSetup(user: { id: string; tenantId: string }, code: string): Promise<MfaEnabledDto> {
    const rec = await this.record(user.id);
    if (!rec) throw new BadRequestException("Start two-factor setup first");
    if (rec.enabledAt) throw new BadRequestException("Two-factor authentication is already on");
    const step = verifyTotp(openSecret(rec.secretEnc), code);
    if (step === null) {
      throw new BadRequestException("That code did not match. Check the time on your phone and try again.");
    }
    const recoveryCodes = await runUnscoped(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.userMfa.update({ where: { userId: user.id }, data: { enabledAt: new Date(), lastUsedStep: step } });
        return this.replaceRecoveryCodes(tx, user);
      }),
    );
    await this.audit(user, "MFA_ENABLED");
    return { recoveryCodes };
  }

  /**
   * Verify a TOTP code (or a recovery code) for an enabled user. Codes are
   * single-use: the accepted time-step is recorded with a compare-and-set so a
   * captured code can't be replayed, even by a concurrent request.
   */
  async verify(user: { id: string; tenantId: string }, input: { code?: string; recoveryCode?: string }): Promise<void> {
    const rec = await this.record(user.id);
    if (!rec?.enabledAt) throw new UnauthorizedException("Two-factor authentication is not enabled");
    if (input.code) {
      const step = verifyTotp(openSecret(rec.secretEnc), input.code);
      if (step === null || (rec.lastUsedStep !== null && step <= rec.lastUsedStep)) {
        await this.audit(user, "MFA_FAILED");
        throw new UnauthorizedException("Invalid authentication code");
      }
      const claimed = await runUnscoped(() =>
        this.prisma.userMfa.updateMany({
          where: { userId: user.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
          data: { lastUsedStep: step },
        }),
      );
      if (claimed.count !== 1) throw new UnauthorizedException("Invalid authentication code");
      return;
    }
    if (input.recoveryCode) {
      const hash = hashToken(normaliseRecovery(input.recoveryCode));
      const used = await runUnscoped(() =>
        this.prisma.mfaRecoveryCode.updateMany({
          where: { userId: user.id, codeHash: hash, usedAt: null },
          data: { usedAt: new Date() },
        }),
      );
      if (used.count !== 1) {
        await this.audit(user, "MFA_FAILED");
        throw new UnauthorizedException("Invalid recovery code");
      }
      await this.audit(user, "MFA_RECOVERY_CODE_USED");
      return;
    }
    throw new BadRequestException("Provide a code");
  }

  /** Password re-check; when 2FA is on, a current code is also required. */
  async reauthenticate(user: AuthUser, password: string, code?: string): Promise<void> {
    const row = await runUnscoped(() =>
      this.prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } }),
    );
    if (!row || !(await bcrypt.compare(password, row.passwordHash))) {
      throw new UnauthorizedException("Password is incorrect");
    }
    if (await this.isEnabled(user.id)) {
      if (!code) throw new BadRequestException("Enter a current authentication code");
      await this.verify(user, { code });
    }
  }

  async disable(user: AuthUser, password: string, code?: string): Promise<void> {
    if ((await this.status(user)).requiredByPolicy) {
      throw new BadRequestException("Your restaurant requires two-factor authentication for owners");
    }
    await this.reauthenticate(user, password, code);
    await runUnscoped(() =>
      this.prisma.$transaction([
        this.prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
        this.prisma.userMfa.deleteMany({ where: { userId: user.id } }),
      ]),
    );
    await this.audit(user, "MFA_DISABLED");
  }

  async regenerateRecoveryCodes(user: AuthUser, password: string, code?: string): Promise<MfaEnabledDto> {
    if (!(await this.isEnabled(user.id))) throw new BadRequestException("Two-factor authentication is not enabled");
    await this.reauthenticate(user, password, code);
    const recoveryCodes = await runUnscoped(() => this.prisma.$transaction((tx) => this.replaceRecoveryCodes(tx, user)));
    await this.audit(user, "MFA_RECOVERY_CODES_REGENERATED");
    return { recoveryCodes };
  }

  async setPolicy(user: AuthUser, requireOwnerMfa: boolean): Promise<SecuritySettingsDto> {
    // Don't let an owner lock themselves out with their own policy.
    if (requireOwnerMfa && isOwnerLevel(user.permissions) && !(await this.isEnabled(user.id))) {
      throw new BadRequestException("Turn on two-factor authentication for your own account first");
    }
    await runUnscoped(() =>
      this.prisma.tenantSecurity.upsert({
        where: { tenantId: user.tenantId },
        create: { tenantId: user.tenantId, requireOwnerMfa },
        update: { requireOwnerMfa },
      }),
    );
    await runUnscoped(() =>
      this.prisma.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: "SECURITY_POLICY_UPDATED", entity: "tenant", entityId: user.tenantId, data: { requireOwnerMfa } },
      }),
    );
    return { requireOwnerMfa };
  }

  private async replaceRecoveryCodes(tx: Prisma.TransactionClient, user: { id: string; tenantId: string }): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((c) => ({ tenantId: user.tenantId, userId: user.id, codeHash: hashToken(normaliseRecovery(c)) })),
    });
    return codes;
  }

  private audit(user: { id: string; tenantId: string }, action: string) {
    return runUnscoped(() =>
      this.prisma.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action, entity: "user", entityId: user.id },
      }),
    );
  }
}
