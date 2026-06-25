import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module';
import { ProviderResolverService } from './provider-resolver.service';
import { PrivacyClassifierService } from './privacy/classifier.service';
import { EstimatorService } from './estimator.service';
import { RealtimePoolService } from './realtime-pool.service';
import { AiRouterService } from './ai-router.service';

@Module({
  imports: [NodesModule],
  providers: [
    ProviderResolverService,
    PrivacyClassifierService,
    EstimatorService,
    RealtimePoolService,
    AiRouterService,
  ],
  exports: [AiRouterService, EstimatorService, ProviderResolverService],
})
export class AiModule {}
