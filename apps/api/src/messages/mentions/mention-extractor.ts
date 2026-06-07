import type { PrismaClient } from '@prisma/client';
import { scanRoleMentions } from './role-mention-scanner';

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
  /**
   * S88a (FR-MN-03): `@<RoleName>` 멘션이 가리키는 역할 id 목록. extractRoleMentions 가
   * 본문에서 알려진 워크스페이스 역할명을 longest-match 로 권위 추출한 roleId 들이다
   * (게이트/정규화는 호출자가 별도 수행). DM(workspaceId=null)은 항상 [].
   */
  roles: string[];
};

/**
 * S88a (FR-MN-03): extractRoleMentions 가 반환하는 역할 1건. mentionable 플래그를
 * 함께 실어 service 의 접근제어 게이트(mentionable===true OR actorHasMentionEveryone)가
 * 추가 쿼리 없이 판정할 수 있게 한다.
 */
export type ExtractedRoleMention = { id: string; name: string; mentionable: boolean };

/** 역할 매칭에서 제외하는 예약 특수멘션 키. 동명 역할이 있어도 멘션으로 보지 않는다. */
const RESERVED_MENTION_NAMES = new Set(['everyone', 'here', 'channel']);

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
    return { users: [], channels: [], everyone: false, here: false, channel: false, roles: [] };
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

  // S88a (FR-MN-03): `roles` 는 extractRoleMentions 가 별도로 채운다(service 가
  // mentionable 플래그까지 필요로 하므로 호출을 분리한다). 여기서는 빈 배열을 둔다.
  return { users, channels, everyone, here, channel: channelScope, roles: [] };
}

/**
 * S88a (FR-MN-03 · D1): 본문에서 `@<RoleName>` 멘션을 추출한다.
 *
 * 역할명은 RoleNameSchema 가 공백을 허용하므로("Project Managers") 자유 정규식으로는
 * 추출할 수 없다 → **알려진 워크스페이스 역할명 longest-match**. 워크스페이스 역할
 * 목록을 로드한 뒤(@ 포함 메시지에 한해), 본문을 단일 패스 소비 기반 스캐너로 훑어
 * 매칭된 roleId 를 수집한다.
 *
 * - workspaceId=null(DM) 또는 `@` 미포함 텍스트면 즉시 [] (쿼리 생략).
 * - 예약어 everyone/here/channel 동명 역할은 제외한다.
 * - 미지의 역할명은 silent drop(extractMentions 와 동일 신뢰 모델).
 * - mentionable 플래그를 함께 반환해 service 게이트가 추가 쿼리 없이 판정한다.
 *
 * S88a review F3 (data integrity): scanRoleMentions 단일 패스 **소비 기반** longest-
 * match 를 쓴다. 종전 구현은 정렬된 역할명을 각각 독립 `.test()` 하여 `@PM Leads`
 * 입력에서 "PM Leads" 와 "PM" 이 둘 다 매칭됐다(짧은 prefix 역할 과다 fanout +
 * 저장 토큰과 mentions.roles 불일치). 이제 정규화의 replaceRoleTokens 와 **동일
 * 스캐너**를 공유하므로 추출과 토큰화가 같은 매칭 집합을 보장한다. 스캐너는 코드
 * 영역도 건너뛰어, 코드블록 내부 역할명이 fanout 되는 일도 없다(정규화와 정합).
 */
export async function extractRoleMentions(
  prisma: PrismaClient,
  workspaceId: string | null,
  text: string,
): Promise<ExtractedRoleMention[]> {
  if (workspaceId === null) return [];
  // `@` 가 전혀 없으면 역할 멘션이 있을 수 없다 — 역할 목록 쿼리 자체를 생략.
  if (!text.includes('@')) return [];

  const roles = await prisma.role.findMany({
    where: { workspaceId },
    select: { id: true, name: true, mentionable: true },
  });
  if (roles.length === 0) return [];

  // 예약 특수멘션 동명 역할은 멘션 대상에서 제외(@everyone 등은 별도 경로).
  const candidates = roles
    .filter((r) => {
      const trimmed = r.name.trim();
      return trimmed.length > 0 && !RESERVED_MENTION_NAMES.has(trimmed.toLowerCase());
    })
    .map((r) => ({ name: r.name, value: r }));

  // 소비 기반 단일 패스 스캐너 — 짧은 prefix 가 긴 매칭 구간을 재매칭하지 못한다.
  const matched = new Map<string, ExtractedRoleMention>();
  for (const m of scanRoleMentions(text, candidates)) {
    const role = m.value;
    matched.set(role.id, { id: role.id, name: role.name, mentionable: role.mentionable });
  }
  return [...matched.values()];
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
  // S88a (FR-MN-03): 게이트를 통과해 실제 저장될 roleId 들. 이 집합에 한해 역할명을
  // 로드해 label 맵에 채운다(추출은 됐으나 게이트 탈락한 역할은 토큰화되지 않으므로
  // label 도 불필요). 미지정/빈 배열이면 roles 맵은 비운다(기존 호출부 호환).
  gatedRoleIds: string[] = [],
): Promise<{
  users: Map<string, string>;
  channels: Map<string, string>;
  roles: Map<string, string>;
}> {
  const users = new Map<string, string>();
  const channels = new Map<string, string>();
  const roles = new Map<string, string>();
  if (workspaceId === null) return { users, channels, roles };

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

  const [userRows, channelRows, roleRows] = await Promise.all([
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
    gatedRoleIds.length === 0
      ? Promise.resolve([] as { id: string; name: string }[])
      : prisma.role.findMany({
          where: { workspaceId, id: { in: gatedRoleIds } },
          select: { id: true, name: true },
        }),
  ]);
  for (const r of userRows) users.set(r.id, r.username);
  for (const r of channelRows) channels.set(r.id, r.name);
  for (const r of roleRows) roles.set(r.id, r.name);
  return { users, channels, roles };
}

/**
 * S44 fix-forward (MAJOR · perf): raw 본문에 범위 멘션(@everyone/@here/@channel)
 * sigil 이 있는지 저비용으로 사전스캔한다. 컨트롤러가 이 신호가 있을 때만
 * `ChannelAccessService.resolveMentionEveryone`(override findMany 1쿼리)을 호출하게
 * 해, 범위 멘션이 없는 일반 메시지의 +1 RTT 를 제거한다. 정규식 .test 만 수행하므로
 * DB 접근이 없다. 신뢰 경계와 무관(권한 fold 는 신호가 있을 때만 별도 수행).
 */
export function hasBroadMentionSignal(text: string): boolean {
  return (
    MENTION_EVERYONE_RE.test(text) ||
    MENTION_HERE_RE.test(text) ||
    MENTION_CHANNEL_SCOPE_RE.test(text)
  );
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
