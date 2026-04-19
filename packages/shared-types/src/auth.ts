import { z } from 'zod';

export const PasswordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(128, 'password too long');

export const SignupRequestSchema = z.object({
  email: z.string().email(),
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'username has invalid characters'),
  password: PasswordSchema,
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string().min(2).max(32),
  createdAt: z.string().datetime(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthTokensResponseSchema = z.object({
  accessToken: z.string().min(10),
  user: AuthUserSchema,
});
export type AuthTokensResponse = z.infer<typeof AuthTokensResponseSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string().min(10),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
