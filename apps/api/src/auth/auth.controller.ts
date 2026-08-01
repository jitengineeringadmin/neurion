import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Req,
  Res,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { createHash } from "node:crypto";
import { AuthService } from "./auth.service";
import { RefreshTokenService } from "./refresh-token.service";
import { AuditService } from "../audit/audit.service";
import {
  LoginDto,
  RegisterDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
  ChangePasswordDto,
  DeleteAccountDto,
  UpdateProfileDto,
} from "./dto/auth.dto";
import { Public } from "../common/decorators/public.decorator";
import {
  CurrentUser,
  AuthUser,
} from "../common/decorators/current-user.decorator";

const REFRESH_COOKIE = "neurion_refresh";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private ipHash(req: Request): string | null {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)
        ?.split(",")[0]
        ?.trim() ?? req.ip;
    return ip
      ? createHash("sha256").update(ip).digest("hex").slice(0, 32)
      : null;
  }

  private setRefreshCookie(res: Response, raw: string, expiresAt: Date): void {
    res.cookie(REFRESH_COOKIE, raw, {
      httpOnly: true,
      secure: this.config.get<string>("NODE_ENV") === "production",
      sameSite: "lax",
      domain: this.config.get<string>("COOKIE_DOMAIN") || undefined,
      path: "/api/auth",
      expires: expiresAt,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  }

  /**
   * Desktop first-run: hand back a session for this machine's owner without a
   * login screen. Nothing local is being protected from anyone — the database,
   * the model and the files all belong to whoever is already logged into this
   * computer — and asking for an account before the app has shown it works is
   * the single largest drop-off in a first run. An account starts to mean
   * something only when other people are involved: sharing the node, earning
   * the network, sharing this machine with other people.
   *
   * Three independent conditions, all required:
   *  - the desktop shell set NEURION_LOCAL_OWNER (a server deployment never does)
   *  - the API is bound to loopback
   *  - the TCP peer really is loopback
   *
   * That last check reads socket.remoteAddress and NOT req.ip on purpose:
   * `trust proxy` is enabled for the nginx deployment, so req.ip is taken from
   * X-Forwarded-For, which a caller can simply write themselves. Trusting it
   * here would turn this into "anyone who can reach the port is the owner".
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("local-session")
  async localSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const enabled =
      String(this.config.get("NEURION_LOCAL_OWNER") ?? "false") === "true";
    const bindHost =
      this.config.get<string>("NEURION_BIND_HOST") ?? "127.0.0.1";
    const boundToLoopback =
      bindHost === "127.0.0.1" ||
      bindHost === "localhost" ||
      bindHost === "::1";
    const peer = req.socket.remoteAddress ?? "";
    const peerIsLoopback =
      peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";

    if (!enabled || !boundToLoopback || !peerIsLoopback) {
      throw new ForbiddenException(
        "local sessions are not available on this deployment",
      );
    }

    const user = await this.auth.ensureLocalOwner();
    const session = await this.auth.issueSession(user, {
      userAgent: req.headers["user-agent"] ?? null,
      ipHash: this.ipHash(req),
    });
    this.setRefreshCookie(res, session.refresh.raw, session.refresh.expiresAt);
    return { accessToken: session.accessToken, user: session.user };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.register(
      dto.email,
      dto.password,
      dto.displayName,
    );
    const full = await this.auth.validateCredentials(dto.email, dto.password);
    const session = await this.auth.issueSession(full, {
      userAgent: req.headers["user-agent"] ?? null,
      ipHash: this.ipHash(req),
    });
    this.setRefreshCookie(res, session.refresh.raw, session.refresh.expiresAt);
    await this.audit.log({
      action: "auth.register",
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      entityType: "User",
      entityId: user.id,
      ipAddress: this.ipHash(req),
      userAgent: req.headers["user-agent"] ?? null,
    });
    return { accessToken: session.accessToken, user: session.user };
  }

  @Public()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post("login")
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.validateCredentials(dto.email, dto.password);
    const session = await this.auth.issueSession(user, {
      userAgent: req.headers["user-agent"] ?? null,
      ipHash: this.ipHash(req),
    });
    this.setRefreshCookie(res, session.refresh.raw, session.refresh.expiresAt);
    await this.audit.log({
      action: "auth.login",
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      entityType: "User",
      entityId: user.id,
      ipAddress: this.ipHash(req),
      userAgent: req.headers["user-agent"] ?? null,
    });
    return { accessToken: session.accessToken, user: session.user };
  }

  @Public()
  @Post("refresh")
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE
    ];
    if (!raw) throw new UnauthorizedException("no refresh token");

    const result = await this.refreshTokens.rotate(raw, {
      userAgent: req.headers["user-agent"] ?? null,
      ipHash: this.ipHash(req),
    });

    if (!result.ok) {
      this.clearRefreshCookie(res);
      if (result.reason === "reuse_detected") {
        await this.audit.log({
          action: "auth.refresh.reuse_detected",
          entityType: "RefreshToken",
          ipAddress: this.ipHash(req),
          userAgent: req.headers["user-agent"] ?? null,
        });
      }
      throw new UnauthorizedException(`refresh failed: ${result.reason}`);
    }

    this.setRefreshCookie(res, result.issued.raw, result.issued.expiresAt);
    const accessToken = await this.auth.accessTokenForUserId(result.userId);
    return { accessToken };
  }

  @Public()
  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE
    ];
    if (raw) await this.refreshTokens.revokeByRaw(raw);
    this.clearRefreshCookie(res);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 4, ttl: 60_000 } })
  @Post("forgot-password")
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.requestPasswordReset(dto.email);
    return { ok: true }; // always ok — no account enumeration
  }

  @Public()
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post("reset-password")
  async resetPassword(@Body() dto: ResetPasswordDto) {
    const ok = await this.auth.resetPassword(dto.token, dto.password);
    if (!ok) throw new UnauthorizedException("invalid or expired reset link");
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("verify-email")
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    const ok = await this.auth.verifyEmail(dto.token);
    if (!ok)
      throw new UnauthorizedException("invalid or expired verification link");
    return { ok: true };
  }

  @Post("resend-verification")
  async resendVerification(@CurrentUser() user: AuthUser) {
    await this.auth.resendVerification(user.sub);
    return { ok: true };
  }

  @Post("change-password")
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.auth.changePassword(user.sub, dto.oldPassword, dto.newPassword);
    return { ok: true };
  }

  @Delete("account")
  async deleteAccount(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.deleteAccount(user.sub, dto.password);
    this.clearRefreshCookie(res);
    return { ok: true };
  }

  @Patch("profile")
  async updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.auth.updateProfile(user.sub, dto);
  }

  @Get("me")
  async me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.sub);
  }
}
