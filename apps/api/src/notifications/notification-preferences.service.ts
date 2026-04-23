import { Injectable } from '@nestjs/common';
import type { NotificationChannel as NC, NotificationEventType as NET } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

export type ResolvedChannel = 'TOAST' | 'BROWSER' | 'BOTH' | 'OFF';

/**
 * Task-019-D: notification preference lookup.
 *
 * 3-step resolution per (userId, workspaceId, eventType):
 *   1. (userId, workspaceId, eventType)  — most specific
 *   2. (userId, NULL, eventType)         — global default
 *   3. hardcoded fallback                — ships with the app
 *
 * For MVP, dispatcher-side gating lives in the web client (matching
 * `resolveChannel` in apps/web/src/features/notifications/useNotificationPreferences.ts).
 * The server mirror exists so a future task (outbox → WS projector
 * filter, browser-native Notification API, or email/push channels)
 * can drop WS events for OFF users without re-inventing the lookup.
 * In-memory cache keeps each lookup cheap under a mention burst —
 * 5 minute TTL per the documented UX tradeoff ("flip MENTION=OFF takes
 * up to 5 min to stick"). Reviewer task-019 HIGH-1: `resolveDelivery`
 * + `channelToDelivery` wrappers removed until a consumer lands, to
 * keep the public surface honest.
 */
const HARDCODED_DEFAULTS: Record<NET, ResolvedChannel> = {
  MENTION: 'BOTH',
  REPLY: 'BOTH',
  REACTION: 'TOAST',
  DIRECT: 'BOTH',
  FRIEND_REQUEST: 'BOTH',
};

const CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class NotificationPreferencesService {
  private cache = new Map<string, { channel: ResolvedChannel; storedAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  private cacheKey(userId: string, workspaceId: string | null, eventType: NET): string {
    return `${userId}|${workspaceId ?? ''}|${eventType}`;
  }

  /**
   * Invalidate every cached row for a user — called after a PUT.
   * Simple correctness beats granular eviction for this volume.
   */
  invalidateUser(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}|`)) this.cache.delete(key);
    }
  }

  async list(userId: string): Promise<
    Array<{
      id: string;
      workspaceId: string | null;
      eventType: NET;
      channel: NC;
      updatedAt: Date;
    }>
  > {
    return this.prisma.userNotificationPreference.findMany({
      where: { userId },
      orderBy: [{ workspaceId: 'asc' }, { eventType: 'asc' }],
      select: {
        id: true,
        workspaceId: true,
        eventType: true,
        channel: true,
        updatedAt: true,
      },
    });
  }

  async upsert(args: {
    userId: string;
    workspaceId: string | null;
    eventType: NET;
    channel: NC;
  }): Promise<{ id: string }> {
    const { userId, workspaceId, eventType, channel } = args;
    // Partial unique indexes in the migration mean we can't use a
    // single Prisma `upsert` with the nullable workspaceId as part of
    // the key. Do it in two steps inside a transaction.
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.userNotificationPreference.findFirst({
        where: { userId, workspaceId, eventType },
        select: { id: true },
      });
      if (existing) {
        await tx.userNotificationPreference.update({
          where: { id: existing.id },
          data: { channel },
        });
        return existing;
      }
      return tx.userNotificationPreference.create({
        data: { userId, workspaceId, eventType, channel },
        select: { id: true },
      });
    });
    this.invalidateUser(userId);
    return row;
  }

  async resolveChannel(
    userId: string,
    workspaceId: string | null,
    eventType: NET,
  ): Promise<ResolvedChannel> {
    const now = Date.now();
    const key = this.cacheKey(userId, workspaceId, eventType);
    const hit = this.cache.get(key);
    if (hit && now - hit.storedAt < CACHE_TTL_MS) return hit.channel;

    const rows = await this.prisma.userNotificationPreference.findMany({
      where: {
        userId,
        eventType,
        OR: [{ workspaceId }, { workspaceId: null }],
      },
      select: { workspaceId: true, channel: true },
    });
    const workspaceRow = rows.find((r) => r.workspaceId === workspaceId);
    const globalRow = rows.find((r) => r.workspaceId === null);
    const channel: ResolvedChannel = workspaceRow
      ? (workspaceRow.channel as ResolvedChannel)
      : globalRow
        ? (globalRow.channel as ResolvedChannel)
        : HARDCODED_DEFAULTS[eventType];

    this.cache.set(key, { channel, storedAt: now });
    return channel;
  }
}
