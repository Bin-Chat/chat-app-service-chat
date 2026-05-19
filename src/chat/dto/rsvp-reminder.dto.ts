import { IsEnum, IsString, IsNotEmpty } from 'class-validator';

export class RsvpReminderDto {
  @IsEnum(['yes', 'no'])
  status: 'yes' | 'no';

  @IsString()
  @IsNotEmpty()
  name: string;
}
