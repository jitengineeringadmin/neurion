import { Module } from "@nestjs/common";
import { NodesModule } from "../nodes/nodes.module";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";
import { JobScheduler } from "./job-scheduler.service";
import { VerificationService } from "./verification.service";
import { TrustedExecutorService } from "./verification/trusted-executor.service";

@Module({
  imports: [NodesModule],
  controllers: [JobsController],
  providers: [
    JobsService,
    JobScheduler,
    VerificationService,
    TrustedExecutorService,
  ],
  exports: [JobsService],
})
export class JobsModule {}
