import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sectionId!: string;

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
