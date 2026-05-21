import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  MaxLength,
  IsDateString,
  ValidateNested,
} from 'class-validator';

export class CreatePollDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  question: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  options: string[];

  @IsOptional()
  @IsBoolean()
  allowMultiple?: boolean;

  @IsOptional()
  @IsBoolean()
  allowAddOptions?: boolean;

  @IsOptional()
  @IsBoolean()
  hideResultsUntilVoted?: boolean;

  @IsOptional()
  @IsBoolean()
  hideVoters?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
