import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { JobsModule } from "../jobs/jobs.module";
import { NodesModule } from "../nodes/nodes.module";
import { AgentController } from "./agent.controller";
import { AgentToolsService } from "./agent-tools.service";
import { AgentOrchestratorService } from "./agent-orchestrator.service";
import { AgentApprovalService } from "./agent-approval.service";
import { AgentMemoryService } from "./agent-memory.service";
import { AgentSettingsService } from "./agent-settings.service";
import { AgentRunService } from "./agent-run.service";
import { AgentSkillsService } from "./agent-skills.service";
import { AgentCodeIndexService } from "./agent-code-index.service";
import { AgentPatchService } from "./agent-patch.service";
import { AgentVerificationService } from "./agent-verification.service";
import { AgentTerminalService } from "./agent-terminal.service";
import { AgentToolValidationService } from "./agent-tool-validation.service";
import { AgentReviewService } from "./agent-review.service";
import { AgentExecutionService } from "./agent-execution.service";

@Module({
  imports: [AiModule, JobsModule, NodesModule],
  controllers: [AgentController],
  providers: [
    AgentToolsService,
    AgentOrchestratorService,
    AgentApprovalService,
    AgentMemoryService,
    AgentSettingsService,
    AgentSkillsService,
    AgentRunService,
    AgentCodeIndexService,
    AgentPatchService,
    AgentVerificationService,
    AgentTerminalService,
    AgentToolValidationService,
    AgentReviewService,
    AgentExecutionService,
  ],
})
export class AgentModule {}
