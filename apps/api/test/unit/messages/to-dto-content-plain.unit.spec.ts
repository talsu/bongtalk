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
});
