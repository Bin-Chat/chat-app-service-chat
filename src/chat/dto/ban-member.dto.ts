import { IsOptional, IsDateString } from 'class-validator';

export class BanMemberDto {
  @IsOptional()
  @IsDateString()
  bannedUntil?: string; // ISO string; null = permanent ban
}
