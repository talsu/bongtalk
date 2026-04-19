import type { PrismaClient } from '@prisma/client';

export type Mentions = { users: string[]; channels: string[]; everyone: boolean };

// Username grammar mirrors SignupRequestSchema: 2-32, alnum/._-
const MENTION_USER_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_.-]{2,32})/g;
const MENTION_CHANNEL_RE = /(?<![A-Za-z0-9_])#([a-z0-9][a-z0-9_-]{0,31})/g;
const MENTION_EVERYONE_RE = /(?<![A-Za-z0-9_])@everyone(?![A-Za-z0-9_])/;

/**
 * Extract `@username`, `#channel`, and `@everyone` tokens from free-form
 * message text. Returns UUIDs (not raw handles) — we look up usernames and
 * channel names inside the caller's workspace so mentions can never escape
 * the workspace boundary, and unknown handles are silently dropped.
 *
 * Clients must never be trusted to pre-compute mentions: store the result of
 * this function, not whatever the client posted.
 */
export async function extractMentions(
  prisma: PrismaClient,
  workspaceId: string,
  text: string,
): Promise<Mentions> {
  const everyone = MENTION_EVERYONE_RE.test(text);

  const usernames = new Set<string>();
  for (const m of text.matchAll(MENTION_USER_RE)) {
    // `@everyone` is handled separately; drop it from the username bucket.
    if (m[1].toLowerCase() === 'everyone') continue;
    usernames.add(m[1]);
  }
  const channelNames = new Set<string>();
  for (const m of text.matchAll(MENTION_CHANNEL_RE)) {
    channelNames.add(m[1]);
  }

  const [users, channels] = await Promise.all([
    usernames.size === 0
      ? Promise.resolve([])
      : prisma.user
          .findMany({
            where: {
              username: { in: [...usernames] },
              memberships: { some: { workspaceId } },
            },
            select: { id: true },
          })
          .then((rs) => rs.map((r) => r.id)),
    channelNames.size === 0
      ? Promise.resolve([])
      : prisma.channel
          .findMany({
            where: {
              workspaceId,
              deletedAt: null,
              name: { in: [...channelNames] },
            },
            select: { id: true },
          })
          .then((rs) => rs.map((r) => r.id)),
  ]);

  return { users, channels, everyone };
}

/**
 * Best-effort normalization for full-text search / future moderation. We keep
 * the letter content but strip the mention sigils and collapse whitespace so
 * "Hey @alice, look at #general!" → "Hey alice, look at general!".
 */
export function normalizeContent(text: string): string {
  return text
    .replace(MENTION_USER_RE, '$1')
    .replace(MENTION_CHANNEL_RE, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
