import type { DmListItem, GroupDmListItem, DmParticipantProfile } from './useDms';

/**
 * 072-N1-1: DM 사이드바의 1:1·그룹 행을 하나의 정렬 목록으로 합치는 순수 로직.
 *
 * 데스크톱 DmShell 은 종전 1:1(useDmList)만 렌더했고 그룹(useDmGroupList)은
 * dormant 였다. 두 목록을 lastMessageAt DESC(없으면 맨 뒤)로 병합한다. 072 백로그
 * S-E 부터 서버 listGroups 가 unread/mention 카운트를 내려주므로 그룹 행도 1:1 과
 * 동일하게 배지를 단다(뮤트 회색 표시는 UserChannelMute 공유라 channelId 로 가능).
 */
export interface UnifiedDmRow {
  kind: 'direct' | 'group';
  channelId: string;
  /** direct: otherUsername / group: displayName ‖ 참여자명 목록. */
  title: string;
  preview: string | null;
  lastMessageAt: string | null;
  // direct 전용
  otherUserId?: string;
  unreadCount?: number;
  mentionCount?: number;
  // group 전용
  participants?: DmParticipantProfile[];
  memberIds?: string[];
}

/**
 * 그룹 DM 표시명: 사용자 지정 displayName 우선, 없으면 본인 제외 참여자 username
 * 목록을 ', ' 로 잇는다(참여자 슬라이스는 ≤5). 둘 다 비면 '그룹 대화'.
 */
export function groupDmTitle(group: GroupDmListItem, meId: string | undefined): string {
  const named = group.displayName?.trim();
  if (named) return named;
  const others = group.participants
    .filter((p) => p.userId !== meId)
    .map((p) => p.username)
    .filter((u) => u.length > 0);
  if (others.length > 0) return others.join(', ');
  return '그룹 대화';
}

function tsOrNeg(iso: string | null): number {
  // null lastMessageAt(대화 시작 전)은 항상 맨 뒤로.
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * 1:1 + 그룹 DM 을 단일 정렬 목록으로 병합. lastMessageAt DESC(없으면 맨 뒤),
 * 동률은 channelId 오름차순으로 결정적 정렬(리스트 깜빡임 방지).
 */
export function buildDmRows(
  dms: DmListItem[],
  groups: GroupDmListItem[],
  meId: string | undefined,
): UnifiedDmRow[] {
  const directRows: UnifiedDmRow[] = dms.map((d) => ({
    kind: 'direct',
    channelId: d.channelId,
    title: d.otherUsername,
    preview: d.lastMessagePreview,
    lastMessageAt: d.lastMessageAt,
    otherUserId: d.otherUserId,
    unreadCount: d.unreadCount,
    mentionCount: d.mentionCount ?? 0,
  }));
  const groupRows: UnifiedDmRow[] = groups.map((g) => ({
    kind: 'group',
    channelId: g.channelId,
    title: groupDmTitle(g, meId),
    preview: g.lastMessagePreview,
    lastMessageAt: g.lastMessageAt,
    participants: g.participants,
    memberIds: g.memberIds,
    // 072 백로그 S-E (FR-DM-15): 그룹 DM 미읽음/멘션 — 1:1 과 동형으로 배지 산입.
    unreadCount: g.unreadCount,
    mentionCount: g.mentionCount ?? 0,
  }));
  return [...directRows, ...groupRows].sort((a, b) => {
    const ta = tsOrNeg(a.lastMessageAt);
    const tb = tsOrNeg(b.lastMessageAt);
    // ta!==tb 먼저 비교(둘 다 -Infinity 인 null 동률에서 Infinity-Infinity=NaN 회피).
    if (ta !== tb) return tb - ta;
    return a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0;
  });
}

/**
 * 072-N1-3 (FR-DM-11): 뮤트 기간 옵션. mutedUntil 계산은 호출처에서 now 기준으로
 * ISO 문자열로 만든다(테스트 결정성 위해 now 를 인자로 받는 순수 함수).
 */
export interface MuteDurationOption {
  key: string;
  label: string;
  /** null = 무기한. number = now 로부터의 분(minutes). */
  minutes: number | null;
}

export const MUTE_DURATION_OPTIONS: MuteDurationOption[] = [
  { key: '15m', label: '15분', minutes: 15 },
  { key: '1h', label: '1시간', minutes: 60 },
  { key: '3h', label: '3시간', minutes: 180 },
  { key: '8h', label: '8시간', minutes: 480 },
  { key: '24h', label: '24시간', minutes: 1440 },
  { key: 'forever', label: '계속', minutes: null },
];

/** 옵션 minutes → mutedUntil ISO 문자열(null=무기한). */
export function muteUntilIso(minutes: number | null, nowMs: number): string | null {
  if (minutes === null) return null;
  return new Date(nowMs + minutes * 60_000).toISOString();
}
