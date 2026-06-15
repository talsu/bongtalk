import { describe, it, expect, vi } from 'vitest';
import { UnreadService } from './unread.service';
import type { PrismaService } from '../prisma/prisma.module';

/**
 * 072 백로그 S-I (FR-RS-10 / N6-1): previewUnreads — 읽지 않음(>0) 채널 + 채널별 최근 읽지 않음 ≤5
 * 미리보기(작성자 해석·차단 마스킹·그룹화·정렬·커서). summarize 의 $queryRaw(1st) + preview
 * $queryRaw(2nd) + user/friendship.findMany 를 vi.fn 으로 스텁한다. 시스템 시간 고정.
 */
vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

const ME = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // author(정상)
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // author(차단)

function makeService(opts: {
  summaryRows: Array<{
    channel_id: string;
    unread_count: number;
    has_mention: boolean;
    mention_count: number;
    last_message_at: Date | null;
  }>;
  previewRows: Array<{
    channel_id: string;
    id: string;
    author_id: string;
    preview: string | null;
    created_at: Date;
  }>;
  users: Array<{ id: string; username: string }>;
  blocked: string[];
}) {
  const $queryRaw = vi
    .fn()
    .mockResolvedValueOnce(opts.summaryRows) // summarize()
    .mockResolvedValueOnce(opts.previewRows); // previewUnreads preview
  const userFindMany = vi.fn().mockResolvedValue(opts.users);
  const friendshipFindMany = vi
    .fn()
    .mockResolvedValue(opts.blocked.map((addresseeId) => ({ addresseeId })));
  const prisma = {
    $queryRaw,
    user: { findMany: userFindMany },
    friendship: { findMany: friendshipFindMany },
  } as unknown as PrismaService;
  return { svc: new UnreadService(prisma), $queryRaw };
}

describe('UnreadService.previewUnreads (072 S-I / FR-RS-10)', () => {
  it('읽지 않음(>0) 채널만 + 최근순 정렬, 채널별 메시지 그룹화', async () => {
    const { svc } = makeService({
      summaryRows: [
        // c1: 더 최근, c2: 더 오래됨, c3: 읽지 않음 0(제외).
        {
          channel_id: 'c1',
          unread_count: 2,
          has_mention: false,
          mention_count: 0,
          last_message_at: new Date('2025-01-01T10:00:00Z'),
        },
        {
          channel_id: 'c2',
          unread_count: 1,
          has_mention: false,
          mention_count: 0,
          last_message_at: new Date('2025-01-01T09:00:00Z'),
        },
        {
          channel_id: 'c3',
          unread_count: 0,
          has_mention: false,
          mention_count: 0,
          last_message_at: null,
        },
      ],
      previewRows: [
        {
          channel_id: 'c1',
          id: 'm2',
          author_id: A,
          preview: '두번째',
          created_at: new Date('2025-01-01T10:00:00Z'),
        },
        {
          channel_id: 'c1',
          id: 'm1',
          author_id: A,
          preview: '첫번째',
          created_at: new Date('2025-01-01T09:30:00Z'),
        },
        {
          channel_id: 'c2',
          id: 'm3',
          author_id: A,
          preview: 'hi',
          created_at: new Date('2025-01-01T09:00:00Z'),
        },
      ],
      users: [{ id: A, username: 'alice' }],
      blocked: [],
    });
    const res = await svc.previewUnreads('ws', ME);
    expect(res.items.map((i) => i.channelId)).toEqual(['c1', 'c2']); // c3(0) 제외, 최근순
    expect(res.items[0].messages.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(res.items[0].messages[0]).toMatchObject({
      authorUsername: 'alice',
      preview: '두번째',
      masked: false,
    });
    expect(res.nextCursor).toBeNull();
  });

  it('멘션 채널을 위로 정렬(sortUnreadsView 정합) — 오래됐어도 멘션이 먼저', async () => {
    const { svc } = makeService({
      summaryRows: [
        // c1: 최근·멘션 없음, c2: 오래됨·멘션 있음 → c2 가 위로.
        {
          channel_id: 'c1',
          unread_count: 1,
          has_mention: false,
          mention_count: 0,
          last_message_at: new Date('2025-01-01T10:00:00Z'),
        },
        {
          channel_id: 'c2',
          unread_count: 1,
          has_mention: true,
          mention_count: 2,
          last_message_at: new Date('2025-01-01T08:00:00Z'),
        },
      ],
      previewRows: [
        {
          channel_id: 'c1',
          id: 'm1',
          author_id: A,
          preview: 'a',
          created_at: new Date('2025-01-01T10:00:00Z'),
        },
        {
          channel_id: 'c2',
          id: 'm2',
          author_id: A,
          preview: 'b',
          created_at: new Date('2025-01-01T08:00:00Z'),
        },
      ],
      users: [{ id: A, username: 'alice' }],
      blocked: [],
    });
    const res = await svc.previewUnreads('ws', ME);
    expect(res.items.map((i) => i.channelId)).toEqual(['c2', 'c1']);
  });

  it('차단 작성자의 메시지는 마스킹(authorUsername/preview=null, masked=true)', async () => {
    const { svc } = makeService({
      summaryRows: [
        {
          channel_id: 'c1',
          unread_count: 1,
          has_mention: false,
          mention_count: 0,
          last_message_at: new Date('2025-01-01T10:00:00Z'),
        },
      ],
      previewRows: [
        {
          channel_id: 'c1',
          id: 'm1',
          author_id: B,
          preview: '차단됨 본문',
          created_at: new Date('2025-01-01T10:00:00Z'),
        },
      ],
      users: [{ id: B, username: 'badguy' }],
      blocked: [B],
    });
    const res = await svc.previewUnreads('ws', ME);
    expect(res.items[0].messages[0]).toMatchObject({
      authorId: null,
      authorUsername: null,
      preview: null,
      masked: true,
    });
  });

  it('limit 초과 시 nextCursor 발급(+1 채널로 hasMore 판정)', async () => {
    const summaryRows = [0, 1].map((i) => ({
      channel_id: `c${i}`,
      unread_count: 1,
      has_mention: false,
      mention_count: 0,
      last_message_at: new Date(Date.parse('2025-01-01T10:00:00Z') - i * 1000),
    }));
    const { svc } = makeService({
      summaryRows,
      previewRows: [
        {
          channel_id: 'c0',
          id: 'm0',
          author_id: A,
          preview: 'a',
          created_at: new Date('2025-01-01T10:00:00Z'),
        },
      ],
      users: [{ id: A, username: 'alice' }],
      blocked: [],
    });
    const res = await svc.previewUnreads('ws', ME, undefined, 1);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].channelId).toBe('c0');
    expect(res.nextCursor).toBeTruthy();
  });

  it('잘못된 cursor 는 VALIDATION_FAILED', async () => {
    const { svc } = makeService({ summaryRows: [], previewRows: [], users: [], blocked: [] });
    await expect(svc.previewUnreads('ws', ME, 'garbage!!!')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
