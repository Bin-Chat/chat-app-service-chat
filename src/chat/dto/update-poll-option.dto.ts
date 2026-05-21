import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class UpdatePollOptionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  text: string;
}
