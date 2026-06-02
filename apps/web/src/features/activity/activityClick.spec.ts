import { describe, it, expect } from 'vitest';
import { resolveActivityClick, ACTIVITY_TOAST } from './activityClick';
import type { ActivityRow } from './useActivity';

/**
 * S47 (FR-MN-13): Activity Inbox 항목 클릭 fallback 결정.
 */
function row(partial: Partial<ActivityRow>): ActivityRow {
  return {
    activityKey: 'k',
    kind: 'mention',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    messageId: 'm-1',
    actorId: 'a-1',
    actorName: 'alice',
    snippet: 's',
    createdAt: '2025-01-01T00:00:00.000Z',
    readAt: null,
    ...partial,
  };
}

describe('resolveActivityClick (S47 · FR-MN-13)', () => {
  it('채널 부재(삭제) → channel-not-found(패널 유지)', () => {
    expect(resolveActivityClick(row({}), undefined)).toEqual({ type: 'channel-not-found' });
  });

  it('채널은 있으나 접근 불가(권한 회수) → no-access(패널 유지)', () => {
    expect(resolveActivityClick(row({}), { accessible: false })).toEqual({ type: 'no-access' });
  });

  it('스레드 답글(kind=reply) → thread-jump', () => {
    expect(resolveActivityClick(row({ kind: 'reply' }), { accessible: true })).toEqual({
      type: 'thread-jump',
      channelId: 'ch-1',
      messageId: 'm-1',
      workspaceId: 'ws-1',
    });
  });

  it('멘션/반응 → message-jump', () => {
    expect(resolveActivityClick(row({ kind: 'mention' }), { accessible: true })).toEqual({
      type: 'message-jump',
      channelId: 'ch-1',
      messageId: 'm-1',
      workspaceId: 'ws-1',
    });
    expect(resolveActivityClick(row({ kind: 'reaction' }), { accessible: true })).toEqual({
      type: 'message-jump',
      channelId: 'ch-1',
      messageId: 'm-1',
      workspaceId: 'ws-1',
    });
  });

  it('MAJOR-4: DM(kind=direct) → dm-open(otherUserId=actorId), 워크스페이스 점프 안 함', () => {
    // 채널 lookup 결과와 무관하게(undefined 여도) DM 라우트로.
    expect(resolveActivityClick(row({ kind: 'direct', actorId: 'u-9' }), undefined)).toEqual({
      type: 'dm-open',
      otherUserId: 'u-9',
    });
  });

  it('MAJOR-4: global DM(workspaceId null) 도 dm-open 으로 처리', () => {
    expect(
      resolveActivityClick(
        row({ kind: 'direct', actorId: 'u-3', workspaceId: '', channelId: 'dm-ch' }),
        undefined,
      ),
    ).toEqual({ type: 'dm-open', otherUserId: 'u-3' });
  });

  it('친구 요청(채널 컨텍스트 없음) → noop', () => {
    expect(
      resolveActivityClick(
        row({ kind: 'friend_request', channelId: '', workspaceId: '' }),
        undefined,
      ),
    ).toEqual({ type: 'noop' });
  });

  it('토스트 문구가 PRD 정본과 일치', () => {
    expect(ACTIVITY_TOAST.channelNotFound).toBe('채널을 찾을 수 없습니다');
    expect(ACTIVITY_TOAST.noAccess).toBe('접근 권한이 없습니다');
  });
});
