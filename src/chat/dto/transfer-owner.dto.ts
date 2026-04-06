import { IsString } from 'class-validator';

export class TransferOwnerDto {
  @IsString()
  newOwnerId: string;
}
