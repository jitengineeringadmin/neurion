import { Module } from "@nestjs/common";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { AiModule } from "../ai/ai.module";
import { KnowledgePagingService } from "./knowledge-paging.service";

@Module({
  imports: [AiModule],
  controllers: [ChatController],
  providers: [ChatService, KnowledgePagingService],
})
export class ChatModule {}
