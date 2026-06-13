import { describe, it, expect } from 'vitest';
import { buildDmRows, groupDmTitle, muteUntilIso, MUTE_DURATION_OPTIONS } from './dmRows';
import type { DmListItem, GroupDmListItem } from './useDms';

function dm(
  channelId: string,
  otherUserId: string,
  username: string,
  lastMessageAt: string | null,
): DmListItem {
  return {
    channelId,
    otherUserId,
    otherUsername: username,
    lastMessageAt,
    lastMessagePreview: 'hi',
    unreadCount: 0,
    mentionCount: 0,
    participants: [{ userId: otherUserId, username }],
  };
}

function grp(
  channelId: string,
  lastMessageAt: string | null,
  opts: {
    displayName?: string | null;
    participants?: Array<{ userId: string; username: string }>;
    unreadCount?: number;
    mentionCount?: number;
  } = {},
): GroupDmListItem {
  return {
    channelId,
    memberIds: ['me', 'a', 'b'],
    participants: opts.participants ?? [
      { userId: 'me', username: 'me' },
      { userId: 'a', username: 'alice' },
      { userId: 'b', username: 'bob' },
    ],
    displayName: opts.displayName ?? null,
    iconUrl: null,
    lastMessageAt,
    lastMessagePreview: 'group hi',
    createdAt: '2025-01-01T00:00:00.000Z',
    // 072 백로그 S-E (FR-DM-15): 그룹 DM 도 미읽음/멘션 수를 갖는다.
    unreadCount: opts.unreadCount ?? 0,
    mentionCount: opts.mentionCount ?? 0,
  };
}

describe('groupDmTitle', () => {
  it('사용자 지정 displayName 이 있으면 그대로 쓴다', () => {
    expect(groupDmTitle(grp('g1', null, { displayName: '점심팟' }), 'me')).toBe('점심팟');
  });

  it('displayName 이 없으면 본인 제외 참여자명을 잇는다', () => {
    expect(groupDmTitle(grp('g1', null), 'me')).toBe('alice, bob');
  });

  it('displayName 공백은 무시하고 참여자명 폴백', () => {
    expect(groupDmTitle(grp('g1', null, { displayName: '   ' }), 'me')).toBe('alice, bob');
  });

  it('본인만 남으면 기본 라벨', () => {
    expect(
      groupDmTitle(grp('g1', null, { participants: [{ userId: 'me', username: 'me' }] }), 'me'),
    ).toBe('그룹 대화');
  });
});

describe('buildDmRows', () => {
  it('1:1 과 그룹을 lastMessageAt DESC 로 병합한다', () => {
    const rows = buildDmRows(
      [dm('d1', 'u1', 'alice', '2025-01-01T10:00:00.000Z')],
      [grp('g1', '2025-01-01T12:00:00.000Z', { displayName: '팀' })],
      'me',
    );
    expect(rows.map((r) => r.channelId)).toEqual(['g1', 'd1']);
    expect(rows[0]).toMatchObject({ kind: 'group', title: '팀' });
    expect(rows[1]).toMatchObject({ kind: 'direct', title: 'alice', otherUserId: 'u1' });
  });

  it('lastMessageAt null 은 항상 맨 뒤로, 동률은 channelId 오름차순', () => {
    const rows = buildDmRows(
      [dm('d2', 'u2', 'zoe', null), dm('d1', 'u1', 'amy', null)],
      [grp('g1', '2025-01-01T09:00:00.000Z')],
      'me',
    );
    expect(rows.map((r) => r.channelId)).toEqual(['g1', 'd1', 'd2']);
  });

  it('direct 행은 unread/mention 을, group 행은 participants/memberIds 를 보존한다', () => {
    const d = dm('d1', 'u1', 'alice', '2025-01-01T10:00:00.000Z');
    d.unreadCount = 5;
    d.mentionCount = 2;
    const rows = buildDmRows([d], [grp('g1', '2025-01-01T08:00:00.000Z')], 'me');
    expect(rows[0]).toMatchObject({ kind: 'direct', unreadCount: 5, mentionCount: 2 });
    expect(rows[1].kind).toBe('group');
    expect(rows[1].memberIds).toEqual(['me', 'a', 'b']);
    expect(rows[1].participants?.length).toBe(3);
  });

  // 072 백로그 S-E (FR-DM-15): 그룹 행도 서버가 준 unread/mention 을 그대로 보존한다.
  it('group 행은 unreadCount/mentionCount 를 보존한다', () => {
    const rows = buildDmRows(
      [],
      [grp('g1', '2025-01-01T08:00:00.000Z', { unreadCount: 7, mentionCount: 3 })],
      'me',
    );
    expect(rows[0]).toMatchObject({ kind: 'group', unreadCount: 7, mentionCount: 3 });
  });
});

describe('muteUntilIso', () => {
  it('null minutes → null(무기한)', () => {
    expect(muteUntilIso(null, 1000)).toBeNull();
  });

  it('분 → now + 분의 ISO', () => {
    const now = new Date('2025-01-01T00:00:00.000Z').getTime();
    expect(muteUntilIso(60, now)).toBe('2025-01-01T01:00:00.000Z');
  });

  it('옵션 표는 6종이며 마지막은 무기한', () => {
    expect(MUTE_DURATION_OPTIONS).toHaveLength(6);
    expect(MUTE_DURATION_OPTIONS[MUTE_DURATION_OPTIONS.length - 1].minutes).toBeNull();
  });
});
