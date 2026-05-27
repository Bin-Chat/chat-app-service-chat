import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddTaskCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  content: string;
}
