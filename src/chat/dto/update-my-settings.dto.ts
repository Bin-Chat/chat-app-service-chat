import { IsBoolean, IsOptional, IsDateString } from 'class-validator';

export class UpdateMySettingsDto {
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;

  @IsOptional()
  @IsBoolean()
  isMuted?: boolean;

  @IsOptional()
  @IsDateString()
  muteUntil?: string; // ISO string
}
