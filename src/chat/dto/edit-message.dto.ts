import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class EditMessageDto {
  @IsString()
  @IsNotEmpty({ message: 'Nội dung tin nhắn không được rỗng' })
  @MaxLength(10000)
  content: string;
}
