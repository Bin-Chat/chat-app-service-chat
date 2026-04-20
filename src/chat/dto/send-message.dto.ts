import { Type } from 'class-transformer';
import { IsString, IsOptional, IsArray, ValidateNested, IsEnum } from 'class-validator';

export class AttachmentDto {
  @IsString()
  url: string;

  @IsString()
  type: 'image' | 'video' | 'file';

  @IsString()
  filename: string;

  @IsOptional()
  size?: number;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  width?: number;

  @IsOptional()
  height?: number;

  @IsOptional()
  duration?: number;

  @IsOptional()
  @IsString()
  thumbnailUrl?: string;
}

export class ReplyInfoDto {
  @IsString()
  messageId: string;

  @IsString()
  senderId: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  attachmentType?: string;
}

export class SendMessageDto {
  @IsOptional()
  @IsString()
  type?: string; // e.g. 'system' for call/group event messages

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ReplyInfoDto)
  replyTo?: ReplyInfoDto;
}
