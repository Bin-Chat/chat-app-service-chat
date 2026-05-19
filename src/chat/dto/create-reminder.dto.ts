import { IsString, IsNotEmpty, IsISO8601, IsEnum, IsOptional } from 'class-validator';

export class CreateReminderDto {
  @IsString()
  @IsNotEmpty()
  content: string;

  @IsISO8601()
  remindAt: string;

  @IsOptional()
  @IsEnum(['none', 'daily', 'weekly', 'monthly'])
  repeat?: 'none' | 'daily' | 'weekly' | 'monthly';
}
