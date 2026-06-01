import type { PrismaClient } from '@prisma/client';

export type Mentions = {
  users: string[];
  channels: string[];
  everyone: boolean;
  /** task-046 iter8 (A9): `@here` 만 — 채널 멤버 중 현재 online 인 사람만 알림. */
  here: boolean;
  /**
   * S21 (FR-RS-16): `@channel` 범위 멘션 — 현재 채널 멤버 전원. @everyone(워크스페이스
   * 전체)·@here(온라인) 와 구분되는 채널-스코프 멘션. unread mentionCount 집계에
   * 반영되며, gate.ts 로 권한 게이트한다.
   */
  channel: boolean;
};

// Username grammar mirrors SignupRequestSchema: 2-32, alnum/._-
const MENTION_USER_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_.-]{2,32})/g;
const MENTION_CHANNEL_RE = /(?<![A-Za-z0-9_])#([a-z0-9][a-z0-9_-]{0,31})/g;
const MENTION_EVERYONE_RE = /(?<![A-Za-z0-9_])@everyone(?![A-Za-z0-9_])/;
const MENTION_HERE_RE = /(?<![A-Za-z0-9_])@here(?![A-Za-z0-9_])/;
// S21 (FR-RS-16): `@channel` 특수멘션 토큰.
const MENTION_CHANNEL_SCOPE_RE = /(?<![A-Za-z0-9_])@channel(?![A-Za-z0-9_])/;

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
    return { users: [], channels: [], everyone: false, here: false, channel: false };
  }
  const everyone = MENTION_EVERYONE_RE.test(text);
  const here = MENTION_HERE_RE.test(text);
  const channelScope = MENTION_CHANNEL_SCOPE_RE.test(text);

  const usernames = new Set<string>();
  for (const m of text.matchAll(MENTION_USER_RE)) {
    // `@everyone` / `@here` / `@channel` 는 별도 처리 — username bucket 에서 제외.
    const lower = m[1].toLowerCase();
    if (lower === 'everyone' || lower === 'here' || lower === 'channel') continue;
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

  return { users, channels, everyone, here, channel: channelScope };
}

/**
 * S04 (FR-MSG-13) — `@username` 핸들을 userId(cuid2/uuid) 로 resolve 하는
 * lookup 맵을 만듭니다. 키는 소문자 핸들(case-insensitive 매칭). 워크스페이스
 * 멤버로 스코프를 좁혀 멘션이 워크스페이스 경계를 넘지 못하게 합니다 —
 * extractMentions 와 동일한 신뢰 모델. Global DM(workspaceId=null)은 멘션
 * 네임스페이스가 없어 빈 맵을 반환합니다.
 *
 * `normalizeMentions` 의 resolver 로 주입합니다. 미해결 핸들은 맵에 없어
 * 토큰이 literal 로 보존됩니다.
 */
export async function resolveMentionHandles(
  prisma: PrismaClient,
  workspaceId: string | null,
  text: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (workspaceId === null) return out;
  const usernames = new Set<string>();
  for (const m of text.matchAll(MENTION_USER_RE)) {
    const lower = m[1].toLowerCase();
    if (lower === 'everyone' || lower === 'here' || lower === 'channel') continue;
    usernames.add(m[1]);
  }
  if (usernames.size === 0) return out;
  const rows = await prisma.user.findMany({
    where: {
      username: { in: [...usernames] },
      memberships: { some: { workspaceId } },
    },
    select: { id: true, username: true },
  });
  for (const r of rows) out.set(r.username.toLowerCase(), r.id);
  return out;
}

/**
 * S04 review HIGH (FR-MSG-13) — 멘션 노드에 박을 표시명(label) 맵을 만듭니다.
 *
 * 정규화는 `@username` 을 안정 식별자 `@{cuid2}` 로 저장하므로, 라이브 렌더가
 * 워크스페이스 멤버 맵 도착 전에는 raw cuid 를 그대로 표시하는 회귀가 있었습니다.
 * 저장 시점에 이미 DB 에서 해석한 username/channel name 을 contentAst 의 mention
 * 노드에 함께 박아 두면, 렌더러가 멤버 맵 없이도 `@alice` 를 그릴 수 있습니다.
 *
 * 반환:
 *   - `users`  : userId(cuid2) → username (원본 대소문자 보존, 표시용)
 *   - `channels`: channelId(cuid2) → channel name
 *
 * 신뢰 모델은 extractMentions / resolveMentionHandles 와 동일합니다 — 워크스페이스
 * 멤버/채널로 스코프를 좁혀 멘션이 경계를 넘지 못하게 하고, Global DM
 * (workspaceId=null)은 빈 맵을 반환합니다. label 은 표시 캐시일 뿐이며 단일
 * 신뢰 출처는 여전히 userId/channelId 입니다.
 */
export async function resolveMentionLabelMaps(
  prisma: PrismaClient,
  workspaceId: string | null,
  text: string,
): Promise<{ users: Map<string, string>; channels: Map<string, string> }> {
  const users = new Map<string, string>();
  const channels = new Map<string, string>();
  if (workspaceId === null) return { users, channels };

  const usernames = new Set<string>();
  for (const m of text.matchAll(MENTION_USER_RE)) {
    const lower = m[1].toLowerCase();
    if (lower === 'everyone' || lower === 'here' || lower === 'channel') continue;
    usernames.add(m[1]);
  }
  const channelNames = new Set<string>();
  for (const m of text.matchAll(MENTION_CHANNEL_RE)) {
    channelNames.add(m[1]);
  }

  const [userRows, channelRows] = await Promise.all([
    usernames.size === 0
      ? Promise.resolve([] as { id: string; username: string }[])
      : prisma.user.findMany({
          where: {
            username: { in: [...usernames] },
            memberships: { some: { workspaceId } },
          },
          select: { id: true, username: true },
        }),
    channelNames.size === 0
      ? Promise.resolve([] as { id: string; name: string }[])
      : prisma.channel.findMany({
          where: { workspaceId, deletedAt: null, name: { in: [...channelNames] } },
          select: { id: true, name: true },
        }),
  ]);
  for (const r of userRows) users.set(r.id, r.username);
  for (const r of channelRows) channels.set(r.id, r.name);
  return { users, channels };
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
