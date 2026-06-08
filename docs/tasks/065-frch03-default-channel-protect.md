# 065 · FR-CH-03 — 기본 채널 삭제/보관 보호 (P0 partial → done)

> UNDERSTAND 직독. **carryover("defaultChannelId 부재")는 outdated** — default-channel 인프라는 S65(FR-W01/W19)에 완비됨: `Workspace.defaultChannelId` FK·`Channel.isDefault`·생성 시 #general 시드·`updateDefaultChannel` 변경 API. **잔여 = 삭제/보관 보호 가드뿐. 마이그레이션 없음.**

## 현 갭
- `channels.service.ts softDelete()` 가 `isDefault` 체크 없이 삭제 → **기본 채널(가입자 랜딩) 삭제 가능 → 워크스페이스 랜딩 깨짐**(data-integrity P0).
- `archive()` 도 동일(기본 채널 보관 시 목록에서 사라져 랜딩 불가) — 함께 보호.

## 스코프 (S1~S3 · 마이그레이션 없음)
### S1 — ErrorCode
`DEFAULT_CHANNEL_PROTECTED`(409) 추가(shared-types ErrorCode + apps/api error-code.enum + HTTP 매핑·기존 CHANNEL_* 패턴). 메시지: "기본 채널은 삭제/보관할 수 없습니다. 먼저 다른 채널을 기본으로 지정하세요."

### S2 — 가드 (channels.service)
- `softDelete(workspaceId, channelId, actorId)`: 삭제 전 tx 에서 채널 `isDefault`(또는 Workspace.defaultChannelId 일치) 조회 → true 면 `throw DomainError(DEFAULT_CHANNEL_PROTECTED, 409)`. 워크스페이스 스코프 확인(restore 패턴).
- `archive(workspaceId, channelId, actorId)`: 동일 가드(기본 채널 보관 차단).
- 멱등/동시성: 가드는 tx 내 또는 사전 findFirst. updateDefaultChannel 로 기본을 옮긴 뒤엔 옛 기본 채널 삭제 가능(정상).

### S3 — 프론트 UX
- 채널 컨텍스트 메뉴(ChannelList)에서 **기본 채널(isDefault)** 의 삭제/보관 항목을 **비활성(disabled)** + 사유 안내(tooltip/sr) — "기본 채널". DTO 에 isDefault 노출돼 있으면 사용(workspaces.service:174 등 채널 DTO 에 isDefault 포함 확인). 409 응답도 graceful 토스트로 폴백 처리.

## 테스트
- api int(channels): 기본 채널 softDelete→409 DEFAULT_CHANNEL_PROTECTED·archive→409·비기본 채널 삭제 정상·`updateDefaultChannel` 로 기본 이전 후 옛 기본 삭제 정상. 워크스페이스 스코프.
- web unit: ChannelList 기본 채널 삭제/보관 disabled + 사유. 409 토스트.

## Acceptance
FR-CH-03=done · verify green + int + reviewer + 수동배포 LIVE. 마이그레이션 없음.
