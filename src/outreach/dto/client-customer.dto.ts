import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ClientCustomerEntryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  /** Set when a LinkedIn account is linked; does not overwrite `name`. */
  @IsOptional()
  @IsString()
  linkedInProfileName?: string;
}

export class PatchClientCustomerLinkedInDto {
  @IsString()
  @IsNotEmpty()
  linkedInProfileName: string;
}

export class UpsertClientCustomersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ClientCustomerEntryDto)
  customers: ClientCustomerEntryDto[];
}

export class ClientIdParamDto {
  @IsMongoId()
  clientId: string;
}
