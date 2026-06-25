import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RefreshTokenService } from './refresh-token.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';

const DEFAULT_WORKSPACE_SLUG = 'neurion-local';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  role: User['role'];
  workspaceId: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  private toPublic(u: User): PublicUser {
    return { id: u.id, email: u.email, displayName: u.displayName, role: u.role, workspaceId: u.workspaceId };
  }

  private async signAccessToken(u: User): Promise<string> {
    const payload: AuthUser = { sub: u.id, email: u.email, role: u.role, workspaceId: u.workspaceId };
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: '15m',
    });
  }

  private async defaultWorkspaceId(): Promise<string> {
    const ws = await this.prisma.workspace.upsert({
      where: { slug: DEFAULT_WORKSPACE_SLUG },
      update: {},
      create: { name: 'Neurion Local', slug: DEFAULT_WORKSPACE_SLUG },
    });
    return ws.id;
  }

  async register(email: string, password: string, displayName?: string): Promise<PublicUser> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('email already registered');

    const passwordHash = await argon2.hash(password);
    const workspaceId = await this.defaultWorkspaceId();
    const user = await this.prisma.user.create({
      data: { email, passwordHash, displayName: displayName ?? null, workspaceId },
    });
    return this.toPublic(user);
  }

  async validateCredentials(email: string, password: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) throw new UnauthorizedException('invalid credentials');
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('invalid credentials');
    if (user.status !== 'ACTIVE') throw new ForbiddenException('account is not active');
    return user;
  }

  async issueSession(user: User, ctx: { userAgent?: string | null; ipHash?: string | null }) {
    const accessToken = await this.signAccessToken(user);
    const refresh = await this.refreshTokens.issue(user.id, ctx);
    return { accessToken, refresh, user: this.toPublic(user) };
  }

  async accessTokenForUserId(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status !== 'ACTIVE') throw new ForbiddenException('account is not active');
    return this.signAccessToken(user);
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.toPublic(user);
  }
}
