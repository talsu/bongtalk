import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByUsername(username: string) {
    return this.prisma.user.findUnique({ where: { username } });
  }

  create(input: { id: string; email: string; username: string; passwordHash: string }) {
    return this.prisma.user.create({ data: input });
  }

  updateLoginSuccess(id: string) {
    return this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  async registerFailedLogin(id: string, lockAfter: number, lockForMs: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return null;
    const attempts = user.failedLoginAttempts + 1;
    const lockedUntil = attempts >= lockAfter ? new Date(Date.now() + lockForMs) : null;
    return this.prisma.user.update({
      where: { id },
      data: { failedLoginAttempts: attempts, lockedUntil },
    });
  }
}
