import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class AddPollOptionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  text: string;
}
