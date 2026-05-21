import { IsString, IsOptional, IsNotEmpty, MaxLength } from 'class-validator';

export class UpdatePollDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  question?: string;
}
