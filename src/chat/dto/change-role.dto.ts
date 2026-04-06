import { IsEnum, IsString } from 'class-validator';

export class ChangeRoleDto {
  @IsString()
  memberId: string;

  @IsEnum(['admin', 'member'])
  role: 'admin' | 'member';
}
