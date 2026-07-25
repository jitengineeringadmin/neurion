import { Module } from "@nestjs/common";
import { NodesModule } from "../nodes/nodes.module";
import { ProviderResolverService } from "./provider-resolver.service";
import { PrivacyClassifierService } from "./privacy/classifier.service";
import { EstimatorService } from "./estimator.service";
import { RealtimePoolService } from "./realtime-pool.service";
import { AiRouterService } from "./ai-router.service";
import { ModelsController } from "./models.controller";
import { ImageController } from "./image.controller";
import { VideoController } from "./video.controller";
import { AudioController } from "./audio.controller";
import { AudioService } from "./audio.service";
import { InferController } from "./infer.controller";
import { ModelMemoryService } from "./model-memory.service";
import { AgentContextService } from "../agent/agent-context.service";

@Module({
  imports: [NodesModule],
  controllers: [
    ModelsController,
    ImageController,
    VideoController,
    AudioController,
    InferController,
  ],
  providers: [
    AudioService,
    ModelMemoryService,
    AgentContextService,
    ProviderResolverService,
    PrivacyClassifierService,
    EstimatorService,
    RealtimePoolService,
    AiRouterService,
  ],
  exports: [
    AiRouterService,
    EstimatorService,
    ProviderResolverService,
    RealtimePoolService,
    AgentContextService,
  ],
})
export class AiModule {}
