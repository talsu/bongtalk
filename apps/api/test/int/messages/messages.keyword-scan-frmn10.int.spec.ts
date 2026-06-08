/**
 * FR-MN-10 (Task 066 / S93) 키워드 알림 스캔 통합 검증 — 실 Postgres + Redis(testcontainer)
 * + 실 mention-scan BullMQ 워커(in-process · AppModule 부팅으로 활성).
 *
 * 커버리지(ADR Acceptance):
 *   - 루트 메시지에 watcher 키워드 포함 → MentionRecord(KEYWORD, targetId=watcher) 1행 +
 *     mention.received(keyword=true) outbox 1건 + me-mentions recent()/unreadCount() 노출.
 *   - 스레드 댓글(parentMessageId≠null)에 키워드 → MentionRecord 0행·outbox 0건.
 *   - 작성자 자기 키워드 → 무생성. mute/DND/block/NotifLevel=NOTHING watcher → 무생성.
 *   - 이미 @user 멘션된(syncNotified) watcher → KEYWORD record 미생성(1수신자 1 Inbox).
 *   - whole-word: "redeploys" 본문에 "deploy" 키워드 → 불일치(substring 아님).
 *   - 비공개 채널 비멤버 watcher → 무알림.
 *
 * 검증은 outbox/MentionRecord 행을 직접 조회해 권위적으로 한다(dispatcher 무관 · s88b 패턴).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  MsgIntEnv,
  ORIGIN,
  bearer,
  seedMessageStack,
  signup,
  setupMsgIntEnv,
  waitForMentionScanDrain,
} from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;
let watcherB: Awaited<ReturnType<typeof signup>>;
let watcherC: Awaited<ReturnType<typeof signup>>;

async function joinWorkspace(token: string): Promise<void> {
  const inv = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ maxUses: 10 });
  const code = inv.body.invite.code as string;
  await request(env.baseUrl)
    .post(`/invites/${code}/accept`)
    .set('origin', ORIGIN)
    .set(bearer(token));
}

async function setKeywords(token: string, keywords: string[]): Promise<void> {
  const res = await request(env.baseUrl)
    .patch('/me/settings/notifications')
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ keywords });
  if (res.status !== 200) throw new Error(`setKeywords: ${res.status} ${res.text}`);
}

async function postMessage(
  token: string,
  channelId: string,
  content: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content, ...extra });
  if (res.status !== 201) throw new Error(`postMessage: ${res.status} ${res.text}`);
  return res.body.message.id as string;
}

/** 특정 메시지의 KEYWORD MentionRecord targetId 집합. */
async function keywordTargets(messageId: string): Promise<string[]> {
  const rows = await env.prisma.mentionRecord.findMany({
    where: { messageId, targetType: 'KEYWORD' },
    select: { targetId: true },
  });
  return rows.map((r) => r.targetId).sort();
}

/** 특정 메시지의 mention.received outbox 수신자(aggregateId) 집합. */
async function outboxTargets(messageId: string): Promise<string[]> {
  const rows = await env.prisma.outboxEvent.findMany({
    where: { aggregateType: 'UserMention', eventType: 'mention.received' },
    select: { aggregateId: true, payload: true },
  });
  return rows
    .filter((r) => (r.payload as { messageId?: string } | null)?.messageId === messageId)
    .map((r) => r.aggregateId)
    .sort();
}

/** 특정 메시지·수신자의 mention.received outbox payload(keyword 플래그 확인용). */
async function outboxPayload(
  messageId: string,
  targetId: string,
): Promise<{ keyword?: boolean } | null> {
  const rows = await env.prisma.outboxEvent.findMany({
    where: { aggregateType: 'UserMention', eventType: 'mention.received', aggregateId: targetId },
    select: { payload: true },
  });
  const match = rows.find(
    (r) => (r.payload as { messageId?: string } | null)?.messageId === messageId,
  );
  return (match?.payload as { keyword?: boolean }) ?? null;
}

/** 워커가 KEYWORD record 를 expected 개수만큼 쓸 때까지 폴링한다(잡 drain 대기). */
async function waitForKeywordRecords(messageId: string, expected: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const n = (await keywordTargets(messageId)).length;
    if (n >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for ${expected} KEYWORD record(s) on msg=${messageId}, got ${n}`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
  watcherB = await signup(env.baseUrl, 'kwb');
  watcherC = await signup(env.baseUrl, 'kwc');
  await joinWorkspace(watcherB.accessToken);
  await joinWorkspace(watcherC.accessToken);
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.mentionRecord.deleteMany({});
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  await env.prisma.channelPermissionOverride.deleteMany({});
  await env.prisma.userChannelMute.deleteMany({});
  await env.prisma.friendship.deleteMany({});
  await env.prisma.serverNotificationPref.deleteMany({});
  await env.prisma.userSettings.deleteMany({
    where: { userId: { in: [watcherB.userId, watcherC.userId, stack.member.userId] } },
  });
  const keys = await env.redis.keys('qufox:rl:*');
  if (keys.length > 0) {
    await env.redis.del(...keys.map((k) => k.replace(/^qufox:/, '')));
  }
});

describe('FR-MN-10 root keyword scan (public channel)', () => {
  it('루트 키워드 일치 → KEYWORD record + outbox(keyword:true) + me-mentions 노출', async () => {
    await setKeywords(watcherB.accessToken, ['deploy']);

    const msgId = await postMessage(stack.member.accessToken, stack.channelId, "let's deploy now");
    await waitForKeywordRecords(msgId, 1);

    expect(await keywordTargets(msgId)).toEqual([watcherB.userId]);
    expect(await outboxTargets(msgId)).toEqual([watcherB.userId]);
    const payload = (await outboxPayload(msgId, watcherB.userId)) as {
      keyword?: boolean;
      everyone?: boolean;
      here?: boolean;
      role?: boolean;
    } | null;
    expect(payload?.keyword).toBe(true);
    // 플래그 비오염: 키워드-only 멘션은 broad/@role 표식을 달지 않는다(everyone/here/role false).
    expect(payload?.everyone).toBe(false);
    expect(payload?.here).toBe(false);
    expect(payload?.role).toBe(false);

    // me-mentions: keyword 유래 멘션이 historical Inbox 에 노출되고 keyword=true.
    const inbox = await request(env.baseUrl)
      .get('/me/mentions')
      .set('origin', ORIGIN)
      .set(bearer(watcherB.accessToken));
    expect(inbox.status).toBe(200);
    const row = (
      inbox.body.recent as Array<{
        messageId: string;
        keyword: boolean;
        everyone: boolean;
        here: boolean;
      }>
    ).find((r) => r.messageId === msgId);
    expect(row).toBeTruthy();
    expect(row?.keyword).toBe(true);
    // 키워드-only Inbox 행은 everyone/here 플래그가 message JSON 에서 false 로 유지된다.
    expect(row?.everyone).toBe(false);
    expect(row?.here).toBe(false);
    expect(inbox.body.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it('whole-word: "redeploys" 본문에 "deploy" 키워드 → 불일치(substring 아님)', async () => {
    await setKeywords(watcherB.accessToken, ['deploy']);

    const msgId = await postMessage(
      stack.member.accessToken,
      stack.channelId,
      'we had redeploys today',
    );
    await waitForMentionScanDrain(env.mentionScanQueue);
    await new Promise((r) => setTimeout(r, 300));

    expect(await keywordTargets(msgId)).toEqual([]);
    expect(await outboxTargets(msgId)).toEqual([]);
  });

  it('작성자 본인 키워드 → 무알림(self 제외)', async () => {
    await setKeywords(stack.member.accessToken, ['deploy']);

    const msgId = await postMessage(stack.member.accessToken, stack.channelId, 'deploy please');
    await waitForMentionScanDrain(env.mentionScanQueue);
    await new Promise((r) => setTimeout(r, 300));

    expect(await keywordTargets(msgId)).toEqual([]);
  });
});

describe('FR-MN-10 thread reply excluded', () => {
  it('스레드 댓글(parentMessageId≠null)에 키워드 → record 0 · outbox 0', async () => {
    await setKeywords(watcherB.accessToken, ['deploy']);

    // 루트 메시지(키워드 없음) → 그 아래 답글에 키워드.
    const rootId = await postMessage(stack.member.accessToken, stack.channelId, 'thread root');
    await waitForMentionScanDrain(env.mentionScanQueue);
    await env.prisma.outboxEvent.deleteMany({});

    const replyId = await postMessage(stack.member.accessToken, stack.channelId, 'deploy now', {
      parentMessageId: rootId,
    });
    await waitForMentionScanDrain(env.mentionScanQueue);
    await new Promise((r) => setTimeout(r, 300));

    expect(await keywordTargets(replyId)).toEqual([]);
    expect(await outboxTargets(replyId)).toEqual([]);
  });
});

describe('FR-MN-10 per-recipient gate negative guards', () => {
  async function postAndDrainWithControl(): Promise<string> {
    // watcherB(게이트 대상) + watcherC(대조군) 둘 다 'deploy' 키워드 등록.
    await setKeywords(watcherB.accessToken, ['deploy']);
    await setKeywords(watcherC.accessToken, ['deploy']);
    const msgId = await postMessage(stack.member.accessToken, stack.channelId, 'time to deploy');
    await waitForMentionScanDrain(env.mentionScanQueue);
    // 대조군(watcherC)은 게이트를 통과하므로 최소 1행이 쓰여야 한다.
    await waitForKeywordRecords(msgId, 1);
    await new Promise((r) => setTimeout(r, 300));
    return msgId;
  }

  it('① 차단(BLOCKED Friendship) watcher 제외 — watcherB 0, 대조군 watcherC 1', async () => {
    await env.prisma.friendship.create({
      data: { requesterId: watcherB.userId, addresseeId: stack.member.userId, status: 'BLOCKED' },
    });
    const msgId = await postAndDrainWithControl();
    expect(await keywordTargets(msgId)).toEqual([watcherC.userId]);
    expect(await outboxTargets(msgId)).toEqual([watcherC.userId]);
  });

  it('② 채널 뮤트(UserChannelMute) watcher 제외 — watcherB 0, 대조군 watcherC 1', async () => {
    await env.prisma.userChannelMute.create({
      data: {
        userId: watcherB.userId,
        channelId: stack.channelId,
        isMuted: true,
        mutedUntil: null,
      },
    });
    const msgId = await postAndDrainWithControl();
    expect(await keywordTargets(msgId)).toEqual([watcherC.userId]);
    expect(await outboxTargets(msgId)).toEqual([watcherC.userId]);
  });

  it('③ 글로벌 NotifLevel=NOTHING watcher 제외 — watcherB 0, 대조군 watcherC 1', async () => {
    // setKeywords 가 UserSettings 를 만들므로, NOTHING 은 그 뒤 update 로 덮어쓴다.
    await setKeywords(watcherB.accessToken, ['deploy']);
    await env.prisma.userSettings.update({
      where: { userId: watcherB.userId },
      data: { notifTrigger: 'NOTHING' },
    });
    await setKeywords(watcherC.accessToken, ['deploy']);

    const msgId = await postMessage(stack.member.accessToken, stack.channelId, 'time to deploy');
    await waitForMentionScanDrain(env.mentionScanQueue);
    await waitForKeywordRecords(msgId, 1);
    await new Promise((r) => setTimeout(r, 300));

    expect(await keywordTargets(msgId)).toEqual([watcherC.userId]);
    expect(await outboxTargets(msgId)).toEqual([watcherC.userId]);
  });

  it('④ DND snooze(dndUntil 미래) watcher 제외 — watcherB 0, 대조군 watcherC 1', async () => {
    // setKeywords 가 UserSettings 를 만든 뒤 dndUntil 을 시스템 시각(2025-01-01) 이후로
    // 덮어쓴다. 공유 MentionGateService 의 ③ DND 게이트(isDndSuppressed: dndUntil > now)가
    // watcherB 를 제외해야 한다(키워드 알림도 동기 @user 와 동일 게이트 통과).
    await setKeywords(watcherB.accessToken, ['deploy']);
    await env.prisma.userSettings.update({
      where: { userId: watcherB.userId },
      data: { dndUntil: new Date('2025-01-01T01:00:00Z') },
    });
    await setKeywords(watcherC.accessToken, ['deploy']);

    const msgId = await postMessage(stack.member.accessToken, stack.channelId, 'time to deploy');
    await waitForMentionScanDrain(env.mentionScanQueue);
    await waitForKeywordRecords(msgId, 1);
    await new Promise((r) => setTimeout(r, 300));

    expect(await keywordTargets(msgId)).toEqual([watcherC.userId]);
    expect(await outboxTargets(msgId)).toEqual([watcherC.userId]);
  });
});

describe('FR-MN-10 cross-path dedup with @user mention', () => {
  it('이미 @user 멘션된 watcher → KEYWORD record 미생성(1수신자 1 Inbox)', async () => {
    // watcherB 가 'deploy' 키워드 보유 + 본문에서 @user 직접 멘션 → 동기 outbox 1건만.
    await setKeywords(watcherB.accessToken, ['deploy']);

    const msgId = await postMessage(
      stack.member.accessToken,
      stack.channelId,
      `@${watcherB.username} please deploy`,
    );
    await waitForMentionScanDrain(env.mentionScanQueue);
    await new Promise((r) => setTimeout(r, 300));

    // 동기 @user outbox 1건만 · KEYWORD record 0(syncNotified 제외).
    expect(await keywordTargets(msgId)).toEqual([]);
    expect(await outboxTargets(msgId)).toEqual([watcherB.userId]);
  });
});

describe('FR-MN-10 private channel non-member', () => {
  it('비공개 채널 비멤버 watcher → 무알림(VIEW_CHANNEL 비가시)', async () => {
    const ch = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({
        name: `kw-priv-${Date.now().toString(36).slice(-6)}`,
        type: 'TEXT',
        isPrivate: true,
      });
    expect(ch.status).toBe(201);
    const privId = ch.body.id as string;

    // watcherB(비가시) + owner(가시) 둘 다 키워드 등록. owner 가 본인 메시지 작성이므로 self
    // 제외 → 비공개 채널에 가시인 작성자만 있어 watcherB 는 비가시로 제외돼 record 0.
    await setKeywords(watcherB.accessToken, ['outage']);

    const msgId = await postMessage(stack.owner.accessToken, privId, 'major outage now');
    await waitForMentionScanDrain(env.mentionScanQueue);
    await new Promise((r) => setTimeout(r, 400));

    expect(await keywordTargets(msgId)).toEqual([]);
    expect(await outboxTargets(msgId)).toEqual([]);
  });
});
