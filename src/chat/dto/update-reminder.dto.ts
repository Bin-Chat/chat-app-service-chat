import { IsString, IsISO8601, IsEnum, IsOptional } from 'class-validator';
import { RepeatType } from '../schemas/reminder.schema';

export class UpdateReminderDto {
  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsISO8601()
  remindAt?: string;

  @IsOptional()
  @IsEnum(['none', 'daily', 'weekly', 'monthly'])
  repeat?: RepeatType;
}
