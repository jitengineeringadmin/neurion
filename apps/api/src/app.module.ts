import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './common/redis.service';
import { MailModule } from './mail/mail.module';
import { HealthModule } from './health/health.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { CreditsModule } from './credits/credits.module';
import { ChatModule } from './chat/chat.module';
import { NodesModule } from './nodes/nodes.module';
import { JobsModule } from './jobs/jobs.module';
import { CryptoModule } from './crypto/crypto.module';
import { ComplianceModule } from './compliance/compliance.module';
import { AgentModule } from './agent/agent.module';
import { ProjectsModule } from './projects/projects.module';
import { ForumModule } from './forum/forum.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    JwtModule.register({ global: true }),
    // Global rate limit (per IP): generous default; auth endpoints override stricter.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
    RedisModule,
    MailModule,
    AuditModule,
    CreditsModule,
    HealthModule,
    AuthModule,
    AdminModule,
    ChatModule,
    NodesModule,
    JobsModule,
    CryptoModule,
    ComplianceModule,
    AgentModule,
    ProjectsModule,
    ForumModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
