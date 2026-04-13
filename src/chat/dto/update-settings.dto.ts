import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  onlyAdminCanSend?: boolean;

  @IsOptional()
  @IsBoolean()
  onlyAdminCanPin?: boolean;

  @IsOptional()
  @IsBoolean()
  allowMemberInvite?: boolean;

  @IsOptional()
  @IsBoolean()
  requireJoinApproval?: boolean;

  @IsOptional()
  @IsBoolean()
  chatHistoryForNewMembers?: boolean;
}
