import { IsString } from 'class-validator';

export class ForwardMessageDto {
  @IsString()
  targetConversationId: string;
}
