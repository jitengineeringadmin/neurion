import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ForumCategory } from '@prisma/client';

export class CreateThreadDto {
  @IsEnum(ForumCategory)
  category!: ForumCategory;

  @IsString()
  @MinLength(3)
  @MaxLength(140)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}

export class ReplyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}

export class ModerateDto {
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsBoolean()
  locked?: boolean;
}
