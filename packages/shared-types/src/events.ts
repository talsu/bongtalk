import { z } from 'zod';
import { MessageMentionsSchema } from './message';
import { MessageEmbedDtoSchema } from './links';
import { TYPING_MAX_VISIBLE } from './constants';

/**
 * ADR-12 · WS 이벤트 카탈로그 단일 정의.
 *
 * 모든 WS 이벤트명과 페이로드 스키마는 본 파일에서만 정의합니다. D01 · D16 ·
 * D17 은 이 파일만 import 하여 참조하며 중복 정의하지 않습니다.
 *
 * FR-RC23: S→C 메시지 이벤트는 반드시 과거분사형
 * message:created / message:updated / message:deleted 를 사용합니다.
 * 현재형 message:create / message:update / message:delete 표기는 폐기됩니다.
 */
export const WS_EVENTS = {
  // 연결 / 룸
  CONNECTION_READY: 'connection:ready',
  CHANNEL_JOIN: 'channel:join',
  CHANNEL_JOINED: 'channel:joined',
  CHANNEL_LEAVE: 'channel:leave',
  CHANNEL_SYNCED: 'channel:synced',
  CHANNEL_ERROR: 'channel:error',
  // 메시지 (S→C, 과거분사형 — FR-RC23)
  MESSAGE_CREATED: 'message:created',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  // 반응 (S39 · FR-RE03): 반응 추가/제거 성공 시 채널 룸 전체에 fanout 한다.
  // payload 는 messageId + 전체 반응 집계 배열(emoji, count, users[≤5]). 서버
  // 내부 outbox eventType 은 dot 표기(message.reaction.updated)지만 outbox→WS
  // subscriber 가 이 콜론 wire 이름으로 변환해 emit 한다(thread:lock:changed
  // 선례). per-viewer `me` 는 브로드캐스트 payload 에 담을 수 없으므로(수신자마다
  // 다름) 제외하며, 클라 dispatcher 가 users 에 자신의 userId 가 포함됐는지로
  // `byMe` 를 로컬 계산한다(카운트/리스트는 WS 가 진실값).
  REACTION_UPDATED: 'reaction:updated',
  // 반응 일괄 삭제 (S40 · FR-RE09): OWNER/ADMIN 이 DELETE /messages/:id/reactions
  // 로 한 메시지의 모든 반응을 일괄 삭제하면 채널 룸 전체에 fanout 한다. payload 는
  // 라우팅·소비에 필요한 최소 식별자(messageId + channelId)만 싣는다 — 전체 제거라
  // 집계(count/users)가 필요 없고, 수신 클라는 해당 messageId 의 reactions 를 통째로
  // 비운다(full clear). 서버 내부 outbox eventType 은 dot 표기(message.reaction.cleared)
  // 지만 outbox→WS subscriber 가 이 콜론 wire 이름으로 변환해 emit 한다
  // (reaction:updated / thread:lock:changed 선례).
  REACTION_CLEARED: 'reaction:cleared',
  // 타이핑
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  TYPING_UPDATE: 'typing:update',
  TYPING_BATCH: 'typing:batch',
  // 프레즌스
  PRESENCE_SUBSCRIBE: 'presence:subscribe',
  // S26 (FR-P16): 구독 해제. presence:sub:{socketId} Set 에서 userIds 를 SREM.
  PRESENCE_UNSUBSCRIBE: 'presence:unsubscribe',
  PRESENCE_BULK: 'presence:bulk',
  PRESENCE_ACTIVITY: 'presence:activity',
  PRESENCE_SET: 'presence:set',
  PRESENCE_UPDATE: 'presence:update',
  // S25 (FR-RT-10): 워크스페이스 룸 브로드캐스트. online/dnd/idle userId 집합을
  // 싣는다. 게이트웨이 schedulePresenceBroadcast + 웹 dispatcher 가 이 상수로
  // emit/subscribe 한다.
  //
  // ⚠️ 이벤트명은 점 표기 `presence.updated` 를 유지한다 — 콜론 표기
  // (`presence:updated`) 로의 rename 은 WS-naming 수렴(S10) 묶음으로 이관된
  // carryover 다. 본 슬라이스는 타입화(스키마+상수)만 수행하고 와이어 이름은
  // 바꾸지 않는다(라이브 클라 회귀 방지).
  WORKSPACE_PRESENCE_UPDATED: 'presence.updated',
  // 읽음 / 미읽
  READ_STATE_UPDATED: 'read_state:updated',
  UNREAD_COUNT_INCREMENT: 'unread_count:increment',
  // DM / 그룹 DM (S16 · FR-DM-16): 새 DM·그룹 DM 개설 또는 멤버 추가 시 대상
  // 참여자의 user:{userId} 룸으로 push. 클라이언트는 DM 목록 캐시를 무효화한다.
  DM_CREATED: 'dm:created',
  // 그룹 DM 멤버십 변경 (S19 · FR-DM-07/08/09): 멤버 추가/강퇴/나가기·owner 승계 시
  // 대상 참여자의 user:{userId} 룸으로 push. 클라이언트는 멤버 목록/owner 캐시를
  // 무효화한다. dm:created 선례대로 내부 recipients 는 와이어에서 제거되고 최소
  // 필드(channelId + 변경 대상 userId 등)만 노출한다(참여자 UUID 전체 비노출).
  DM_PARTICIPANT_ADDED: 'dm:participant_added',
  DM_PARTICIPANT_REMOVED: 'dm:participant_removed',
  DM_OWNER_CHANGED: 'dm:owner_changed',
  // 그룹 DM 표시 메타 변경 (S20 · FR-DM-05/06): 이름(displayName) 또는 아이콘
  // (iconUrl) 변경 시 참여자의 user:{userId} 룸으로 push. 클라이언트는 DM 헤더/
  // 사이드바의 표시명·아이콘 캐시를 무효화한다. 내부 recipients 는 와이어에서
  // 제거되고 channelId + 변경 필드(displayName?/iconUrl?)만 노출한다(H-03 선례).
  DM_GROUP_UPDATED: 'dm:group_updated',
  // 차단 해제 (S17 · FR-DM-19): 차단 해제 시 차단 해제자(blocker)의 user:{userId}
  // 룸으로 push. 클라이언트는 해당 사용자가 작성한 메시지의 마스킹을 풀기 위해
  // 현재 채널 메시지 캐시를 무효화/재로드한다.
  USER_UNBLOCKED: 'user:unblocked',
  // 스레드 잠금/해제 (S38 · FR-TH-13): OWNER/ADMIN 이 스레드를 잠그거나 풀면
  // 채널 룸으로 push. 클라이언트(ThreadPanel)는 헤더 잠금 아이콘 + MEMBER 이하
  // composer disabled 상태를 실시간 갱신한다. payload: { channelId,
  // parentMessageId, locked }. 서버 내부 outbox eventType 은 dot 표기
  // (message.thread.lock_changed)지만 outbox→WS subscriber 가 이 콜론 wire 이름으로
  // 변환해 emit 한다(PRD FR-TH-13 이 이 이름을 직접 명시).
  THREAD_LOCK_CHANGED: 'thread:lock:changed',
  // 커스텀 이모지 라이프사이클 (S41 · FR-EM01/FR-EM04/FR-RC20): 워크스페이스
  // 커스텀 이모지가 업로드 확정(finalize)되거나 삭제되면 해당 워크스페이스 룸
  // (workspace:{wsId}) 전체로 push 한다. 클라이언트는 emoji:created 수신 시
  // `['custom-emojis', wsId]` 쿼리를 invalidate(새 이모지 반영), emoji:deleted
  // 수신 시 해당 emojiId 를 캐시에서 제거한다(피커/매니저 즉시 갱신). 서버 내부
  // outbox eventType 은 dot 표기(emoji.created / emoji.deleted)지만 outbox→WS
  // subscriber 가 이 콜론 wire 이름으로 변환해 emit 한다(reaction:updated 선례).
  EMOJI_CREATED: 'emoji:created',
  EMOJI_DELETED: 'emoji:deleted',
  // 커스텀 이모지 별칭 변경 (S42 · FR-EM05/FR-EM07): 별칭 추가/삭제 성공 시 해당
  // 워크스페이스 룸(workspace:{wsId}) 전체로 push 한다. 클라이언트는 emoji:alias_updated
  // 수신 시 `['custom-emojis', wsId]` 쿼리를 invalidate 해 파서/자동완성의 별칭
  // 매핑을 다음 read 로 갱신한다. payload 는 { workspaceId, emojiId, aliases:string[] }
  // (변경 후 별칭 전체 스냅샷). 서버 내부 outbox eventType 은 dot 표기
  // (emoji.alias_updated)지만 outbox→WS subscriber 가 이 콜론 wire 이름으로 변환해
  // emit 한다(emoji:created / reaction:updated 선례).
  EMOJI_ALIAS_UPDATED: 'emoji:alias_updated',
  // 멘션 알림 (S44 · FR-MN-01): 메시지에서 본인이 @멘션(@username/@everyone/@here/
  // @channel)되면 수신자의 user:{userId} 룸으로 push 한다. PRD WS 이벤트 카탈로그가
  // 와이어 이름 `mention:new` 를 명시한다. 서버 내부 outbox eventType 은 dot 표기
  // (mention.received)지만 outbox→WS subscriber 가 이 콜론 wire 이름으로 변환해
  // emit 한다(reaction:updated / thread:lock:changed / emoji:* 선례). payload 는
  // { targetUserId, workspaceId, channelId, messageId, actorId, snippet, createdAt,
  // everyone, here }. 클라이언트는 멘션 인박스/토스트를 갱신한다.
  MENTION_NEW: 'mention:new',
  // 배지 재동기화 (S47 · FR-MN-20): 멘션 발생 등으로 서버 진실값 배지(서버단위
  // mentionCount/unreadCount)가 바뀌면 수신자의 user:{userId} 룸으로 push 한다.
  // payload 는 서버 진실값이라 클라이언트는 낙관적 카운트를 이 값으로 교체한다
  // (server last-write-wins). isMuted 채널/서버는 카운트에 산입하지 않는다(서버
  // 게이트 — FR-MN-14). serverTimestamp 로 ACK 우선순위를 판정한다(message:ack 의
  // unreadCount 갱신 시각 이전 badge_update 는 stale 로 무시 — FR-MN-20).
  NOTIFICATION_BADGE_UPDATE: 'notification:badge_update',
  // 채널 핀 추가/해제 (S50 · D10 · FR-PS-02/06): 메시지가 채널 핀에 추가/제거되면
  // 채널 룸(channel:{channelId}) 전체로 push 한다. 서버 내부 outbox eventType 은 dot
  // 표기(message.pin.toggled)지만 outbox→WS subscriber 가 pinnedAt 의 null 여부로
  // channel:pin_added / channel:pin_removed 콜론 wire 이름으로 분기·변환해 emit 한다
  // (reaction:updated / thread:lock:changed / mention:new 선례). pin_added 는 핀
  // 메타 + 자동 삽입된 SYSTEM_PIN 시스템 메시지 id 를, pin_removed 는 해제된
  // messageId 를 싣는다. 클라이언트(PinPanel·채널 헤더 핀 카운트 배지)는 이 이벤트로
  // 목록/카운트를 낙관 갱신한다.
  CHANNEL_PIN_ADDED: 'channel:pin_added',
  CHANNEL_PIN_REMOVED: 'channel:pin_removed',
  // 저장 리마인더 발화 (S53 · D10 · FR-PS-09/10): 저장 항목에 예약한 리마인더
  // 시각이 도래하면 BullMQ in-process worker(ReminderProcessor)가 수신자의
  // user:{userId} 룸으로 push 한다. 채널 룸/outbox 경유가 아니라 게이트웨이가
  // 직접 emit 하는 개인 전용 이벤트다(read_state:updated 선례). 클라이언트는
  // 토스트(다시 알림/완료/무시) + 권한 있으면 브라우저 Notification 을 띄운다.
  // DND 게이트는 적용하지 않는다 — 사용자가 직접 설정한 예약이므로 Slack 처럼
  // 항상 발화한다(서버 처리부에서 bypass).
  REMINDER_FIRE: 'user:reminder_fire',
  // /remind 리마인더 발화 (S80 · D15 · FR-SC-06): 슬래시 `/remind` 가 만든 신규
  // Reminder 모델의 scheduledAt 이 도래하면 BullMQ worker(ReminderProcessor 의 reminder:
  // 접두 잡)가 수신자의 user:{userId} 룸으로 push 한다. S53 의 user:reminder_fire(저장
  // 메시지 리마인더, savedMessageId 키)와는 **별개** 이벤트다 — 발화원(Reminder vs
  // SavedMessage)·페이로드(reminderId + 자유 message + 채널링크)가 다르므로 와이어
  // 이름도 분리한다. 클라이언트는 우하단 토스트(8초)를 띄우고 channelId 가 있으면
  // 채널 내비게이션 링크를 노출한다(DND bypass — 사용자가 직접 건 예약).
  REMINDER_NEW_FIRE: 'reminder:fire',
  // 저장 항목 갱신 (S53 · D10 · FR-PS-09/10/11): 리마인더 설정/취소/스누즈/발화
  // 등으로 저장 항목 메타가 바뀌면 수신자의 user:{userId} 룸으로 push 한다(다른
  // 기기/탭 동기화). 클라이언트는 저장 목록 캐시를 무효화한다. payload 는 최소
  // 식별자(savedMessageId) + 변경 후 status·reminderAt 스냅샷이다.
  SAVED_UPDATED: 'user:saved_updated',
  // 첨부 후처리 완료 (S58 · D11 · FR-AM-25): 첨부의 후처리(썸네일 생성/검역 등)가
  // 끝나 표시 상태가 확정되면 채널 룸(channel:{channelId})으로 push 한다. 현재 백엔드는
  // Sharp/ffmpeg 서버 리사이즈를 영구 보류했고 complete 시 즉시 READY 로 승격하므로 이
  // 이벤트를 *emit 하지 않는다*. 그러나 PRD FR-AM-25 가 PENDING/PROCESSING → 확정 전환
  // 계약을 명시하므로, 프런트엔드는 forward-compat(no-op-ready)로 핸들러만 미리 둔다.
  // 수신 시 캐시에 해당 attachmentId 가 있으면 processingStatus/thumbnailKey 를 patch 하고
  // 없으면 무시한다(서버가 나중에 emit 을 켜도 무회귀).
  ATTACHMENT_PROCESSING_DONE: 'attachment:processing_done',
  // 링크 unfurl 결과 갱신 (S60 · D11 · FR-RC07/08 · FR-AM-13~16): 메시지 본문 URL 의
  // 비동기 OG/Twitter-Card 메타 fetch 가 끝나면(또는 사후 suppress 되면) 채널 룸
  // (channel:{channelId})으로 push 한다. UnfurlProcessor(BullMQ)가 메시지 발화 트랜잭션과
  // 분리해 fire-and-forget 으로 채우므로 메시지 created 직후에는 embeds 가 비어 있다가
  // 잠시 뒤 이 이벤트로 채워진다. 서버 내부 outbox eventType 은 dot 표기
  // (message.embed.updated)라 `message.**` 와일드카드가 잡고, outbox→WS subscriber 가 이
  // 콜론 wire 이름으로 변환해 보낸다(reaction:updated / thread:lock:changed 선례). 페이로드는
  // 해당 메시지의 비-suppress embed 전체 스냅샷(idempotent replace)이다 — 클라이언트는
  // messages.list 캐시의 해당 messageId 행 embeds 를 통째로 교체한다.
  MESSAGE_EMBED_UPDATED: 'message:embed_updated',
  // 멤버 강제 퇴장 / 영구 차단 (S63 · D12 · FR-RM05/06): OWNER/ADMIN/MODERATOR 가
  // 멤버를 kick(재가입 가능) 또는 ban(영구 차단)하면 해당 워크스페이스 룸
  // (workspace:{wsId}) 전체로 push 한다. 서버 내부 outbox eventType 은 dot 표기
  // (workspace.member.kicked / workspace.member.banned)지만 outbox→WS subscriber 가 이
  // 콜론 wire 이름으로 변환해 워크스페이스 룸에 emit 한다(message:embed_updated 선례).
  // 다른 멤버는 이 이벤트로 멤버 목록 캐시를 무효화해 떠난 멤버를 즉시 제거하고,
  // 대상 본인이면(payload.userId === viewer) 안내 토스트 + 멤버십 상실로 인한 리다이렉트가
  // 라우터에서 처리된다(본인 소켓 disconnect 는 별도로 kickUserEverywhere 가 수행). ban 은
  // 권한자 차단 목록 캐시도 함께 무효화한다.
  MEMBER_KICKED: 'member:kicked',
  MEMBER_BANNED: 'member:banned',
  // S64 (D12 · FR-RM09): bulk purge. MANAGE_MESSAGES 권한자가 채널 메시지를 일괄
  // soft-delete 하면 개별 message:deleted 가 아니라 이 단일 이벤트로 messageIds[] 를
  // 채널 룸(channel:{channelId})에 push 한다. 서버 내부 outbox eventType 은 dot 표기
  // (message.bulk_deleted)라 `message.**` 와일드카드가 잡고, outbox→WS subscriber 가 이
  // 콜론 wire 이름으로 변환한다. 클라 dispatcher 는 messageIds 전체를 타임라인 캐시에서
  // 한 번에 제거한다(개별 deleted 루프 대비 fanout 1건).
  MESSAGE_BULK_DELETED: 'message:bulk_deleted',
  // S70 (D13 · FR-W06): 가입 신청 접수. APPLY 워크스페이스에 신청이 제출되면 그
  // 워크스페이스 룸(workspace:{wsId})으로 push 한다. ADMIN 리뷰 패널이 목록을 즉시
  // 갱신한다. 서버 내부 outbox eventType 은 dot 표기(application.received)지만 outbox→WS
  // subscriber 가 이 콜론 wire 이름으로 변환한다(member:kicked / message:embed_updated 선례).
  APPLICATION_RECEIVED: 'ws:application_received',
  // S70 (D13 · FR-W06a): 가입 신청 처리 결과. 신청자 본인 user 룸(user:{applicantId})으로
  // push 한다. approved → 토스트 + 2초 후 워크스페이스 자동 이동, rejected → 거절 카피 +
  // reviewNote + '다시 신청하기'(24h cooldown) + '다른 커뮤니티 찾기', interview → 인터뷰
  // 안내. 서버 내부 outbox eventType 은 dot 표기(application.reviewed)다.
  APPLICATION_REVIEWED: 'ws:application_reviewed',
  // S70 (D13 · FR-W12): 멤버 이탈(임시 멤버 자동 강퇴 포함). reason='temp_expired' 는
  // 임시 링크 가입 멤버가 마지막 소켓 disconnect 2초 debounce 후 강퇴된 경우다(leave/kick
  // 은 다른 경로). 워크스페이스 룸(workspace:{wsId})으로 push 해 다른 멤버의 멤버 목록
  // 캐시를 무효화한다.
  MEMBER_LEFT: 'ws:member_left',
  // S72 (D13 · FR-W15): 워크스페이스 소프트 삭제/복원 라이프사이클. OWNER 가 워크스페이스를
  // 삭제(soft-delete)하면 모든 멤버에게 ws:workspace_deleted 를, grace 내 복원하면
  // ws:workspace_restored 를 워크스페이스 룸(workspace:{wsId})으로 push 한다. 서버 내부
  // outbox eventType 은 dot 표기(workspace.deleted / workspace.restored)지만 outbox→WS
  // subscriber 가 이 콜론 wire 이름으로 변환해 워크스페이스 룸에 추가 emit 한다(member:kicked
  // dot→colon 선례). 수신 클라는 deleted 시 내 워크스페이스 목록을 무효화해 사이드바에서
  // 제거하고, 현재 보고 있던 워크스페이스면 홈(/dm)으로 리다이렉트한다. restored 는 목록을
  // 다시 무효화해 사이드바에 복귀시킨다.
  WORKSPACE_DELETED: 'ws:workspace_deleted',
  WORKSPACE_RESTORED: 'ws:workspace_restored',
  // S74 (D14 · FR-PS-06): 워크스페이스별 프로필(닉네임/아바타) 변경. 해당 워크스페이스 룸
  // (workspace:{wsId})으로 push 한다. 전역 user.profile.updated 와 달리 한 워크스페이스
  // 스코프이며 payload 로 변경된 ws 표시값(wsNickname/wsAvatarUrl)을 함께 싣는다. 클라
  // dispatcher 는 해당 워크스페이스의 멤버목록/디렉터리/내-프로필 캐시를 무효화해 ws
  // 닉네임/아바타 오버라이드를 갱신한다. 와이어 이름은 점/언더스코어 표기
  // `workspace_profile.updated` 를 유지한다(WS-naming 수렴은 S10 carryover — 본 슬라이스는
  // 인라인 타입을 스키마+상수로 타입화만 한다).
  WORKSPACE_PROFILE_UPDATED: 'workspace_profile.updated',
} as const;

export type WsEventName = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];

const ChannelIdSchema = z.string().min(1);
const UserIdSchema = z.string().min(1);
const SeqSchema = z.number().int(); // -1 sentinel(SEQ_SENTINEL) 허용 → nonnegative 강제 안 함

/**
 * S25 (FR-P01): 프레즌스 상태 5종.
 *
 *   online    — 활성 연결 + 최근 활동(IDLE_TIMEOUT 이내)
 *   idle      — 활성 연결 + IDLE_TIMEOUT 동안 활동 없음(auto-idle)
 *   dnd       — 사용자 설정(presencePreference='dnd') 우선. activity/idle 무관 유지
 *   offline   — 활성 세션 없음(마지막 세션 끊김 후 grace 만료)
 *   invisible — 사용자가 스스로 숨김. 본인에게만 실제값, 타인에게는 offline 으로 마스킹
 *
 * 와이어 포맷은 소문자 enum 이다(서버 Prisma PresencePreference 와 별개 — preference 는
 * auto/dnd/invisible 만, runtime status 는 idle/online 까지 포함).
 */
export const PresenceStatusSchema = z.enum(['online', 'idle', 'dnd', 'offline', 'invisible']);
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;

/**
 * S25 (FR-P01): INVISIBLE 마스킹 단일 지점.
 *
 * 외부(타 사용자)에게 `invisible` 은 항상 `offline` 으로 보인다. 본인(isSelf=true)
 * 에게만 실제 `invisible` 값이 노출된다. 그 외 상태(online/idle/dnd/offline)는
 * 그대로 통과한다.
 *
 * presence:subscribe/bulk/update, GET /users/:id/profile, 멤버 목록 등 프레즌스를
 * 외부로 내보내는 **모든** 경로가 이 함수 하나만 거치도록 한다. 라이브러리 함수라
 * 서버(NestJS)·웹(React) 양쪽에서 동일하게 재사용된다.
 */
export function maskPresenceForViewer(status: PresenceStatus, isSelf: boolean): PresenceStatus {
  if (status === 'invisible' && !isSelf) return 'offline';
  return status;
}

// ── 연결 / 룸 ──────────────────────────────────────────────────────────────

/**
 * S69 (FR-W20): connection:ready 가 싣는 워크스페이스별 멘션 카운트 한 항목.
 * 가입한 **모든** 워크스페이스(활성/비활성 무관)의 멘션 합산을 담아, 비활성
 * 워크스페이스 서버아이콘 배지를 첫 페인트부터 그릴 수 있게 한다.
 */
export const WorkspaceMentionCountSchema = z.object({
  workspaceId: z.string().min(1),
  mentionCount: z.number().int().nonnegative(),
});
export type WorkspaceMentionCount = z.infer<typeof WorkspaceMentionCountSchema>;

export const ConnectionReadyPayloadSchema = z.object({
  userId: UserIdSchema,
  sessionId: z.string().min(1),
  /**
   * S69 (FR-W20): 가입한 모든 워크스페이스의 멘션 카운트. 비활성 워크스페이스도
   * 포함해 서버아이콘 멘션 배지를 즉시 복원한다. forward-compat 위해 optional —
   * 구 서버 페이로드는 누락이며 클라가 GET /me/unread-totals 폴백으로 채운다.
   */
  allWorkspaceMentionCounts: z.array(WorkspaceMentionCountSchema).optional(),
});
export type ConnectionReadyPayload = z.infer<typeof ConnectionReadyPayloadSchema>;

export const ChannelJoinPayloadSchema = z.object({ channelId: ChannelIdSchema });
export type ChannelJoinPayload = z.infer<typeof ChannelJoinPayloadSchema>;

export const ChannelJoinedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  /** join 시점 채널 seq 스냅샷(Redis seq:{channelId} 현재값). */
  seq: SeqSchema,
  // S10 fix-forward (MAJOR #2): connect 직후 채널별 seq baseline 을 클라에
  // 내려 SeqTracker.setBaseline 을 채우는 것이 이 이벤트의 1차 용도입니다.
  // lastMessageId / unreadCount / lastReadMessageId 는 read-state·around-reload
  // 보조용 *선언적* 필드인데, 현재 어떤 클라 dispatcher 도 이 이벤트에서
  // 소비하지 않습니다(unread 레일·readStateStore 는 별도 경로). 연결당 채널
  // 50개에 대한 per-channel unread 서브쿼리 부하를 피하기 위해, baseline-only
  // 경량 emit 이 이 셋을 생략할 수 있도록 optional 로 둡니다(additive·무회귀).
  // 후속 슬라이스에서 채워질 때까지 안전하게 누락 허용.
  /** Channel.lastMessageId — 서버 최신 메시지 id 참조값. */
  lastMessageId: z.string().nullable().optional(),
  unreadCount: z.number().int().nonnegative().optional(),
  lastReadMessageId: z.string().nullable().optional(),
});
export type ChannelJoinedPayload = z.infer<typeof ChannelJoinedPayloadSchema>;

export const ChannelLeavePayloadSchema = z.object({ channelId: ChannelIdSchema });
export type ChannelLeavePayload = z.infer<typeof ChannelLeavePayloadSchema>;

export const ChannelSyncedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  fetchedCount: z.number().int().nonnegative(),
  oldestFetchedId: z.string().nullable(),
  /** GAP_FETCH_MAX_PAGES / PENDING_EVENTS_MAX 초과로 일부 누락 시 true. */
  truncated: z.boolean().optional(),
});
export type ChannelSyncedPayload = z.infer<typeof ChannelSyncedPayloadSchema>;

export const ChannelErrorPayloadSchema = z.object({
  code: z.enum(['PERMISSION_DENIED', 'JOIN_LIMIT_EXCEEDED']),
  channelId: ChannelIdSchema,
});
export type ChannelErrorPayload = z.infer<typeof ChannelErrorPayloadSchema>;

// ── 메시지 ──────────────────────────────────────────────────────────────────
/**
 * message:created — authorId 필드를 사용하며 senderId 는 사용하지 않습니다
 * (D17 회귀 spec).
 */
export const MessageCreatedPayloadSchema = z.object({
  seq: SeqSchema,
  message: z.object({
    id: z.string().min(1),
    channelId: ChannelIdSchema,
    authorId: z.string().nullable(),
    authorName: z.string(),
    authorAvatarUrl: z.string().nullable(),
    content: z.string().nullable(),
    createdAt: z.string().datetime(),
    editedAt: z.string().datetime().nullable(),
    // S84a (FR-RC11): 봇 메시지 분류 + 표시 override(additive optional). 인커밍
    // 웹훅 게시 메시지는 authorType='BOT' + botUsername/botAvatarUrl 을 싣는다.
    authorType: z.enum(['USER', 'BOT', 'SYSTEM']).optional(),
    botUsername: z.string().nullable().optional(),
    botAvatarUrl: z.string().nullable().optional(),
  }),
});
export type MessageCreatedPayload = z.infer<typeof MessageCreatedPayloadSchema>;

/**
 * message:updated — D01/ADR-12 정합 (forward-looking S00 계약).
 * contentRaw/contentPlain/contentAst/version/editedAt/mentions 를 포함합니다.
 *
 * ⚠️ S02 NOTE (HIGH-S02-1): 이 평탄(flat) 스키마는 아직 라이브 와이어
 * 포맷이 아닙니다. 현재 런타임은 outbox→ws 경로로 `message.updated`
 * (점 표기) 이벤트를 중첩(`{ message: { id, content, contentRaw,
 * contentAst, mentions, editedAt } }`) 페이로드로 내보냅니다 — 내부
 * 타입은 apps/api `messages/events/message-events.ts` 의
 * MessageUpdatedPayload 입니다. 본 스키마(`message:updated`, 콜론 표기)는
 * WS_EVENT_PAYLOAD_SCHEMAS 의 선언적 목표 계약일 뿐 게이트웨이/클라이언트
 * 런타임 검증에 연결돼 있지 않습니다(events.spec 단독 참조). S02 에서는
 * 중첩 페이로드에 contentRaw/contentAst 를 추가해 라이브 렌더가 AST 경로를
 * 타도록 했고(렌더 회귀 해소), 평탄 스키마로의 통일(messageId/version
 * 평탄화)은 후속 슬라이스로 이관합니다. follow-up(task): 두 계약 합치기.
 */
export const MessageUpdatedPayloadSchema = z.object({
  seq: SeqSchema,
  messageId: z.string().min(1),
  channelId: ChannelIdSchema,
  contentRaw: z.string(),
  contentPlain: z.string(),
  // contentAst 는 파싱된 rich_text AST. 구조는 mrkdwn AST 노드(D16)이지만
  // 게이트웨이 페이로드 검증에서는 존재 여부만 강제하고 형태는 서버 파서가
  // 보장합니다. z.unknown() 은 키 누락을 허용하므로 명시적 required 처리.
  contentAst: z.custom<unknown>((v) => v !== undefined, { message: 'contentAst is required' }),
  version: z.number().int().nonnegative(),
  editedAt: z.string().datetime().nullable(),
  mentions: MessageMentionsSchema,
});
export type MessageUpdatedPayload = z.infer<typeof MessageUpdatedPayloadSchema>;

export const MessageDeletedPayloadSchema = z.object({
  seq: SeqSchema,
  messageId: z.string().min(1),
  channelId: ChannelIdSchema,
  deletedAt: z.string().datetime(),
});
export type MessageDeletedPayload = z.infer<typeof MessageDeletedPayloadSchema>;

// ── 반응 (S39 · FR-RE03/RE04) ────────────────────────────────────────────────
/**
 * 반응 집계의 reactor 한 명. `username` 은 아바타 스택 라벨용으로 옵셔널(서버가
 * batch 로 채우되, 미해결 시 id 만). REACTION_UPDATED fanout 과 GET reactions
 * 응답이 공유한다. PII 최소화를 위해 id + username 만 노출한다(email 등 제외).
 */
export const ReactionUserSchema = z.object({
  id: UserIdSchema,
  username: z.string().nullable().optional(),
});
export type ReactionUser = z.infer<typeof ReactionUserSchema>;

/**
 * S39 (FR-RE03): reaction:updated 의 이모지별 집계 항목(**broadcast** 형태).
 * `users` 는 reactor 전부가 아니라 **최초 5명까지의 부분집합**이다(아바타 스택 +
 * "+N" overflow 용 — count 가 진짜 총원이다). per-viewer `me`/`byMe` 는 수신자마다
 * 달라 브로드캐스트 payload 에 담을 수 없으므로 제외하며, 클라가 users 에 자신의
 * userId 가 포함됐는지로 byMe 를 **로컬 계산**한다(cap 밖이면 reaction-intent 의
 * 뷰어 의도로 보정 — dispatcher 참조). per-viewer REST 형태는 message.ts 의
 * ReactionSummary(byMe 직접 포함) 이며 본 스키마와 별개 계약이다(SHOULD 3 구분).
 */
export const ReactionUpdatedReactionSchema = z.object({
  emoji: z.string().min(1).max(64),
  count: z.number().int().nonnegative(),
  users: z.array(ReactionUserSchema).max(5),
  // S41 (FR-EM06 / FR-RC20): 커스텀 이모지 반응이면 broadcast 집계에도 참조
  // CustomEmoji.id + presigned url 을 동봉해, 수신 클라가 reaction:updated full
  // replace 후 곧바로 <img> 칩을 렌더할 수 있게 한다. 유니코드 반응은 둘 다
  // 생략, **삭제된** 커스텀 이모지 반응은 customEmojiId=null(emoji 슬러그만) —
  // 클라 placeholder 분기. optional/nullable → S39/S40 와이어와 forward-compat.
  customEmojiId: z.string().uuid().nullable().optional(),
  url: z.string().nullable().optional(),
});
export type ReactionUpdatedReaction = z.infer<typeof ReactionUpdatedReactionSchema>;

/**
 * S39 (FR-RE03): reaction:updated — 반응 추가/제거 성공 시 채널 룸 전체에 fanout.
 * payload 는 messageId + 전체 반응 집계(full snapshot). 수신 클라는 해당 messageId
 * 의 반응을 이 payload 로 **full replace** 한다(증분 ±1 아님 — 재연결 replay /
 * out-of-order 에도 수렴). 서버 outbox→WS subscriber 가 message.reaction.updated
 * dot 이벤트를 수신해 aggregateReactions 재조회 + users[5] enrichment 후 이
 * wire payload 로 변환해 emit 한다.
 *
 * S39 fix-forward (SHOULD 3 — dispatcher safeParse 가드 정합): `seq` 는 **옵셔널**이다.
 * 실제 라이브 와이어(outbox-to-ws.subscriber 의 enriched payload: id/type/occurredAt/
 * channelId/messageId/reactions)는 seq 를 싣지 않는다 — 반응은 full-replace 라
 * 순서 정합에 seq 가 필요 없기 때문이다(message:* 의 seq 게이팅과 다름). seq 를
 * required 로 두면 dispatcher 가 추가한 safeParse 가드가 모든 라이브 이벤트를 거부해
 * 반응이 통째로 깨진다. 와이어 현실에 맞춰 옵셔널로 정렬하되, 후속 슬라이스가 seq
 * 를 싣게 되면 그대로 통과한다(forward-compat).
 */
export const ReactionUpdatedPayloadSchema = z.object({
  seq: SeqSchema.optional(),
  messageId: z.string().min(1),
  channelId: ChannelIdSchema,
  reactions: z.array(ReactionUpdatedReactionSchema),
});
export type ReactionUpdatedPayload = z.infer<typeof ReactionUpdatedPayloadSchema>;

/**
 * S40 (FR-RE09): reaction:cleared — OWNER/ADMIN 의 메시지 전체 반응 일괄 삭제 시
 * 채널 룸 전체에 fanout. payload 는 식별자(messageId + channelId)만 싣는다 —
 * 전체 제거라 집계(count/users)가 없고, 수신 클라는 해당 messageId 의 reactions 를
 * 통째로 비운다(full clear). reaction:updated 와 달리 seq 는 싣지 않는다(full clear
 * 라 순서 정합 불필요). 서버 outbox→WS subscriber 가 message.reaction.cleared dot
 * 이벤트를 이 wire payload 로 변환해 emit 한다.
 */
export const ReactionClearedPayloadSchema = z.object({
  messageId: z.string().min(1),
  channelId: ChannelIdSchema,
});
export type ReactionClearedPayload = z.infer<typeof ReactionClearedPayloadSchema>;

// ── 커스텀 이모지 (S41 · FR-EM01/FR-EM04/FR-RC20) ───────────────────────────
/**
 * emoji:created — 워크스페이스 커스텀 이모지 업로드 확정 시 workspace 룸 전체로
 * fanout. payload 는 워크스페이스 룸 라우팅 식별자(workspaceId) + 클라가 캐시
 * 무효화/표시에 쓰는 최소 메타(emojiId, name). 클라이언트는 보수적으로
 * `['custom-emojis', workspaceId]` 를 invalidate 후 재조회한다(presigned url 의
 * 서명/만료 정합을 서버 list 응답에 위임 — url 은 와이어에 싣지 않는다).
 */
export const EmojiCreatedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  emojiId: z.string().min(1),
  name: z.string().min(1),
});
export type EmojiCreatedPayload = z.infer<typeof EmojiCreatedPayloadSchema>;

/**
 * emoji:deleted — 워크스페이스 커스텀 이모지 삭제 시 workspace 룸 전체로 fanout.
 * 수신 클라는 `['custom-emojis', workspaceId]` 캐시에서 emojiId 를 제거한다.
 * 진행 중 메시지 반응의 [삭제된 이모지] placeholder 전환은 다음 authoritative
 * read 가 self-heal 한다(FR-EM06).
 */
export const EmojiDeletedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  emojiId: z.string().min(1),
  name: z.string().min(1),
});
export type EmojiDeletedPayload = z.infer<typeof EmojiDeletedPayloadSchema>;

/**
 * emoji:alias_updated — 커스텀 이모지 별칭 추가/삭제 시 workspace 룸 전체로 fanout
 * (S42 · FR-EM05/FR-EM07). `aliases` 는 변경 후 그 이모지의 전체 별칭 스냅샷이다
 * (증분 아님 — full replace). 수신 클라는 `['custom-emojis', workspaceId]` 를
 * invalidate 해 파서(:alias:→img)/자동완성의 별칭 매핑을 다음 read 로 갱신한다.
 */
export const EmojiAliasUpdatedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  emojiId: z.string().min(1),
  aliases: z.array(z.string().min(1)),
});
export type EmojiAliasUpdatedPayload = z.infer<typeof EmojiAliasUpdatedPayloadSchema>;

// ── 멘션 알림 (S44 · FR-MN-01) ──────────────────────────────────────────────
/**
 * mention:new — 수신자가 메시지에서 @멘션될 때 user:{userId} 룸으로 push.
 * 서버 내부 outbox eventType 은 dot 표기(mention.received)지만 outbox→WS
 * subscriber 가 이 콜론 wire 이름으로 변환해 emit 한다. payload 는 서버
 * MentionReceivedPayload 와 1:1 정합한다(workspaceId 는 Global DM 케이스를 위해
 * nullable — 현재는 항상 워크스페이스 멘션이라 string 이지만 타입 경계를 맞춘다).
 */
export const MentionNewPayloadSchema = z.object({
  targetUserId: UserIdSchema,
  workspaceId: z.string().min(1).nullable(),
  channelId: ChannelIdSchema,
  messageId: z.string().min(1),
  actorId: z.string().min(1),
  snippet: z.string(),
  createdAt: z.string(),
  everyone: z.boolean(),
  here: z.boolean(),
});
export type MentionNewPayload = z.infer<typeof MentionNewPayloadSchema>;

// ── 배지 재동기화 (S47 · FR-MN-20) ──────────────────────────────────────────
/**
 * notification:badge_update — 서버 진실값 배지를 수신자의 user:{userId} 룸으로
 * push (S47 · FR-MN-20). 멘션 발생 시 outbox→WS subscriber 가 mention:new 와 함께
 * 같은 룸으로 emit 한다. payload 는 서버 진실값(isMuted 게이트 후 집계)이라 클라는
 * 낙관적 +1 을 이 값으로 **교체**한다(server last-write-wins).
 *
 *   serverId        — 워크스페이스 id(서버 단위 배지 키).
 *   channelId       — 발생 채널 id. 서버 단위 교체라 채널별 patch 가 필수는 아니지만
 *                     디버깅/세분화 여지를 위해 싣는다(nullable — 서버 단위 재집계).
 *   mentionCount    — 서버 단위 미읽 멘션 수(isMuted 채널/서버 제외).
 *   unreadCount     — 서버 단위 미읽 메시지 수(isMuted 채널/서버 제외).
 *   serverTimestamp — 서버가 이 배지를 계산한 시각(ISO). ACK 우선순위 판정용 —
 *                     클라가 보유한 lastAckedAt 보다 이르면 stale 로 무시한다.
 */
export const NotificationBadgeUpdatePayloadSchema = z.object({
  serverId: z.string().min(1),
  channelId: ChannelIdSchema.nullable(),
  mentionCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  serverTimestamp: z.string().datetime(),
});
export type NotificationBadgeUpdatePayload = z.infer<typeof NotificationBadgeUpdatePayloadSchema>;

// ── 채널 핀 (S50 · D10 · FR-PS-02/06) ───────────────────────────────────────
/**
 * channel:pin_added — 메시지가 채널 핀에 추가되면 채널 룸(channel:{channelId})
 * 전체로 fanout (S50 · FR-PS-02). 서버 내부 outbox eventType 은 dot 표기
 * (message.pin.toggled, pinnedAt 비-null)지만 outbox→WS subscriber 가 이 콜론 wire
 * 이름으로 변환해 emit 한다. payload 는 라우팅 식별자(channelId) + 핀 메타(messageId,
 * pinnedAt, pinnedBy) + 핀 추가로 자동 삽입된 SYSTEM_PIN 시스템 메시지 id 를 싣는다.
 * 클라이언트는 핀 패널 목록 + 채널 헤더 핀 카운트 배지를 낙관 갱신한다(used>=soft cap
 * 도달 시 경고 toast — FR-PS-04). `used` 는 갱신 후 현재 채널 핀 수(soft cap 경고
 * 판정에 사용).
 */
export const ChannelPinAddedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  messageId: z.string().min(1),
  pinnedAt: z.string().datetime(),
  pinnedBy: z.string().min(1),
  // 핀 추가 시 채널 스트림에 자동 삽입된 SYSTEM_PIN 시스템 메시지 id. 시스템
  // 메시지 삽입을 생략한 경로(없음 — 항상 삽입)는 null 폴백.
  systemMessageId: z.string().min(1).nullable(),
  // 갱신 후 채널 핀 수(soft cap 경고 toast 판정용). forward-compat 위해 optional.
  used: z.number().int().nonnegative().optional(),
});
export type ChannelPinAddedPayload = z.infer<typeof ChannelPinAddedPayloadSchema>;

/**
 * channel:pin_removed — 메시지가 채널 핀에서 제거되면 채널 룸 전체로 fanout
 * (S50 · FR-PS-06). unpin 또는 핀된 메시지 소프트 삭제 cascade 둘 다 이 이벤트를
 * 발행한다(서버 outbox eventType 은 message.pin.toggled, pinnedAt=null). payload 는
 * channelId + 해제된 messageId + 해제 주체(unpinnedById) + 해제 시각(unpinnedAt).
 * 클라이언트는 핀 패널에서 해당 항목을 제거하고 핀 카운트 배지를 −1 한다.
 */
export const ChannelPinRemovedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  messageId: z.string().min(1),
  unpinnedById: z.string().min(1).nullable(),
  unpinnedAt: z.string().datetime(),
});
export type ChannelPinRemovedPayload = z.infer<typeof ChannelPinRemovedPayloadSchema>;

// ── 저장 리마인더 (S53 · D10 · FR-PS-09/10/11) ──────────────────────────────
/**
 * user:reminder_fire — 저장 항목 리마인더 시각 도래 시 수신자의 user:{userId}
 * 룸으로 emit (S53 · FR-PS-09/10). BullMQ in-process worker(ReminderProcessor)가
 * 직접 emit 하는 개인 전용 이벤트다. payload 는 토스트/브라우저 Notification 렌더에
 * 필요한 최소 컨텍스트 — 저장 항목 id, 원본 메시지/채널 id + 채널명 + 발췌(≤150자) +
 * 최초 저장 시각. 발췌는 원본이 살아 있을 때만 채워지며, 삭제된 원본은 마스킹된
 * placeholder 가 내려온다(서버 측 동일 정책).
 */
export const ReminderFirePayloadSchema = z.object({
  savedMessageId: z.string().uuid(),
  messageId: z.string().uuid(),
  // S53 리뷰(reviewer n1 · security FINDING-4): 원본 채널이 soft-delete 되면 null.
  // 종전엔 messageId 로 위장(uuid 통과)해 클라가 잘못된 채널로 내비게이션할 수 있었다.
  channelId: z.string().uuid().nullable(),
  channelName: z.string(),
  messagePreview: z.string(),
  originalSavedAt: z.string().datetime(),
});
export type ReminderFirePayload = z.infer<typeof ReminderFirePayloadSchema>;

/**
 * reminder:fire — /remind Reminder(S80 · FR-SC-06) 발화 payload. S53 의
 * user:reminder_fire(저장 메시지 리마인더)와는 별개 와이어 이벤트다. 페이로드는
 * 토스트 렌더에 필요한 최소 컨텍스트 — reminderId + 자유 message 텍스트 + 채널 링크.
 * channelId 가 null 이면 클라가 채널 내비게이션을 숨긴다(예약 채널 soft-delete 시 SetNull).
 */
export const ReminderNewFirePayloadSchema = z.object({
  reminderId: z.string().uuid(),
  message: z.string(),
  channelId: z.string().uuid().nullable(),
});
export type ReminderNewFirePayload = z.infer<typeof ReminderNewFirePayloadSchema>;

/**
 * user:saved_updated — 저장 항목 메타(status / reminderAt) 변경 시 수신자의
 * user:{userId} 룸으로 emit (S53 · FR-PS-09/10/11). 리마인더 설정/취소/스누즈/발화
 * 및 PATCH status 이동에서 발행해 다른 기기/탭의 저장 목록 캐시를 무효화한다.
 * payload 는 최소 식별자 + 변경 후 스냅샷(status·reminderAt nullable)이다.
 */
export const SavedUpdatedPayloadSchema = z.object({
  savedMessageId: z.string().uuid(),
  status: z.enum(['IN_PROGRESS', 'ARCHIVED', 'COMPLETED']),
  reminderAt: z.string().datetime().nullable(),
});
export type SavedUpdatedPayload = z.infer<typeof SavedUpdatedPayloadSchema>;

// ── 타이핑 ──────────────────────────────────────────────────────────────────
export const TypingStartPayloadSchema = z.object({ channelId: ChannelIdSchema });
export type TypingStartPayload = z.infer<typeof TypingStartPayloadSchema>;

export const TypingStopPayloadSchema = z.object({ channelId: ChannelIdSchema });
export type TypingStopPayload = z.infer<typeof TypingStopPayloadSchema>;

/**
 * typing:update — 단건 snapshot(full-replace, not merge). 채널의 현재 유효
 * typer 집합을 `typingUserIds` 로 싣습니다. 0명이면 `typingUserIds:[]` 로
 * 인디케이터를 clear 합니다.
 *
 * S32 fix-forward(contract CRITICAL · 4팀 합의): 종전 선언 스키마는
 * `{channelId, userId, displayName, action}` 로 라이브 와이어(게이트웨이 emit /
 * dispatcher consume)와 어긋난 *체크인된 거짓 계약*이었습니다. 실제 와이어가
 * 쓰는 `{channelId, typingUserIds:[]}` 로 정렬하고, 필드명을 `typingUserIds` 로
 * 통일합니다(현 prod 의 점 표기 `typing.updated` alias 도 이미 `typingUserIds` 를
 * 쓰므로 alias consumer 와 충돌이 없습니다). 와이어 비대화/멤버 열거를 막는
 * TYPING_MAX_VISIBLE 상한을 스키마에 명시합니다.
 */
export const TypingUpdatePayloadSchema = z.object({
  channelId: ChannelIdSchema,
  typingUserIds: z.array(UserIdSchema).max(TYPING_MAX_VISIBLE),
});
export type TypingUpdatePayload = z.infer<typeof TypingUpdatePayloadSchema>;

/**
 * typing:batch — full snapshot(replace, not merge); 0명이면 `typingUserIds:[]`
 * 로 clear. typing:update 와 동일하게 `typingUserIds` 필드명으로 통일하고
 * (S32 fix-forward · 4팀 합의), TYPING_MAX_VISIBLE 상한을 명시합니다.
 */
export const TypingBatchPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  typingUserIds: z.array(UserIdSchema).max(TYPING_MAX_VISIBLE),
});
export type TypingBatchPayload = z.infer<typeof TypingBatchPayloadSchema>;

// ── 프레즌스 ────────────────────────────────────────────────────────────────
/**
 * presence:subscribe — C→S. 구독할 userId 목록.
 *
 * S25 fix-forward(security HIGH · DoS): userIds 크기 상한 500. 한 워크스페이스
 * 멤버 목록을 한 번에 구독하는 정상 사용을 넉넉히 덮으면서, 임의 거대 배열로
 * 게이트웨이가 사용자당 Redis read 를 폭주시키는 것을 막는다. 게이트웨이는
 * safeParse 를 **실제로** 적용해 초과/비정상 페이로드를 거부한다(타입힌트만으로는
 * 런타임 보증이 없었음).
 */
export const PresenceSubscribePayloadSchema = z.object({
  userIds: z.array(UserIdSchema).max(500),
});
export type PresenceSubscribePayload = z.infer<typeof PresenceSubscribePayloadSchema>;

/**
 * S26 (FR-P16): presence:unsubscribe — 구독 Set 에서 빼고 싶은 userId 집합.
 * subscribe 와 동일한 500 상한을 둔다(거대 배열로 게이트웨이 SREM 폭주 방지).
 */
export const PresenceUnsubscribePayloadSchema = z.object({
  userIds: z.array(UserIdSchema).max(500),
});
export type PresenceUnsubscribePayload = z.infer<typeof PresenceUnsubscribePayloadSchema>;

export const PresenceEntrySchema = z.object({
  userId: UserIdSchema,
  status: PresenceStatusSchema,
  updatedAt: z.string().datetime(),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export const PresenceBulkPayloadSchema = z.object({
  presences: z.array(PresenceEntrySchema),
});
export type PresenceBulkPayload = z.infer<typeof PresenceBulkPayloadSchema>;

export const PresenceActivityPayloadSchema = z.object({
  channelId: ChannelIdSchema.optional(),
});
export type PresenceActivityPayload = z.infer<typeof PresenceActivityPayloadSchema>;

export const PresenceSetPayloadSchema = z.object({ status: PresenceStatusSchema });
export type PresenceSetPayload = z.infer<typeof PresenceSetPayloadSchema>;

/** presence:update — user:{userId} 룸으로만 emit. */
export const PresenceUpdatePayloadSchema = PresenceEntrySchema;
export type PresenceUpdatePayload = z.infer<typeof PresenceUpdatePayloadSchema>;

/**
 * presence.updated — 워크스페이스 룸(rooms.workspace(wsId))으로 emit (S25 ·
 * FR-RT-10). 한 워크스페이스의 현재 online/dnd/idle 사용자 집합을 싣는다.
 *
 *   onlineUserIds — 활성 세션을 가진(observable) 사용자 (idle 포함, INVISIBLE 제외)
 *   dndUserIds    — Do Not Disturb 닷 대상 (online 의 부분집합)
 *   idleUserIds   — auto-idle 닷 대상 (online 의 부분집합, dnd 와 배타)
 *
 * 종전 게이트웨이는 이 페이로드를 WS_EVENTS/Zod 미등록 raw 객체로 emit 했다.
 * S25 fix-forward(contract HIGH): 스키마+상수로 타입화한다. 와이어 이름은 점 표기
 * `presence.updated` 유지(콜론 rename 은 S10 carryover).
 */
export const WorkspacePresenceUpdatedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  onlineUserIds: z.array(UserIdSchema),
  dndUserIds: z.array(UserIdSchema),
  idleUserIds: z.array(UserIdSchema),
});
export type WorkspacePresenceUpdatedPayload = z.infer<typeof WorkspacePresenceUpdatedPayloadSchema>;

// ── 읽음 / 미읽 ──────────────────────────────────────────────────────────────
/**
 * S11 (FR-RT-13): POST /workspaces/:id/channels/:chid/ack 요청 바디.
 * lastReadMessageId 는 클라가 화면에서 마지막으로 본 메시지 id, clientTimestamp
 * 는 클라 시계(관측용 epoch ms). 5초 debounce 는 프론트(클라) 책임이며 S11
 * 백엔드 범위 밖이다 — 서버는 매 ack 를 monotonic upsert 로 처리한다(퇴행 무시).
 */
export const AckReadRequestSchema = z.object({
  lastReadMessageId: z.string().uuid(),
  clientTimestamp: z.number().int().nonnegative().optional(),
});
export type AckReadRequest = z.infer<typeof AckReadRequestSchema>;

/**
 * S24 (FR-RS-08): POST /workspaces/:id/channels/:chid/unread 요청 바디.
 * `messageId` 는 사용자가 "여기서부터 미읽" 으로 지정한 메시지 — 서버는 그
 * **직전** 메시지로 lastReadMessageId 를 되돌린다(직전이 없으면 null = 전체 미읽).
 * S21 monotonic guard 를 의도적으로 우회하는 후진 경로(markUnread)다.
 */
export const MarkUnreadRequestSchema = z.object({
  messageId: z.string().uuid(),
});
export type MarkUnreadRequest = z.infer<typeof MarkUnreadRequestSchema>;

/**
 * S36 (FR-RS-12 / FR-TH-12): POST /messages/:id/thread/ack 요청 바디.
 * `lastReadMessageId` 는 스레드 패널에서 마지막으로 본 답글 id. 서버는 채널
 * 미읽과 동일한 monotonic (createdAt, id) 튜플 upsert 로 ThreadReadState 를
 * 전진시킨다(퇴행 ack no-op). 채널 미읽과 독립적으로 스레드 미읽만 0 으로 수렴.
 */
export const ThreadAckRequestSchema = z.object({
  lastReadMessageId: z.string().uuid(),
});
export type ThreadAckRequest = z.infer<typeof ThreadAckRequestSchema>;

/**
 * S24 (FR-RS-18): POST /workspaces/:id/read-all/undo 요청 바디. read-all 응답이
 * 발급한 `snapshotId` 로 직전 ChannelReadState 를 복원한다(후진 허용 — markUnread
 * 와 동일한 비-monotonic 경로). Redis(TTL 5분) 히트 → Redis, miss → DB 복원.
 */
export const UndoMarkAllReadRequestSchema = z.object({
  snapshotId: z.string().uuid(),
});
export type UndoMarkAllReadRequest = z.infer<typeof UndoMarkAllReadRequestSchema>;

/**
 * read_state:updated — 호출자의 user:{userId} 룸으로만 emit (FR-RS-01 멀티세션
 * 동기화). ACK 한 채널의 새 unread/mention 카운트를 함께 실어 다른 기기/탭이
 * 사이드바 배지를 즉시 갱신할 수 있게 한다. `mentionCount` 는 S21 추가분 —
 * forward-compat 위해 default(0) (구 클라/구 서버 페이로드 호환).
 */
export const ReadStateUpdatedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  // S21 fix-forward (NIT-G): 채널이 속한 워크스페이스 id. dispatcher 가
  // unread-summary 쿼리 전체를 스캔하지 않고 `qk.channels.unreadSummary(workspaceId)`
  // 를 직접 patch 할 수 있게 한다. ackRead 가 채널 조회로 이미 보유한 값이라
  // 추가 round-trip 없음. forward-compat 위해 optional — 구 서버 페이로드는
  // workspaceId 누락이어도 dispatcher 가 전체 스캔으로 폴백한다.
  workspaceId: z.string().nullable().optional(),
  lastReadMessageId: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
  mentionCount: z.number().int().nonnegative().default(0),
  // S47 fix-forward (BLOCKER-2 · FR-MN-20): 서버가 이 ACK 를 emit 한 시각(ISO).
  // 클라 badgeStore 가 lastAckedAt 을 **서버 시계** 로 저장해, notification:badge_update
  // 의 serverTimestamp 와 동일 시계로 stale 비교한다(교차시계 폐기 버그 제거). emit
  // 시점에 gateway 가 부착하므로 UnreadService 의 payload 생성부는 건드리지 않는다.
  // forward-compat 위해 optional — 누락이면 클라가 ACK-우선 시각 갱신을 건너뛴다.
  serverTimestamp: z.string().datetime().optional(),
});
export type ReadStateUpdatedPayload = z.infer<typeof ReadStateUpdatedPayloadSchema>;

/**
 * unread_count:increment — user:{userId} 룸으로만 emit.
 *
 * S69 (FR-W23): **활성 워크스페이스 무관** 가입한 모든 워크스페이스에 대해 user 룸으로
 * emit 한다. 페이로드에 `workspaceId` 를 실어, 클라가 어느 워크스페이스의 서버아이콘
 * 배지를 낙관 갱신할지 결정할 수 있게 한다. forward-compat 위해 optional·nullable —
 * 구 서버 페이로드(workspaceId 누락)는 클라가 채널→워크스페이스 매핑 폴백으로 처리한다.
 */
export const UnreadCountIncrementPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  delta: z.number().int(),
  workspaceId: z.string().min(1).nullable().optional(),
});
export type UnreadCountIncrementPayload = z.infer<typeof UnreadCountIncrementPayloadSchema>;

/**
 * dm:created — 각 참여자의 user:{userId} 룸으로 emit (S16 · FR-DM-16).
 * `isGroup` 으로 1:1 / 그룹 DM 을 구분하고, `participantIds` 로 멤버 set 을 싣는다.
 *
 * S16 (HIGH fix-forward): 내부 라우팅용 `recipients` 필드는 **와이어 페이로드에서
 * 제거**한다. recipients 는 outbox payload 에만 남아 구독자가 어느 user 룸으로
 * fanout 할지 결정하는 서버 전용 정보이며, 클라이언트로 노출되면 참여자 UUID
 * 전체가 새므로 emit 직전에 제거한다(id/type/channelId/isGroup/participantIds 만).
 */
export const DmCreatedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  isGroup: z.boolean(),
  participantIds: z.array(UserIdSchema),
});
export type DmCreatedPayload = z.infer<typeof DmCreatedPayloadSchema>;

/**
 * dm:participant_added — 그룹 DM 멤버 추가 시 대상 채널의 기존+신규 참여자
 * user:{userId} 룸으로 emit (S19 · FR-DM-07). `addedUserIds` 는 이번에 추가된
 * 멤버 set. 내부 라우팅용 recipients 는 와이어에서 제거된다(H-03 선례). 클라이언트는
 * 멤버 목록 캐시를 무효화한다.
 */
export const DmParticipantAddedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  addedUserIds: z.array(UserIdSchema),
});
export type DmParticipantAddedPayload = z.infer<typeof DmParticipantAddedPayloadSchema>;

/**
 * dm:participant_removed — 그룹 DM 강퇴/나가기 시 대상 채널의 참여자
 * user:{userId} 룸으로 emit (S19 · FR-DM-08/09). `removedUserId` 는 제거된 멤버,
 * `reason` 은 강퇴('kicked') / 본인 나가기('left'). 내부 recipients 는 와이어에서
 * 제거된다(H-03). 클라이언트는 멤버 목록 캐시를 무효화하고, 본인이 removedUserId
 * 이면 해당 DM 을 목록에서 제거한다.
 */
export const DmParticipantRemovedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  removedUserId: UserIdSchema,
  reason: z.enum(['kicked', 'left']),
});
export type DmParticipantRemovedPayload = z.infer<typeof DmParticipantRemovedPayloadSchema>;

/**
 * dm:owner_changed — 그룹 DM owner 승계 시 참여자 user:{userId} 룸으로 emit
 * (S19 · FR-DM-09). owner 가 나갈 때 잔여 멤버 중 joinedAt 최古로 자동 승계되며
 * `ownerId` 는 새 owner userId. 내부 recipients 는 와이어에서 제거된다(H-03).
 */
export const DmOwnerChangedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  ownerId: UserIdSchema,
});
export type DmOwnerChangedPayload = z.infer<typeof DmOwnerChangedPayloadSchema>;

/**
 * dm:group_updated — 그룹 DM 표시 메타(이름/아이콘) 변경 시 참여자 user:{userId}
 * 룸으로 emit (S20 · FR-DM-05/06). `displayName` 은 새 표시명(빈 문자열로 초기화
 * 불가 — 변경 시에만 실린다), `iconUrl` 은 새 아이콘 키/URL(삭제 시 null). 둘 다
 * optional/nullable 이라 한 이벤트가 이름·아이콘 중 변경분만 싣는다. 내부 라우팅용
 * recipients 는 와이어에서 제거된다(H-03 선례). 클라이언트는 DM 헤더/사이드바
 * 표시명·아이콘 캐시를 무효화한다.
 */
export const DmGroupUpdatedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  displayName: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
});
export type DmGroupUpdatedPayload = z.infer<typeof DmGroupUpdatedPayloadSchema>;

/**
 * user:unblocked — 차단 해제자(blocker)의 user:{userId} 룸으로 emit
 * (S17 · FR-DM-19). `unblockedUserId` 는 차단이 풀린 상대 userId. 클라이언트는
 * 이 id 가 작성한 메시지의 마스킹(`[차단된 사용자의 메시지]`)을 풀기 위해 현재
 * 채널의 메시지 캐시를 무효화/재로드한다. 차단을 *건* 이벤트는 별도로 emit 하지
 * 않는다(차단 시점 마스킹은 다음 list 응답에서 자연히 반영되며, 즉시 마스킹이
 * 필요하면 클라이언트가 로컬에서 처리). 비노출 정책상 차단당한 쪽에는 보내지
 * 않는다 — blocker 본인 룸으로만 fanout 한다.
 */
export const UserUnblockedPayloadSchema = z.object({
  unblockedUserId: UserIdSchema,
});
export type UserUnblockedPayload = z.infer<typeof UserUnblockedPayloadSchema>;

/**
 * S38 (FR-TH-13): thread:lock:changed — 스레드 잠금/해제 시 채널 룸으로 emit.
 * 클라(ThreadPanel)는 헤더 잠금 아이콘 + MEMBER 이하 composer disabled 상태를
 * 실시간 갱신한다. 서버 내부 outbox eventType 은 dot 표기지만 outbox→WS
 * subscriber 가 이 콜론 wire 이름으로 변환해 보낸다. workspaceId 는 DM 미지원이라
 * 항상 채널 워크스페이스 id(non-null)지만, 다른 message 이벤트 envelope 형태와
 * 정합을 위해 nullable 로 둔다.
 */
export const ThreadLockChangedPayloadSchema = z.object({
  workspaceId: z.string().min(1).nullable(),
  channelId: ChannelIdSchema,
  // S38 fix-forward (contract HIGH): 서버 emit payload(MessageThreadLockChangedPayload)
  // 에 actorId(잠금/해제를 수행한 OWNER/ADMIN userId)가 실려 나가지만 wire 스키마에
  // 누락돼 있었다 — 정합을 위해 추가한다(런타임 검증 통과 + 클라 dispatcher 타입 정합).
  actorId: z.string().min(1),
  parentMessageId: z.string().min(1),
  locked: z.boolean(),
});
export type ThreadLockChangedPayload = z.infer<typeof ThreadLockChangedPayloadSchema>;

// ── 첨부 후처리 완료 (S58 · D11 · FR-AM-25) ──────────────────────────────────
/**
 * attachment:processing_done — 첨부 후처리가 끝나 표시 상태가 확정되면 채널 룸
 * (channel:{channelId})으로 fanout (S58 · FR-AM-25). 채널 룸 fanout 이라 channelId 가
 * 유일 식별자이며, 클라이언트는 해당 messageId 의 attachment 배열에서 attachmentId 가
 * 일치하는 항목의 processingStatus 와 thumbnailKey 를 patch 한다. status 는 표시 가능
 * 확정(READY) 또는 검역 차단(BLOCKED) 둘 중 하나다(PENDING/PROCESSING 은 전환 *대상*이라
 * 이 이벤트의 status 가 될 수 없다). thumbnailKey 는 생성됐으면 키, 아니면 null.
 *
 * 백엔드 emit 은 현재 비활성(Sharp/ffmpeg 서버 리사이즈 영구 보류 · complete 시 즉시 READY
 * 승격)이며, 본 스키마는 프런트엔드 핸들러의 forward-compat 계약만 고정한다.
 */
export const AttachmentProcessingDonePayloadSchema = z.object({
  channelId: ChannelIdSchema,
  messageId: z.string().min(1),
  attachmentId: z.string().min(1),
  // PENDING/PROCESSING 에서 전환되는 종착 상태 — READY(표시 가능) | BLOCKED(검역 차단).
  status: z.enum(['READY', 'BLOCKED']),
  // 후처리로 생성된 썸네일 키(생성 안 됐거나 차단이면 null).
  thumbnailKey: z.string().min(1).nullable(),
});
export type AttachmentProcessingDonePayload = z.infer<typeof AttachmentProcessingDonePayloadSchema>;

// ── 링크 unfurl 결과 갱신 (S60 · D11 · FR-RC07/08 · FR-AM-13~16) ──────────────
/**
 * message:embed_updated — 메시지 본문 URL 의 비동기 unfurl 이 끝나거나 사후 suppress 로
 * embed 집합이 바뀌면 채널 룸(channel:{channelId})으로 fanout 한다(S60). 채널 룸 fanout 이라
 * channelId + messageId 가 식별자이며, embeds 는 해당 메시지의 **비-suppress** embed 전체
 * 스냅샷이다(idempotent replace — 클라이언트는 해당 messageId 행 embeds 를 통째로 교체).
 * 모든 embed 가 suppress/삭제되면 embeds=[] 로 도착해 카드가 사라진다.
 */
export const MessageEmbedUpdatedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  messageId: z.string().min(1),
  embeds: z.array(MessageEmbedDtoSchema),
});
export type MessageEmbedUpdatedPayload = z.infer<typeof MessageEmbedUpdatedPayloadSchema>;

// ── 멤버 모더레이션 (S63 · D12 · FR-RM05/06) ─────────────────────────────────
/**
 * member:kicked — 멤버 강제 퇴장 시 워크스페이스 룸(workspace:{wsId})으로 fanout
 * (S63 · FR-RM05). 서버 내부 outbox eventType 은 dot 표기(workspace.member.kicked)
 * 지만 outbox→WS subscriber 가 이 콜론 wire 이름으로 변환해 워크스페이스 룸에 emit
 * 한다. payload 는 라우팅·소비에 필요한 최소 식별자 — 워크스페이스 id + 퇴장된
 * userId + 수행 주체 actorId 다. 다른 멤버는 멤버 목록 캐시를 무효화하고, 대상 본인은
 * (userId === viewer) 안내 토스트 + 멤버십 상실 리다이렉트를 받는다(소켓 disconnect
 * 자체는 kickUserEverywhere 가 별도로 수행). kicked 은 재가입 가능하다(BannedMember 미기록).
 */
export const MemberKickedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  userId: UserIdSchema,
  actorId: z.string().min(1),
});
export type MemberKickedPayload = z.infer<typeof MemberKickedPayloadSchema>;

/**
 * member:banned — 멤버 영구 차단 시 워크스페이스 룸(workspace:{wsId})으로 fanout
 * (S63 · FR-RM06). member:kicked 와 동일한 변환·라우팅 패턴이며 payload 형태도 동일
 * (workspaceId + userId + actorId)하다. ban 은 재가입 불가(BannedMember INSERT)이며,
 * 수신 클라는 멤버 목록에 더해 권한자 차단 목록 캐시도 무효화한다(BanListPanel 즉시 반영).
 */
export const MemberBannedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  userId: UserIdSchema,
  actorId: z.string().min(1),
});
export type MemberBannedPayload = z.infer<typeof MemberBannedPayloadSchema>;

/**
 * message:bulk_deleted — bulk purge 결과(S64 · FR-RM09). MANAGE_MESSAGES 권한자가
 * 채널 메시지를 일괄 soft-delete 하면 개별 message:deleted 가 아니라 이 단일 이벤트로
 * 실제 삭제된 messageIds[] 를 채널 룸으로 fanout 한다. 수신 클라 dispatcher 는 해당
 * messageIds 를 타임라인 캐시에서 한 번에 제거한다.
 */
export const MessageBulkDeletedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  actorId: z.string().min(1),
  messageIds: z.array(z.string().min(1)),
});
export type MessageBulkDeletedPayload = z.infer<typeof MessageBulkDeletedPayloadSchema>;

// ── 가입 신청 + 임시멤버 강퇴 (S70 · D13 · FR-W06/W06a/W12) ──────────────────
/**
 * ws:application_received — APPLY 워크스페이스에 신청 제출 시 워크스페이스 룸으로 fanout
 * (FR-W06). ADMIN 리뷰 패널이 목록을 즉시 갱신한다. applicantName 은 표시용(best-effort).
 */
export const ApplicationReceivedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  applicationId: z.string().min(1),
  applicantId: UserIdSchema,
  applicantName: z.string(),
});
export type ApplicationReceivedPayload = z.infer<typeof ApplicationReceivedPayloadSchema>;

/**
 * ws:application_reviewed — 신청 처리 결과를 신청자 본인 user 룸으로 fanout(FR-W06a).
 * status 는 소문자 wire 표현(approved/rejected/interview). rejected 시 reviewNote 가
 * 거절 안내에 노출되고, interview 시 interviewChannelId(자동 생성 1:1 DM)가 실린다.
 */
export const ApplicationReviewedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  applicationId: z.string().min(1),
  status: z.enum(['approved', 'rejected', 'interview']),
  reviewNote: z.string().nullable().optional(),
  interviewChannelId: z.string().nullable().optional(),
});
export type ApplicationReviewedPayload = z.infer<typeof ApplicationReviewedPayloadSchema>;

/**
 * ws:member_left — 멤버 이탈(임시멤버 자동 강퇴 포함). reason='temp_expired' 는 임시
 * 링크 가입 멤버의 마지막 소켓 disconnect 2초 debounce 후 강퇴를 뜻한다(FR-W12).
 */
export const MemberLeftPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  userId: UserIdSchema,
  reason: z.enum(['leave', 'kick', 'temp_expired']),
});
export type MemberLeftPayload = z.infer<typeof MemberLeftPayloadSchema>;

/**
 * ws:workspace_deleted — 워크스페이스 소프트 삭제 시 워크스페이스 룸(workspace:{wsId})으로
 * fanout(S72 · FR-W15). 서버 내부 outbox eventType 은 dot 표기(workspace.deleted)지만
 * outbox→WS subscriber 가 이 콜론 wire 이름으로 변환해 워크스페이스 룸에 추가 emit 한다.
 * payload 는 라우팅·소비에 필요한 최소 식별자 — 워크스페이스 id + 삭제 주체 actorId +
 * grace 종료 시각 deleteAt(ISO UTC)이다. 모든 멤버는 내 워크스페이스 목록을 무효화해
 * 사이드바에서 제거하고, 현재 보고 있던 워크스페이스면 홈으로 리다이렉트한다(OWNER 본인
 * 포함 — 자기 탭의 다른 세션도 동기화). deleteAt 은 복원 가능 잔여 기간 안내에 쓴다.
 */
export const WorkspaceDeletedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  actorId: z.string().min(1),
  deleteAt: z.string().datetime(),
});
export type WorkspaceDeletedPayload = z.infer<typeof WorkspaceDeletedPayloadSchema>;

/**
 * ws:workspace_restored — grace 내 복원 시 워크스페이스 룸(workspace:{wsId})으로 fanout
 * (S72 · FR-W15). deleted 와 동일한 변환·라우팅 패턴이며 payload 는 workspaceId + 복원
 * 주체 actorId 다. 수신 클라는 내 워크스페이스 목록을 다시 무효화해 사이드바에 복귀시킨다.
 */
export const WorkspaceRestoredPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  actorId: z.string().min(1),
});
export type WorkspaceRestoredPayload = z.infer<typeof WorkspaceRestoredPayloadSchema>;

/**
 * S74 (D14 · FR-PS-06): workspace_profile.updated 페이로드. 한 워크스페이스 스코프의 ws
 * 프로필(닉네임/아바타) 변경을 싣는다. wsNickname/wsAvatarUrl 은 비우기(전역 폴백)면 null 이다.
 */
export const WorkspaceProfileUpdatedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  wsNickname: z.string().nullable(),
  wsAvatarUrl: z.string().nullable(),
});
export type WorkspaceProfileUpdatedPayload = z.infer<typeof WorkspaceProfileUpdatedPayloadSchema>;

/**
 * 이벤트명 → 페이로드 스키마 매핑. 게이트웨이/클라이언트가 런타임 검증에
 * 사용합니다. (이름 단일성 + 페이로드 단일성을 한 곳에서 강제)
 */
export const WS_EVENT_PAYLOAD_SCHEMAS = {
  [WS_EVENTS.CONNECTION_READY]: ConnectionReadyPayloadSchema,
  [WS_EVENTS.CHANNEL_JOIN]: ChannelJoinPayloadSchema,
  [WS_EVENTS.CHANNEL_JOINED]: ChannelJoinedPayloadSchema,
  [WS_EVENTS.CHANNEL_LEAVE]: ChannelLeavePayloadSchema,
  [WS_EVENTS.CHANNEL_SYNCED]: ChannelSyncedPayloadSchema,
  [WS_EVENTS.CHANNEL_ERROR]: ChannelErrorPayloadSchema,
  [WS_EVENTS.MESSAGE_CREATED]: MessageCreatedPayloadSchema,
  [WS_EVENTS.MESSAGE_UPDATED]: MessageUpdatedPayloadSchema,
  [WS_EVENTS.MESSAGE_DELETED]: MessageDeletedPayloadSchema,
  [WS_EVENTS.REACTION_UPDATED]: ReactionUpdatedPayloadSchema,
  [WS_EVENTS.REACTION_CLEARED]: ReactionClearedPayloadSchema,
  [WS_EVENTS.TYPING_START]: TypingStartPayloadSchema,
  [WS_EVENTS.TYPING_STOP]: TypingStopPayloadSchema,
  [WS_EVENTS.TYPING_UPDATE]: TypingUpdatePayloadSchema,
  [WS_EVENTS.TYPING_BATCH]: TypingBatchPayloadSchema,
  [WS_EVENTS.PRESENCE_SUBSCRIBE]: PresenceSubscribePayloadSchema,
  [WS_EVENTS.PRESENCE_UNSUBSCRIBE]: PresenceUnsubscribePayloadSchema,
  [WS_EVENTS.PRESENCE_BULK]: PresenceBulkPayloadSchema,
  [WS_EVENTS.PRESENCE_ACTIVITY]: PresenceActivityPayloadSchema,
  [WS_EVENTS.PRESENCE_SET]: PresenceSetPayloadSchema,
  [WS_EVENTS.PRESENCE_UPDATE]: PresenceUpdatePayloadSchema,
  [WS_EVENTS.WORKSPACE_PRESENCE_UPDATED]: WorkspacePresenceUpdatedPayloadSchema,
  [WS_EVENTS.READ_STATE_UPDATED]: ReadStateUpdatedPayloadSchema,
  [WS_EVENTS.UNREAD_COUNT_INCREMENT]: UnreadCountIncrementPayloadSchema,
  [WS_EVENTS.DM_CREATED]: DmCreatedPayloadSchema,
  [WS_EVENTS.DM_PARTICIPANT_ADDED]: DmParticipantAddedPayloadSchema,
  [WS_EVENTS.DM_PARTICIPANT_REMOVED]: DmParticipantRemovedPayloadSchema,
  [WS_EVENTS.DM_OWNER_CHANGED]: DmOwnerChangedPayloadSchema,
  [WS_EVENTS.DM_GROUP_UPDATED]: DmGroupUpdatedPayloadSchema,
  [WS_EVENTS.USER_UNBLOCKED]: UserUnblockedPayloadSchema,
  [WS_EVENTS.THREAD_LOCK_CHANGED]: ThreadLockChangedPayloadSchema,
  [WS_EVENTS.EMOJI_CREATED]: EmojiCreatedPayloadSchema,
  [WS_EVENTS.EMOJI_DELETED]: EmojiDeletedPayloadSchema,
  [WS_EVENTS.EMOJI_ALIAS_UPDATED]: EmojiAliasUpdatedPayloadSchema,
  [WS_EVENTS.MENTION_NEW]: MentionNewPayloadSchema,
  [WS_EVENTS.NOTIFICATION_BADGE_UPDATE]: NotificationBadgeUpdatePayloadSchema,
  [WS_EVENTS.CHANNEL_PIN_ADDED]: ChannelPinAddedPayloadSchema,
  [WS_EVENTS.CHANNEL_PIN_REMOVED]: ChannelPinRemovedPayloadSchema,
  [WS_EVENTS.REMINDER_FIRE]: ReminderFirePayloadSchema,
  [WS_EVENTS.REMINDER_NEW_FIRE]: ReminderNewFirePayloadSchema,
  [WS_EVENTS.SAVED_UPDATED]: SavedUpdatedPayloadSchema,
  [WS_EVENTS.ATTACHMENT_PROCESSING_DONE]: AttachmentProcessingDonePayloadSchema,
  [WS_EVENTS.MESSAGE_EMBED_UPDATED]: MessageEmbedUpdatedPayloadSchema,
  [WS_EVENTS.MEMBER_KICKED]: MemberKickedPayloadSchema,
  [WS_EVENTS.MEMBER_BANNED]: MemberBannedPayloadSchema,
  [WS_EVENTS.MESSAGE_BULK_DELETED]: MessageBulkDeletedPayloadSchema,
  [WS_EVENTS.APPLICATION_RECEIVED]: ApplicationReceivedPayloadSchema,
  [WS_EVENTS.APPLICATION_REVIEWED]: ApplicationReviewedPayloadSchema,
  [WS_EVENTS.MEMBER_LEFT]: MemberLeftPayloadSchema,
  [WS_EVENTS.WORKSPACE_DELETED]: WorkspaceDeletedPayloadSchema,
  [WS_EVENTS.WORKSPACE_RESTORED]: WorkspaceRestoredPayloadSchema,
  [WS_EVENTS.WORKSPACE_PROFILE_UPDATED]: WorkspaceProfileUpdatedPayloadSchema,
} as const satisfies Record<WsEventName, z.ZodTypeAny>;
