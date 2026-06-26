import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { JobsModule } from '../jobs/jobs.module';
import { NodesModule } from '../nodes/nodes.module';
import { AgentController } from './agent.controller';
import { AgentToolsService } from './agent-tools.service';
import { AgentOrchestratorService } from './agent-orchestrator.service';

@Module({
  imports: [AiModule, JobsModule, NodesModule],
  controllers: [AgentController],
  providers: [AgentToolsService, AgentOrchestratorService],
})
export class AgentModule {}
