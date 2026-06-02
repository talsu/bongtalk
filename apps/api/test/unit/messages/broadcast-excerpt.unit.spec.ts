import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildThreadBroadcastExcerpt,
  MessagesService,
} from '../../../src/messages/messages.service';

/**
 * S35 (FR-TH-06): broadcast excerpt 유틸 + toDto 의 isBroadcast/parentExcerpt
 * 노출을 외부 의존 없이 검증한다(순수 함수 + toDto).
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('buildThreadBroadcastExcerpt (FR-TH-06)', () => {
  it('50자 이하 본문은 공백 collapse 만 하고 그대로 둔다', () => {
    expect(buildThreadBroadcastExcerpt('짧은   루트  본문')).toBe('짧은 루트 본문');
  });

  it('50자 초과 본문은 49자 + "…" 로 자른다(총 50자)', () => {
    const long = 'x'.repeat(120);
    const out = buildThreadBroadcastExcerpt(long);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1)).toBe('x'.repeat(49));
  });

  it('null/빈 본문은 빈 문자열을 돌려준다(삭제 루트 등)', () => {
    expect(buildThreadBroadcastExcerpt(null)).toBe('');
    expect(buildThreadBroadcastExcerpt(undefined)).toBe('');
    expect(buildThreadBroadcastExcerpt('   ')).toBe('');
  });
});

describe('MessagesService.toDto broadcast 필드 (FR-TH-06)', () => {
  // Prisma/Outbox 의존 없이 toDto 만 호출하므로 생성자 인자는 캐스트로 채운다.
  const svc = new MessagesService({} as never, {} as never);

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'm-1',
      channelId: 'c-1',
      authorId: 'a-1',
      content: 'reply body',
      contentPlain: 'reply body',
      contentRaw: 'reply body',
      contentAst: null,
      type: 'SYSTEM_THREAD_BROADCAST',
      mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
      editedAt: null,
      deletedAt: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      idempotencyKey: null,
      parentMessageId: 'root-1',
      version: 0,
      isBroadcast: true,
      ...overrides,
    } as never;
  }

  it('broadcast 행은 isBroadcast=true + 전달된 parentExcerpt 를 노출한다', () => {
    const dto = svc.toDto(row(), [], null, [], '루트 본문 일부');
    expect(dto.isBroadcast).toBe(true);
    expect(dto.parentExcerpt).toBe('루트 본문 일부');
  });

  it('일반 메시지는 isBroadcast=false / parentExcerpt=null', () => {
    const dto = svc.toDto(
      row({ isBroadcast: false, parentMessageId: null, type: 'DEFAULT' }),
      [],
      null,
      [],
      null,
    );
    expect(dto.isBroadcast).toBe(false);
    expect(dto.parentExcerpt).toBeNull();
  });

  it('삭제된 broadcast 는 본문/excerpt 를 마스킹하되 isBroadcast 표식은 유지한다', () => {
    const dto = svc.toDto(
      row({ deletedAt: new Date('2025-01-01T00:00:00Z') }),
      [],
      null,
      [],
      '루트',
    );
    expect(dto.deleted).toBe(true);
    expect(dto.content).toBeNull();
    expect(dto.parentExcerpt).toBeNull();
    // isBroadcast 는 행의 정체(채널 타임라인 분기)라 삭제돼도 유지된다.
    expect(dto.isBroadcast).toBe(true);
  });
});

// S35 fix-forward (보안 F-01/F-03): aggregateBroadcastExcerpts 는 루트를 broadcast
// 행의 channelId 로 스코프하고, 채널이 어긋난 루트는 excerpt 를 비워 cross-channel
// excerpt 누출을 막아야 한다.
describe('MessagesService.aggregateBroadcastExcerpts channelId 스코프 (F-01/F-03)', () => {
  function broadcastRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'bc-1',
      channelId: 'chan-A',
      authorId: 'a-1',
      content: 'reply body',
      contentPlain: 'reply body',
      contentRaw: 'reply body',
      contentAst: null,
      type: 'SYSTEM_THREAD_BROADCAST',
      mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
      editedAt: null,
      deletedAt: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      idempotencyKey: null,
      parentMessageId: 'root-1',
      version: 0,
      isBroadcast: true,
      ...overrides,
    } as never;
  }

  it('루트가 broadcast 행과 같은 채널이면 excerpt 를 산정한다', async () => {
    // prisma.message.findMany 가 chan-A 루트(동일 채널)를 돌려주는 모킹.
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: 'root-1', channelId: 'chan-A', content: '원본 루트 본문', deletedAt: null },
      ]);
    const svc = new MessagesService({ message: { findMany } } as never, {} as never);
    const out = await svc.aggregateBroadcastExcerpts([broadcastRow()]);
    expect(out.get('bc-1')).toBe('원본 루트 본문');
    // WHERE 절에 broadcast 채널 스코프가 포함되는지 확인(F-03).
    const arg = findMany.mock.calls[0][0] as { where: { channelId: { in: string[] } } };
    expect(arg.where.channelId.in).toEqual(['chan-A']);
  });

  it('루트가 다른 채널이면 excerpt 를 비운다(cross-channel 누출 방어)', async () => {
    // 모킹이 (방어 회피 시뮬레이션으로) 타채널 루트를 돌려줘도, 코드의 1:1
    // channelId 재확인이 excerpt 를 빈 값으로 만든다.
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: 'root-1', channelId: 'chan-B', content: '타채널 루트 본문', deletedAt: null },
      ]);
    const svc = new MessagesService({ message: { findMany } } as never, {} as never);
    const out = await svc.aggregateBroadcastExcerpts([broadcastRow()]);
    expect(out.get('bc-1')).toBe('');
  });

  it('삭제된 루트는 excerpt 를 비운다(레이블만)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'root-1',
        channelId: 'chan-A',
        content: '삭제 루트 본문',
        deletedAt: new Date('2025-01-01T00:00:00Z'),
      },
    ]);
    const svc = new MessagesService({ message: { findMany } } as never, {} as never);
    const out = await svc.aggregateBroadcastExcerpts([broadcastRow()]);
    expect(out.get('bc-1')).toBe('');
  });
});
