import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class SignupDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_.-]+$/, { message: 'username has invalid characters' })
  username!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password!: string;
}
