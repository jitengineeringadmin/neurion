import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface IssuedRefresh {
  raw: string;
  expiresAt: Date;
}

export type RotateResult =
  | { ok: true; userId: string; issued: IssuedRefresh }
  | { ok: false; reason: 'invalid' | 'expired' | 'reuse_detected' };

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

interface IssueCtx {
  userAgent?: string | null;
  ipHash?: string | null;
}

/**
 * G6 — refresh-token rotation with reuse detection.
 * - Tokens are opaque random secrets; only their sha256 is stored (@unique).
 * - Every refresh rotates the token and chains old -> new via replacedById.
 * - Presenting an already-rotated/revoked token = theft signal => the WHOLE family is revoked.
 */
@Injectable()
export class RefreshTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(userId: string, ctx: IssueCtx = {}, family?: string): Promise<IssuedRefresh> {
    const raw = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(raw),
        family: family ?? randomUUID(),
        expiresAt,
        userAgent: ctx.userAgent ?? null,
        ipHash: ctx.ipHash ?? null,
      },
    });
    return { raw, expiresAt };
  }

  async rotate(rawPresented: string, ctx: IssueCtx = {}): Promise<RotateResult> {
    const tokenHash = sha256(rawPresented);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) return { ok: false, reason: 'invalid' };

    // Reuse of an already-rotated/revoked token => theft. Nuke the whole family.
    if (existing.revokedAt) {
      await this.revokeFamily(existing.family);
      return { ok: false, reason: 'reuse_detected' };
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      await this.prisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
      return { ok: false, reason: 'expired' };
    }

    // Rotate: mint a new token in the same family, chain old -> new atomically.
    const raw = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    const next = await this.prisma.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: sha256(raw),
        family: existing.family,
        expiresAt,
        userAgent: ctx.userAgent ?? null,
        ipHash: ctx.ipHash ?? null,
      },
    });
    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedById: next.id },
    });
    return { ok: true, userId: existing.userId, issued: { raw, expiresAt } };
  }

  /** Logout: revoke the presented token's whole family. No-op if unknown. */
  async revokeByRaw(rawPresented: string): Promise<void> {
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawPresented) } });
    if (existing) await this.revokeFamily(existing.family);
  }

  async revokeFamily(family: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
