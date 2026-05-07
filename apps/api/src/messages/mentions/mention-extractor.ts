import type { PrismaClient } from '@prisma/client';

export type Mentions = {
  users: string[];
  channels: string[];
  everyone: boolean;
  /** task-046 iter8 (A9): `@here` 만 — 채널 멤버 중 현재 online 인 사람만 알림. */
  here: boolean;
};

// Username grammar mirrors SignupRequestSchema: 2-32, alnum/._-
const MENTION_USER_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_.-]{2,32})/g;
const MENTION_CHANNEL_RE = /(?<![A-Za-z0-9_])#([a-z0-9][a-z0-9_-]{0,31})/g;
const MENTION_EVERYONE_RE = /(?<![A-Za-z0-9_])@everyone(?![A-Za-z0-9_])/;
const MENTION_HERE_RE = /(?<![A-Za-z0-9_])@here(?![A-Za-z0-9_])/;

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
  workspaceId: string | null,
  text: string,
): Promise<Mentions> {
  // Global DMs have no workspace scope — there is no member/channel
  // namespace to resolve @handles against, so drop mentions entirely.
  // `@everyone` in a DM would also be meaningless.
  if (workspaceId === null) {
    return { users: [], channels: [], everyone: false, here: false };
  }
  const everyone = MENTION_EVERYONE_RE.test(text);
  const here = MENTION_HERE_RE.test(text);

  const usernames = new Set<string>();
  for (const m of text.matchAll(MENTION_USER_RE)) {
    // `@everyone` / `@here` 는 별도 처리 — username bucket 에서 제외.
    const lower = m[1].toLowerCase();
    if (lower === 'everyone' || lower === 'here') continue;
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

  return { users, channels, everyone, here };
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
