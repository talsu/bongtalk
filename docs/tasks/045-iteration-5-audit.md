# Iteration 5 — AUDIT

## Score (시작)

- iter 4 종료 시 ≈ 90% (custom status BE 부분 +1.0)

## 이번 iteration 선정

**Group DM (3+)** (HIGH 갭 #6 — backlog, 미구현)

## 현재 상태

- 1:1 DM 은 `ChannelType.DIRECT` + 두 `ChannelPermissionOverride` 행 (USER principalType, allowMask = READ|WRITE|DELETE_OWN|UPLOAD) 패턴
- 채널명 slug: `dm:<sortedA>:<sortedB>`
- N ≥ 3 사용자 그룹 DM 미지원
- Member 추가/제거 endpoint 없음

## 제약

- DS 4파일 수정 금지
- migration: 신규 enum 값 추가 (ALTER TYPE) 가 prisma 5.22 에서 안전한지 검토 필요 — 안전 위해 enum 변경 X, 기존 DIRECT 재활용
- channel name slug 가 길어질 수 있음 (10명 × UUID = 360 자) — Channel.name `String?` 이므로 OK
- 권한 흐름은 기존 ChannelPermissionOverride 그대로 — N 명 모두 USER override 행 추가
- 단독 iteration

## 측정

- 신규 컬럼: 0 (기존 DIRECT 재활용)
- 신규 endpoint: 1 (POST /me/dms/groups)
- 신규 spec: createGroupDm service unit
- 영향 줄: ~150 라인

## 분할

- iter 5: createGroupDm + 목록 노출 (group DM 도 /me/dms 에서 보임)
- follow-up: addMember / removeMember / leaveDm UI / group avatar / 멤버 list endpoint
