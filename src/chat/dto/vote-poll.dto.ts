import { IsArray, IsString } from 'class-validator';

export class VotePollDto {
  @IsArray()
  @IsString({ each: true })
  optionIds: string[];
}
