import { IsString } from 'class-validator';

export class ReactMessageDto {
  @IsString()
  emoji: string;
}
