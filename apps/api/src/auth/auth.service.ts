import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RefreshTokenService } from "./refresh-token.service";
import { AuthTokenService } from "./auth-token.service";
import { MailService } from "../mail/mail.service";
import {
  welcomeEmail,
  verifyEmail,
  resetPasswordEmail,
  passwordChangedEmail,
} from "../mail/templates";
import type { AuthUser } from "../common/decorators/current-user.decorator";

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h

const DEFAULT_WORKSPACE_SLUG = "neurion-local";

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: User["role"];
  workspaceId: string;
  emailVerified: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly authTokens: AuthTokenService,
    private readonly mail: MailService,
  ) {}

  private toPublic(u: User): PublicUser {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      role: u.role,
      workspaceId: u.workspaceId,
      emailVerified: u.emailVerified,
    };
  }

  async updateProfile(
    userId: string,
    data: { displayName?: string | null; avatarUrl?: string | null },
  ): Promise<PublicUser> {
    const patch: { displayName?: string | null; avatarUrl?: string | null } =
      {};
    if (data.displayName !== undefined)
      patch.displayName = data.displayName?.trim() || null;
    if (data.avatarUrl !== undefined)
      patch.avatarUrl = data.avatarUrl?.trim() || null;
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: patch,
    });
    return this.toPublic(user);
  }

  private async signAccessToken(u: User): Promise<string> {
    const payload: AuthUser = {
      sub: u.id,
      email: u.email,
      role: u.role,
      workspaceId: u.workspaceId,
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>("JWT_ACCESS_SECRET"),
      // Short by default (web/prod); the desktop sets a long TTL so a personal
      // machine stays logged in across restarts instead of re-prompting each launch.
      expiresIn: this.config.get<string>("JWT_ACCESS_TTL") || "15m",
    });
  }

  private async defaultWorkspaceId(): Promise<string> {
    const ws = await this.prisma.workspace.upsert({
      where: { slug: DEFAULT_WORKSPACE_SLUG },
      update: {},
      create: { name: "Neurion Local", slug: DEFAULT_WORKSPACE_SLUG },
    });
    return ws.id;
  }

  async register(
    email: string,
    password: string,
    displayName?: string,
  ): Promise<PublicUser> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException("email already registered");

    const passwordHash = await argon2.hash(password);
    const workspaceId = await this.defaultWorkspaceId();
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: displayName ?? null,
        workspaceId,
      },
    });
    // welcome + email verification (best-effort, never blocks registration)
    void this.sendWelcome(user.id, user.email);
    return this.toPublic(user);
  }

  /**
   * The account that represents whoever owns this installation. Created on
   * demand so the desktop needs no sign-up screen, and reused afterwards so the
   * user's conversations, projects and settings survive restarts.
   *
   * It gets a random password: there is no login form behind it, and leaving a
   * known one would matter the moment this database were ever exposed. If the
   * owner later wants a real account for the network, they set an email and
   * password through the normal profile flow.
   */
  async ensureLocalOwner(): Promise<User> {
    const email = "owner@neurion.local";
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) return existing;

    const passwordHash = await argon2.hash(randomBytes(32).toString("hex"));
    const workspaceId = await this.defaultWorkspaceId();
    return this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: "Owner",
        workspaceId,
        // Nothing to verify: no address was ever collected.
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
  }

  private async sendWelcome(userId: string, email: string): Promise<void> {
    try {
      const appUrl = this.mail.appUrl();
      let verifyUrl: string | null = null;
      if (this.mail.enabled) {
        const raw = await this.authTokens.issue(
          userId,
          "EMAIL_VERIFY",
          EMAIL_VERIFY_TTL_MS,
        );
        verifyUrl = `${appUrl}/verify?token=${raw}`;
      }
      await this.mail.send(email, welcomeEmail(appUrl, verifyUrl));
    } catch {
      /* best-effort */
    }
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.emailVerified) return;
    const appUrl = this.mail.appUrl();
    const raw = await this.authTokens.issue(
      userId,
      "EMAIL_VERIFY",
      EMAIL_VERIFY_TTL_MS,
    );
    await this.mail.send(
      user.email,
      verifyEmail(appUrl, `${appUrl}/verify?token=${raw}`),
    );
  }

  async verifyEmail(rawToken: string): Promise<boolean> {
    const userId = await this.authTokens.consume(rawToken, "EMAIL_VERIFY");
    if (!userId) return false;
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerified: true, emailVerifiedAt: new Date() },
    });
    return true;
  }

  /** Always resolves the same way (no account enumeration). */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== "ACTIVE") return;
    const appUrl = this.mail.appUrl();
    const raw = await this.authTokens.issue(
      user.id,
      "PASSWORD_RESET",
      PASSWORD_RESET_TTL_MS,
    );
    await this.mail.send(
      user.email,
      resetPasswordEmail(appUrl, `${appUrl}/reset?token=${raw}`),
    );
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<boolean> {
    const userId = await this.authTokens.consume(rawToken, "PASSWORD_RESET");
    if (!userId) return false;
    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    await this.mail.send(user.email, passwordChangedEmail(this.mail.appUrl()));
    return true;
  }

  /** GDPR self-erasure: verify password, then delete the account + all its data. */
  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (
      !user.passwordHash ||
      !(await argon2.verify(user.passwordHash, password))
    ) {
      throw new UnauthorizedException("password is incorrect");
    }
    await this.purgeUserData(userId);
    // forum threads/posts + auth tokens cascade via onDelete: Cascade
    await this.prisma.user.delete({ where: { id: userId } });
  }

  private async purgeUserData(userId: string): Promise<void> {
    const p = this.prisma;
    const convs = await p.chatConversation.findMany({
      where: { userId },
      select: { id: true },
    });
    const convIds = convs.map((c) => c.id);
    if (convIds.length)
      await p.chatMessage
        .deleteMany({ where: { conversationId: { in: convIds } } })
        .catch(() => undefined);
    await p.chatConversation
      .deleteMany({ where: { userId } })
      .catch(() => undefined);
    // flat userId-owned rows that don't cascade from User
    const tables = [
      "refreshToken",
      "creditLedger",
      "complianceRecord",
      "ownerReputation",
      "registrationChallenge",
      "attachment",
      "project",
      "agentMemory",
      "realtimeSession",
    ] as const;
    for (const t of tables) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (p as any)[t]
        .deleteMany({ where: { userId } })
        .catch(() => undefined);
    }
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (
      !user.passwordHash ||
      !(await argon2.verify(user.passwordHash, oldPassword))
    ) {
      throw new UnauthorizedException("current password is incorrect");
    }
    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    await this.mail.send(user.email, passwordChangedEmail(this.mail.appUrl()));
  }

  async validateCredentials(email: string, password: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash)
      throw new UnauthorizedException("invalid credentials");
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException("invalid credentials");
    if (user.status !== "ACTIVE")
      throw new ForbiddenException("account is not active");
    return user;
  }

  async issueSession(
    user: User,
    ctx: { userAgent?: string | null; ipHash?: string | null },
  ) {
    const accessToken = await this.signAccessToken(user);
    const refresh = await this.refreshTokens.issue(user.id, ctx);
    return { accessToken, refresh, user: this.toPublic(user) };
  }

  async accessTokenForUserId(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.status !== "ACTIVE")
      throw new ForbiddenException("account is not active");
    return this.signAccessToken(user);
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return this.toPublic(user);
  }
}
