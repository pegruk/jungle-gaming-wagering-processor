import { IsNotEmpty, IsNumberString, IsString, IsUUID } from "class-validator";

export class BetRequestDto {
  @IsUUID()
  @IsNotEmpty()
  public readonly transactionId!: string;

  @IsString()
  @IsNotEmpty()
  public readonly roundId!: string;

  @IsString()
  @IsNotEmpty()
  public readonly playerId!: string;

  @IsString()
  @IsNotEmpty()
  public readonly walletId!: string;

  @IsNumberString()
  @IsNotEmpty()
  public readonly amount!: string;

  // Recebido estritamente como string!
  @IsString()
  @IsNotEmpty()
  public readonly currency!: string;
}
