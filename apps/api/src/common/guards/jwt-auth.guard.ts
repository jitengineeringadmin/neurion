import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import type { AuthUser } from "../decorators/current-user.decorator";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer "))
      throw new UnauthorizedException("missing bearer token");
    const token = auth.slice("Bearer ".length);

    try {
      const payload = await this.jwt.verifyAsync<AuthUser>(token, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
      });
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException("invalid or expired token");
    }
  }
}
