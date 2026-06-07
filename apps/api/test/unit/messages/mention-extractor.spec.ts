import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractMentions,
  extractRoleMentions,
  normalizeContent,
  hasBroadMentionSignal,
} from '../../../src/messages/mentions/mention-extractor';
import { normalizeMentions } from '../../../src/messages/mentions/mention-normalizer';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type RoleRow = { id: string; name: string; mentionable: boolean };
type FakePrisma = {
  user: { findMany: ReturnType<typeof vi.fn> };
  channel: { findMany: ReturnType<typeof vi.fn> };
  role: { findMany: ReturnType<typeof vi.fn> };
};
function makePrisma(
  userRows: { id: string }[],
  channelRows: { id: string }[],
  roleRows: RoleRow[] = [],
): FakePrisma {
  return {
    user: { findMany: vi.fn().mockResolvedValue(userRows) },
    channel: { findMany: vi.fn().mockResolvedValue(channelRows) },
    role: { findMany: vi.fn().mockResolvedValue(roleRows) },
  };
}

describe('extractMentions', () => {
  const WS = '00000000-0000-4000-8000-00000000aaaa';

  it('parses @username tokens, dedupes, scopes to workspace members', async () => {
    const fake = makePrisma([{ id: 'u1' }, { id: 'u2' }], []);
    const out = await extractMentions(fake as any, WS, 'hi @alice and @bob and @alice again');
    expect(out.users.sort()).toEqual(['u1', 'u2']);
    expect(out.everyone).toBe(false);
    const call = fake.user.findMany.mock.calls[0][0];
    expect(call.where.memberships.some.workspaceId).toBe(WS);
    expect(new Set(call.where.username.in)).toEqual(new Set(['alice', 'bob']));
  });

  it('parses #channel tokens (lowercase, dash allowed)', async () => {
    const fake = makePrisma([], [{ id: 'c1' }]);
    const out = await extractMentions(fake as any, WS, 'see #general and #not-a-channel!');
    expect(out.channels).toEqual(['c1']);
    const call = fake.channel.findMany.mock.calls[0][0];
    expect(new Set(call.where.name.in)).toEqual(new Set(['general', 'not-a-channel']));
  });

  it('detects @everyone as a separate flag (not a username)', async () => {
    const fake = makePrisma([], []);
    const out = await extractMentions(fake as any, WS, 'ping @everyone!');
    expect(out.everyone).toBe(true);
    expect(out.users).toEqual([]);
    expect(fake.user.findMany).not.toHaveBeenCalled();
  });

  it('ignores tokens embedded in words (email-like, code-like)', async () => {
    const fake = makePrisma([], []);
    await extractMentions(fake as any, WS, 'mail me@example.com or look#1');
    expect(fake.user.findMany).not.toHaveBeenCalled();
    expect(fake.channel.findMany).not.toHaveBeenCalled();
  });

  it('drops unknown handles (not in workspace) silently', async () => {
    const fake = makePrisma([], []); // no matching users
    const out = await extractMentions(fake as any, WS, '@ghost hello');
    expect(out.users).toEqual([]);
  });

  it('mixes user, channel, and everyone in one message', async () => {
    const fake = makePrisma([{ id: 'u1' }], [{ id: 'c1' }]);
    const out = await extractMentions(fake as any, WS, '@alice ping #general @everyone');
    expect(out).toEqual({
      users: ['u1'],
      channels: ['c1'],
      everyone: true,
      here: false,
      channel: false,
      roles: [],
    });
  });

  /**
   * S21 (FR-RS-16): `@channel` 특수멘션(채널 스코프) 인식.
   */
  it('detects @channel as a separate scope flag (not a username)', async () => {
    const fake = makePrisma([], []);
    const out = await extractMentions(fake as any, WS, 'heads up @channel');
    expect(out.channel).toBe(true);
    expect(out.users).toEqual([]);
    expect(out.everyone).toBe(false);
    expect(out.here).toBe(false);
  });

  it('channelwide 같은 단어 안의 channel 은 무시', async () => {
    const fake = makePrisma([], []);
    const out = await extractMentions(fake as any, WS, 'a @channelwide token');
    expect(out.channel).toBe(false);
  });

  /**
   * task-046 iter8 (A9): `@here` 인식.
   */
  it('detects @here as a separate flag (not a username)', async () => {
    const fake = makePrisma([], []);
    const out = await extractMentions(fake as any, WS, 'pls @here check');
    expect(out.here).toBe(true);
    expect(out.users).toEqual([]);
    expect(out.everyone).toBe(false);
  });

  it('@here at line boundaries with surrounding tokens', async () => {
    const fake = makePrisma([{ id: 'u1' }], []);
    const out = await extractMentions(fake as any, WS, '@here @alice ping');
    expect(out.here).toBe(true);
    expect(out.users).toEqual(['u1']);
    expect(out.everyone).toBe(false);
  });

  it('hereisnotaword 같은 단어 안의 here 는 무시', async () => {
    const fake = makePrisma([], []);
    const out = await extractMentions(fake as any, WS, 'this iswhereiwantto @hereisnotaword');
    expect(out.here).toBe(false);
  });
});

// S88a (FR-MN-03 / D1): `@<RoleName>` 역할 멘션 추출 — 알려진 워크스페이스 역할명
// longest-match · case-insensitive · 경계 anchored · 예약어 제외 · 미지명 silent drop.
describe('extractRoleMentions (S88a / FR-MN-03)', () => {
  const WS = '00000000-0000-4000-8000-00000000aaaa';

  it('@ 가 없으면 역할 목록 쿼리 없이 즉시 [] 반환', async () => {
    const fake = makePrisma([], [], [{ id: 'r1', name: 'PM', mentionable: true }]);
    const out = await extractRoleMentions(fake as any, WS, 'no mentions here');
    expect(out).toEqual([]);
    expect(fake.role.findMany).not.toHaveBeenCalled();
  });

  it('workspaceId=null(DM) 이면 [] (쿼리 생략)', async () => {
    const fake = makePrisma([], [], [{ id: 'r1', name: 'PM', mentionable: true }]);
    const out = await extractRoleMentions(fake as any, null, 'ping @PM');
    expect(out).toEqual([]);
    expect(fake.role.findMany).not.toHaveBeenCalled();
  });

  it('알려진 역할명을 매칭하고 mentionable 플래그를 함께 반환', async () => {
    const fake = makePrisma(
      [],
      [],
      [
        { id: 'r1', name: 'Engineers', mentionable: true },
        { id: 'r2', name: 'Admins', mentionable: false },
      ],
    );
    const out = await extractRoleMentions(fake as any, WS, 'hey @Engineers and @Admins');
    expect(out).toEqual([
      { id: 'r1', name: 'Engineers', mentionable: true },
      { id: 'r2', name: 'Admins', mentionable: false },
    ]);
  });

  it('공백 포함 역할명(다단어)도 정확히 매칭', async () => {
    const fake = makePrisma([], [], [{ id: 'r1', name: 'Project Managers', mentionable: true }]);
    const out = await extractRoleMentions(fake as any, WS, 'cc @Project Managers please');
    expect(out.map((r) => r.id)).toEqual(['r1']);
  });

  it('longest-match — 긴 이름만 매칭하고 짧은 prefix 는 제외(F3 소비 기반)', async () => {
    const fake = makePrisma(
      [],
      [],
      [
        { id: 'short', name: 'PM', mentionable: true },
        { id: 'long', name: 'PM Leads', mentionable: true },
      ],
    );
    const out = await extractRoleMentions(fake as any, WS, 'ping @PM Leads now');
    // S88a review F3 (data integrity): 단일 패스 소비 기반 스캐너라 "PM Leads" 구간을
    // 소비하므로 짧은 prefix "PM" 은 같은 구간을 재매칭하지 못한다. 종전 구현은 둘 다
    // 매칭해 짧은 역할 멤버에게도 과다 fanout + 저장 토큰과 mentions.roles 불일치를
    // 일으켰다. 이제 roles=[longId] 만 나와야 한다.
    expect(out.map((r) => r.id)).toEqual(['long']);
  });

  it('짧은 prefix 역할이 단독으로 등장하면 그 역할만 매칭', async () => {
    const fake = makePrisma(
      [],
      [],
      [
        { id: 'short', name: 'PM', mentionable: true },
        { id: 'long', name: 'PM Leads', mentionable: true },
      ],
    );
    const out = await extractRoleMentions(fake as any, WS, 'ping @PM now');
    expect(out.map((r) => r.id)).toEqual(['short']);
  });

  it('case-insensitive 매칭', async () => {
    const fake = makePrisma([], [], [{ id: 'r1', name: 'Engineers', mentionable: true }]);
    const out = await extractRoleMentions(fake as any, WS, 'yo @engineers');
    expect(out.map((r) => r.id)).toEqual(['r1']);
  });

  it('예약어(everyone/here/channel) 동명 역할은 제외', async () => {
    const fake = makePrisma(
      [],
      [],
      [
        { id: 'r1', name: 'everyone', mentionable: true },
        { id: 'r2', name: 'here', mentionable: true },
        { id: 'r3', name: 'channel', mentionable: true },
      ],
    );
    const out = await extractRoleMentions(fake as any, WS, '@everyone @here @channel');
    expect(out).toEqual([]);
  });

  it('미지의 역할명은 silent drop(알려진 목록에 없으면 매칭 안 함)', async () => {
    const fake = makePrisma([], [], [{ id: 'r1', name: 'Engineers', mentionable: true }]);
    const out = await extractRoleMentions(fake as any, WS, 'ping @Marketing');
    expect(out).toEqual([]);
  });

  it('단어 안에 포함된 역할명은 경계 가드로 무시', async () => {
    const fake = makePrisma([], [], [{ id: 'r1', name: 'PM', mentionable: true }]);
    const out = await extractRoleMentions(fake as any, WS, 'email me@PManager.com');
    expect(out).toEqual([]);
  });
});

// S88a (FR-MN-03 / D1): normalizeMentions 역할 패스(user 패스보다 먼저) — 알려진
// 역할명 @<RoleName> → <@&roleId>, 그 다음 @username → @{userId}.
describe('normalizeMentions — role pass (S88a / FR-MN-03)', () => {
  it('역할 토큰을 <@&roleId> 로 치환한다', () => {
    const out = normalizeMentions('ping @Engineers please', () => null, [
      { name: 'Engineers', roleId: 'r1' },
    ]);
    expect(out).toBe('ping <@&r1> please');
  });

  it('다단어 역할명을 user 패스가 부분 매칭하지 않게 역할 패스가 먼저 처리', () => {
    // resolver 가 'Project' 핸들을 우연히 알아도, 역할 패스가 먼저 전체를 토큰화한다.
    const resolve = (h: string): string | null => (h.toLowerCase() === 'project' ? 'uX' : null);
    const out = normalizeMentions('cc @Project Managers ok', resolve, [
      { name: 'Project Managers', roleId: 'r9' },
    ]);
    expect(out).toBe('cc <@&r9> ok');
  });

  it('역할 + 사용자 멘션 혼합 — 역할 먼저, 그 다음 @username', () => {
    const handle = new Map([['alice', 'u1']]);
    const out = normalizeMentions(
      'hey @Engineers and @alice',
      (h) => handle.get(h.toLowerCase()) ?? null,
      [{ name: 'Engineers', roleId: 'r1' }],
    );
    expect(out).toBe('hey <@&r1> and @{u1}');
  });

  it('roleTokens 가 비면 역할 패스를 건너뛴다(기존 동작)', () => {
    const out = normalizeMentions('hi @alice', (h) => (h === 'alice' ? 'u1' : null));
    expect(out).toBe('hi @{u1}');
  });

  it('코드 영역의 역할명은 치환하지 않는다', () => {
    const out = normalizeMentions('`@Engineers` literal', () => null, [
      { name: 'Engineers', roleId: 'r1' },
    ]);
    expect(out).toBe('`@Engineers` literal');
  });

  it('longest-match — 긴 역할명을 먼저 치환해 부분 매칭을 막는다', () => {
    const out = normalizeMentions('ping @PM Leads', () => null, [
      { name: 'PM', roleId: 'rShort' },
      { name: 'PM Leads', roleId: 'rLong' },
    ]);
    expect(out).toBe('ping <@&rLong>');
  });
});

describe('normalizeContent', () => {
  it('strips mention sigils and collapses whitespace', () => {
    expect(normalizeContent('Hey @alice,   look at   #general!')).toBe(
      'Hey alice, look at general!',
    );
  });

  it('leaves non-mention content alone', () => {
    expect(normalizeContent('plain text — no hashes')).toBe('plain text — no hashes');
  });
});

// S44 fix-forward (MAJOR · perf): 컨트롤러가 범위 멘션 신호가 있을 때만
// resolveMentionEveryone(override findMany)을 호출하도록 하는 저비용 사전스캔.
describe('hasBroadMentionSignal', () => {
  it('@everyone / @here / @channel 토큰을 감지한다', () => {
    expect(hasBroadMentionSignal('ping @everyone')).toBe(true);
    expect(hasBroadMentionSignal('standup @here')).toBe(true);
    expect(hasBroadMentionSignal('heads up @channel')).toBe(true);
  });

  it('범위 멘션이 없는 일반 본문은 false — override fold 를 skip 한다', () => {
    expect(hasBroadMentionSignal('plain message')).toBe(false);
    // @username / #channel 은 broad 신호가 아니다(직접 멘션).
    expect(hasBroadMentionSignal('hi @alice in #general')).toBe(false);
    // 단어 경계 — @herewego 같은 부분일치는 신호가 아니다.
    expect(hasBroadMentionSignal('go @herewego now')).toBe(false);
    expect(hasBroadMentionSignal('@everyoneish hmm')).toBe(false);
  });
});
