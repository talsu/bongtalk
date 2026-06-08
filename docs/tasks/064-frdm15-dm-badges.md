# 064 · FR-DM-15 — DM 미읽/멘션 배지 완성 (P0 partial → done)

> UNDERSTAND wf_3c337c34. PRD FR-DM-15: "DM 사이드바 unreadCount 배지(UserChannelReadState 기반)·뮤트 DM은 @멘션 건수만 표시."

## 현 상태 (partial)
- ✅ 기본 unreadCount 배지 동작(`GET /me/dms` → DmListItem.unreadCount·`direct-messages.service.list()`).
- ✅ 프론트 배지 로직 완비: `apps/web/src/features/dms/dmRowBadge.ts` `deriveDmBadgeCount`(뮤트→mentionCount / 비뮤트→unreadCount) + spec. DmShell 이 호출하나 server 가 mentionCount 미노출.
- ✅ DM 뮤트 백엔드 존재: `PATCH /me/dms/:channelId/mute`(global-dm.controller·MutesService·UserChannelMute).
- ❌ 잔여: ① server `/me/dms` per-DM **mentionCount 미노출** ② 프론트 mentionCount 배선 ③ DM **뮤트 토글 UI 부재**.

## 스코프 (ADR · 마이그레이션 없음)
### S1 — server: /me/dms 에 mentionCount 추가
- `direct-messages.service.ts` `DmListItem` 에 `mentionCount: number` 추가 + `list()` SQL 에 per-DM 멘션 카운트 서브쿼리(unreadCount 서브쿼리 인접). **`common/acl/read-visibility.sql.ts` `mentionMatchSql()` 재사용**(JSONB @> users/everyone/here/channel) + 읽음 커서((createdAt,id)>lastRead) + roots-only(parentMessageId IS NULL OR isBroadcast) + deletedAt IS NULL. **단일 raw 쿼리에 fold(N+1 금지·unread.service.mentionCountFor 패턴)**. DM 은 DIRECT·ACL 단순(5단계 fold/private gate 생략).
- shared-types DM 응답 DTO(DmSummary 등)에 mentionCount 추가(있으면).

### S2 — frontend: mentionCount 배선
- `apps/web/src/features/dms/useDms.ts` `DmListItem` 에 `mentionCount: number` 추가.
- `DmShell.tsx` 가 `deriveDmBadgeCount(unreadCount, mentionCount, muted)` 로 mentionCount 전달(현재 미전달). dmRowBadge 는 이미 뮤트→mention 처리.

### S3 — frontend: DM 뮤트 토글 UI
- DM 행 컨텍스트 메뉴(또는 헤더)에 뮤트/뮤트해제 → `PATCH /me/dms/:channelId/mute`(SetDmMuteDto·mutedUntil null=무기한). **ChannelList 뮤트 토글 패턴(FR-CH-17·context menu·data-muted·bell-off)** 재사용. 성공 시 `useMutedChannelIds()` 무효화. 뮤트 시각(회색/bell-off)·뮤트 DM 은 멘션 배지만(dmRowBadge).

## 테스트
- api int(`direct-messages`/`me-dms`): /me/dms 응답에 mentionCount·뮤트 DM 멘션 카운트 정확(읽음커서·roots-only·자기메시지 제외 여부 unread 와 일관)·DM 뮤트 PATCH→배지 전환.
- web unit: DmShell 배지(unread vs muted-mention)·뮤트 토글 mutation+무효화.

## Acceptance
FR-DM-15=done · verify green + int + reviewer + 수동배포 LIVE. 마이그레이션 없음.
