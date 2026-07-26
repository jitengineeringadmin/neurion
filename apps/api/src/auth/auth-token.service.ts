import { Injectable } from "@nestjs/common";
import { AuthTokenPurpose } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

const hash = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

/** Single-use email-verify / password-reset tokens. Raw is emailed; only the hash is stored. */
@Injectable()
export class AuthTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /** Issue a fresh token, invalidating any prior unused tokens of the same purpose. */
  async issue(
    userId: string,
    purpose: AuthTokenPurpose,
    ttlMs: number,
  ): Promise<string> {
    await this.prisma.authToken.deleteMany({
      where: { userId, purpose, usedAt: null },
    });
    const raw = randomBytes(32).toString("base64url");
    await this.prisma.authToken.create({
      data: {
        userId,
        purpose,
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return raw;
  }

  /** Validate + consume a token. Returns the userId, or null if invalid/expired/used. */
  async consume(
    raw: string,
    purpose: AuthTokenPurpose,
  ): Promise<string | null> {
    if (!raw) return null;
    const token = await this.prisma.authToken.findUnique({
      where: { tokenHash: hash(raw) },
    });
    if (
      !token ||
      token.purpose !== purpose ||
      token.usedAt ||
      token.expiresAt < new Date()
    )
      return null;
    await this.prisma.authToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });
    return token.userId;
  }
}
