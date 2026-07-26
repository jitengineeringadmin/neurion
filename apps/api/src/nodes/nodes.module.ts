import { Module } from "@nestjs/common";
import { NodesController } from "./nodes.controller";
import { NodesService } from "./nodes.service";
import { NodeGatewayService } from "./node-gateway.service";

@Module({
  controllers: [NodesController],
  providers: [NodesService, NodeGatewayService],
  exports: [NodeGatewayService, NodesService],
})
export class NodesModule {}
