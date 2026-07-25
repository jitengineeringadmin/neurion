import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { ChatMode, JobPrivacyLevel } from "@prisma/client";

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsEnum(JobPrivacyLevel)
  privacyLevel?: JobPrivacyLevel;
}

export class ChatFileDto {
  @IsString()
  @MaxLength(240)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  type?: string;

  @IsInt()
  @Min(0)
  size!: number;

  @IsString()
  @MaxLength(32_000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8_000_000)
  data?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(240)
  @IsString({ each: true })
  @MaxLength(24_000, { each: true })
  chunks?: string[];

  @IsOptional()
  @IsBoolean()
  truncated?: boolean;
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

  @IsOptional()
  @ValidateNested()
  @Type(() => ChatFileDto)
  file?: ChatFileDto;
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
