import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ChatMode, JobPrivacyLevel } from '@prisma/client';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsEnum(JobPrivacyLevel)
  privacyLevel?: JobPrivacyLevel;
}

export class StreamChatDto {
  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsString()
  @MaxLength(32_000)
  message!: string;

  @IsOptional()
  @IsEnum(ChatMode)
  mode?: ChatMode;

  @IsOptional()
  @IsEnum(JobPrivacyLevel)
  privacyLevel?: JobPrivacyLevel;

  @IsOptional()
  @IsString()
  preferredModel?: string;

  // Vision: a single image as a base64 data URL (data:image/...;base64,…). When set,
  // the message is answered by a local vision model (llava etc.).
  @IsOptional()
  @IsString()
  @MaxLength(15_000_000)
  image?: string;
}

export class EstimateDto {
  @IsString()
  @MaxLength(32_000)
  message!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  attachmentBytes?: number;
}
