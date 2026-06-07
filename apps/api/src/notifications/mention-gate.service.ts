import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isDndSuppressed } from './dnd-gate';
import { NotifLevelService } from './notif-level.service';
import type { MentionKind } from './notif-level';
import type { DndSchedule } from '../me/dnd-schedule.service';

/**
 * S88b 리뷰 fix-forward (F1 / ★BLOCKER): 멘션 per-recipient 알림 게이트의 단일 출처.
 *
 * S88a 동기 send 경로(messages.service)와 S88b @role async 워커(mention-broadcast
 * .processor)가 **동일한** per-recipient 게이트를 거치도록, 종전에 messages.service
 * 안에만 있던 5게이트 fold 를 이 서비스로 추출한다. 두 경로가 같은 메서드를 호출하므로
 * divergence 의 원천이 제거된다(워커가 동기 경로 게이트를 빠뜨려 차단/뮤트/DND/OFF/
 * NotifLevel 사용자에게 @role 토스트·배지가 누출되던 회귀 차단 — block 누출은 보안 회귀).
 *
 * 게이트(어느 하나라도 차단이면 미알림):
 *   ① block       : 양방향 Friendship BLOCKED(FR-PS-14 "차단 시 @멘션 불가" · 보안계약).
 *                   작성자↔수신자 어느 방향이든 차단이면 제외.
 *   ② mute        : UserChannelMute 활성(isMuted && mutedUntil null|미래).
 *   ③ DND         : isDndSuppressed(수동 DND · dndUntil snooze · dndSchedule 구간).
 *   ④ thread-OFF  : 답글(parentMessageId 보유)일 때 루트의 ThreadSubscription
 *                   notificationLevel=OFF 구독자 제외(FR-TH-08 OFF 는 멘션도 차단).
 *   ⑤ NotifLevel  : NotifLevelService.buildGate fold(NOTHING→스킵 · MENTIONS→broad
 *                   스킵·direct 통과 · ALL→통과 · 채널/서버 뮤트 독립축).
 *
 * 모든 조회는 호출부가 넘긴 `tx` 안에서 수행해 atomic snapshot 을 보장한다(send tx /
 * 워커 tx 와 동일 스냅샷 — 별도 connection 의 stale 스냅샷 회피). 후보가 비면 즉시
 * 빈 Set 을 돌려준다(불필요한 RTT 없음).
 */
@Injectable()
export class MentionGateService {
  constructor(private readonly notifLevel: NotifLevelService) {}

  /**
   * 후보 수신자 중 **이 멘션 알림(mention.received)을 실제로 받아야 하는** userId 집합을
   * 게이트 fold 로 가려 돌려준다. 작성자(self)는 호출부가 미리 제외해야 한다(이 메서드는
   * candidate 를 그대로 게이트만 적용 — self 의미는 경로별로 다를 수 있어 책임 분리).
   *
   * @param tx          호출부 트랜잭션(atomic snapshot). 동기/워커 모두 tx 안에서 호출.
   * @param channelId   멘션이 발생한 채널.
   * @param workspaceId 워크스페이스(NotifLevel 서버 prefs · null=DM). @role 은 항상 non-null.
   * @param authorId    작성자(block 양방향 판정 기준).
   * @param parentMessageId 답글이면 루트 메시지 id(thread-OFF 게이트). null=루트 send.
   * @param candidateUserIds 게이트 후보(self 제외된 dedup 집합 권장).
   * @param kindFor     수신자별 멘션 종류(direct/broad). 미지정 시 전원 'direct'
   *                    (@role/@user 경로 — broad 확장이 없는 호출부 편의). messages.service
   *                    동기 경로는 broad(@everyone/@here) 수신자를 'broad' 로 분류해 넘긴다.
   * @param now         게이트 평가 기준 시각(mute/DND/level 만료 판정).
   */
  async filterNotifiable(
    tx: Prisma.TransactionClient,
    args: {
      channelId: string;
      workspaceId: string | null;
      authorId: string;
      parentMessageId: string | null;
      candidateUserIds: string[];
      kindFor?: (userId: string) => MentionKind;
      now: Date;
    },
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const candidates = Array.from(new Set(args.candidateUserIds.filter(Boolean)));
    if (candidates.length === 0) return out;
    const { channelId, workspaceId, authorId, parentMessageId, now } = args;
    const kindFor = args.kindFor ?? ((): MentionKind => 'direct');

    // ① block(양방향 BLOCKED Friendship). "차단 시 @멘션 불가"(FR-PS-14 · 보안계약).
    const blockedRows = await tx.friendship.findMany({
      where: {
        status: 'BLOCKED',
        OR: [
          { requesterId: authorId, addresseeId: { in: candidates } },
          { requesterId: { in: candidates }, addresseeId: authorId },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });
    const blockedSet = new Set<string>();
    for (const r of blockedRows) {
      blockedSet.add(r.requesterId === authorId ? r.addresseeId : r.requesterId);
    }

    // ② mute(UserChannelMute 활성 = isMuted && (mutedUntil null|미래)).
    const mutedRows = await tx.userChannelMute.findMany({
      where: {
        channelId,
        userId: { in: candidates },
        isMuted: true,
        OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
      },
      select: { userId: true },
    });
    const mutedSet = new Set(mutedRows.map((m) => m.userId));

    // ③ DND(수동 DND · dndUntil snooze · dndSchedule 구간). atomic snapshot.
    const dndRows = await tx.user.findMany({
      where: { id: { in: candidates } },
      select: {
        id: true,
        presencePreference: true,
        dndSchedule: true,
        timezone: true,
        settings: { select: { dndUntil: true } },
      },
    });
    const dndSet = new Set(
      dndRows
        .filter((r) =>
          isDndSuppressed(
            {
              presencePreference: r.presencePreference,
              dndSchedule: (r.dndSchedule as DndSchedule | null) ?? null,
              dndUntil: r.settings?.dndUntil ?? null,
              timezone: r.timezone,
            },
            now,
          ),
        )
        .map((r) => r.id),
    );

    // ④ thread-OFF(답글일 때만 — 루트 ThreadSubscription.notificationLevel=OFF 제외).
    const offSet = new Set<string>();
    if (parentMessageId) {
      const offRows = await tx.threadSubscription.findMany({
        where: {
          threadParentId: parentMessageId,
          userId: { in: candidates },
          notificationLevel: 'OFF',
        },
        select: { userId: true },
      });
      for (const r of offRows) offSet.add(r.userId);
    }

    // ⑤ NotifLevel 3계층 fold(NOTHING/MENTIONS-broad/뮤트 독립축). buildGate 가 tx 로
    //    batch 로드해 N+1 을 피한다(동기 경로와 동일 규약).
    const notifGate = await this.notifLevel.buildGate(
      { channelId, workspaceId, candidateUserIds: candidates, now },
      tx,
    );

    for (const uid of candidates) {
      // block 은 mute/DND/level 보다 먼저 — "차단 시 @멘션 불가" 우선.
      if (blockedSet.has(uid)) continue;
      if (mutedSet.has(uid)) continue;
      if (dndSet.has(uid)) continue;
      if (offSet.has(uid)) continue;
      if (!notifGate.shouldNotify(uid, kindFor(uid))) continue;
      out.add(uid);
    }
    return out;
  }
}
