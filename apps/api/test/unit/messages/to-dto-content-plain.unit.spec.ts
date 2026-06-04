import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagesService } from '../../../src/messages/messages.service';

/**
 * S37 (FR-MSG-17): toDto 가 평문 정본(contentPlain)을 직렬화하는지 검증한다.
 *
 * 검증 포인트:
 *   - contentPlainV2(신규 슬롯) 우선 emit
 *   - contentPlainV2 부재 시 legacy contentPlain 폴백
 *   - 둘 다 부재 시 null
 *   - soft-deleted 메시지는 content 와 동일하게 contentPlain 도 null 마스킹
 *   - maskBlockedAuthors 가 contentPlain 도 placeholder 로 치환
 *
 * Prisma/outbox 는 사용하지 않는 순수 toDto/마스킹 경로라 vi.fn() stub 으로
 * 서비스만 인스턴스화한다(harness: vi.fn() 만 허용).
 */

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type Row = Parameters<MessagesService['toDto']>[0];

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: '**bold** text',
    contentPlain: 'bold text',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    idempotencyKey: null,
    parentMessageId: null,
    pinnedAt: null,
    pinnedBy: null,
    ...overrides,
  } as Row;
}

function makeService(): MessagesService {
  const prisma = {} as unknown as ConstructorParameters<typeof MessagesService>[0];
  const outbox = { record: vi.fn() } as unknown as ConstructorParameters<typeof MessagesService>[1];
  return new MessagesService(prisma, outbox);
}

describe('MessagesService.toDto contentPlain (FR-MSG-17)', () => {
  it('contentPlainV2(신규 슬롯)를 우선 직렬화한다', () => {
    const svc = makeService();
    const dto = svc.toDto(makeRow({ contentPlain: 'legacy plain', contentPlainV2: 'v2 plain' }));
    expect(dto.contentPlain).toBe('v2 plain');
  });

  it('contentPlainV2 가 없으면 legacy contentPlain 으로 폴백한다', () => {
    const svc = makeService();
    const dto = svc.toDto(makeRow({ contentPlain: 'legacy plain' }));
    expect(dto.contentPlain).toBe('legacy plain');
  });

  it('contentPlainV2/contentPlain 둘 다 없으면 null', () => {
    const svc = makeService();
    // contentPlain 을 빈 슬롯으로 강제(런타임 SELECT 미선택 모사).
    const dto = svc.toDto(
      makeRow({ contentPlain: undefined as unknown as string, contentPlainV2: null }),
    );
    expect(dto.contentPlain).toBeNull();
  });

  it('soft-deleted 메시지는 contentPlain 을 null 로 마스킹한다(content 와 동일 정책)', () => {
    const svc = makeService();
    const dto = svc.toDto(
      makeRow({ deletedAt: new Date('2025-01-01T00:00:00Z'), contentPlainV2: 'secret plain' }),
    );
    expect(dto.deleted).toBe(true);
    expect(dto.content).toBeNull();
    expect(dto.contentPlain).toBeNull();
  });

  it('maskBlockedAuthors 가 contentPlain 도 placeholder 로 치환한다', () => {
    const svc = makeService();
    const blockedAuthor = '33333333-3333-4333-8333-333333333333';
    const dto = svc.toDto(makeRow({ contentPlainV2: 'blocked plain body' }));
    const [masked] = svc.maskBlockedAuthors([dto], new Set([blockedAuthor]));
    expect(masked.content).toBe('[차단된 사용자의 메시지]');
    expect(masked.contentPlain).toBe('[차단된 사용자의 메시지]');
  });

  // S75 fix-forward (F2): broadcast 행의 parentExcerpt(루트 본문) 누출 차단.
  describe('maskBlockedAuthors broadcast parentExcerpt (F2)', () => {
    const rowAuthor = '33333333-3333-4333-8333-333333333333';
    const rootAuthor = '44444444-4444-4444-8444-444444444444';

    it('행 author 차단 시 본문과 함께 parentExcerpt 도 비운다', () => {
      const svc = makeService();
      const dto = svc.toDto(
        makeRow({ isBroadcast: true, parentMessageId: 'root-1' } as Partial<Row>),
        [],
        null,
        [],
        '차단 작성자의 루트 본문',
      );
      const [masked] = svc.maskBlockedAuthors([dto], new Set([rowAuthor]));
      expect(masked.content).toBe('[차단된 사용자의 메시지]');
      expect(masked.parentExcerpt).toBe('');
    });

    it('행 author 는 비차단이지만 루트 작성자가 차단되면 parentExcerpt 만 비우고 본문은 유지한다', () => {
      const svc = makeService();
      const dto = svc.toDto(
        makeRow({
          authorId: '55555555-5555-4555-8555-555555555555',
          content: 'reply body',
          contentPlain: 'reply body',
          isBroadcast: true,
          parentMessageId: 'root-1',
        } as Partial<Row>),
        [],
        null,
        [],
        '차단 루트 작성자의 본문',
      );
      // broadcast 행 id → 루트 작성자(차단됨) 맵을 전달.
      const rootMap = new Map<string, string | null>([[dto.id, rootAuthor]]);
      const [masked] = svc.maskBlockedAuthors([dto], new Set([rootAuthor]), rootMap);
      // 행 author(답글 작성자)는 비차단 → 본문 유지.
      expect(masked.content).toBe('reply body');
      // 루트 작성자가 차단 → parentExcerpt 누출 차단.
      expect(masked.parentExcerpt).toBe('');
    });

    it('행 author·루트 작성자 모두 비차단이면 parentExcerpt 를 그대로 둔다', () => {
      const svc = makeService();
      const dto = svc.toDto(
        makeRow({
          authorId: '55555555-5555-4555-8555-555555555555',
          isBroadcast: true,
          parentMessageId: 'root-1',
        } as Partial<Row>),
        [],
        null,
        [],
        '루트 본문',
      );
      const rootMap = new Map<string, string | null>([[dto.id, rootAuthor]]);
      // blocked-set 에 무관한 author 만 → 마스킹 비대상.
      const [masked] = svc.maskBlockedAuthors(
        [dto],
        new Set(['99999999-9999-4999-8999-999999999999']),
        rootMap,
      );
      expect(masked.parentExcerpt).toBe('루트 본문');
    });
  });
});
