# 072-N5 진행 — 모더레이션·역할·워크스페이스·설정 + 미발견 표면 정찰

> 계획: `docs/tasks/072-desktop-uiux-overhaul.md` N5. 브랜치 feat/072-n5-mod-roles-ws (develop 114c147 기점).

## 정찰 결론 — 스코프 확정

서버 의존성 실측으로 N5 를 **프론트엔드-only** 항목으로 한정(서버 슬라이스 의존 항목 이월).

- **미발견 표면 정찰**: DiscoverShell/DiscoverPage·ApplicationForm/Pending/Review·InviteAccept/
  EmailInviteAccept 전부 **존재 + 라우팅 + 스펙 보유** 확인(감사의 우려는 '감사 미커버'였고 '미구현' 아님).
  심층 PRD 대조는 후속(파손 없음).
- **N5-1 워크스페이스 아이콘 업로드(HIGH) — 이월**: 워크스페이스 아이콘 presign/finalize 서버
  엔드포인트 부재(workspaces 컨트롤러에 icon/presign 없음). 서버 슬라이스 선행 필요.
- **N5-3 AutoMod 폼·감사 로그 5열(MEDIUM) — 이월**: AutoModRule 폼 분기·AuditLogEntry DTO(target/reason)
  서버 변경 동반 → 서버 슬라이스.
- **joinMode 설정 편집 — 이월**: UpdateWorkspaceRequestSchema 에 joinMode 없음(생성 모달엔 있음).
  서버 스키마 확장 필요. slug 변경은 정책 보류.

## 청크

| 청크 | 내용 | 상태 | 커밋 |
| ---- | ---- | ---- | ---- |
| N5-2 | 역할 권한 카탈로그에 KICK/BAN/TIMEOUT 추가(비트 PERMISSIONS 기존재, web 카탈로그 누락) | green | |
| N5-4 | 워크스페이스 설정 일반탭 이름 편집(UpdateWorkspaceRequest.name 기존재, OWNER 게이트) | green | |
| N5-R | 미발견 표면 정찰(존재·라우팅·스펙 확인) | green | |
| N5-G | 게이트: 단위(catalog + 워크스페이스 130) + standalone verify + 적대 리뷰(wrer6ljys) | green | (fix-forward) |
| N5-D | develop 머지→main 승격→배포→/readyz→REPORT | todo | |

## N5-G 적대 리뷰(wrer6ljys — 5 에이전트·2각도) fix-forward

raw 3 → confirmed 3(모두 canSave 회귀 동일 사안).

- **MEDIUM(자가 발생 회귀)**: 추가한 `nameChanged ||` 가 canSave 최상위 OR 라 PUBLIC 전환
  메타데이터 게이트를 short-circuit → 무효 상태(PUBLIC+빈 카테고리/설명)서도 저장 버튼 활성.
  수리: visibilityValid 를 항상 AND 로 요구 + nameValid AND(`canSave = ownerEditable && nameValid && visibilityValid`).
- **LOW**: 이름 input 빈값 피드백 부재 → nameValid + 인라인 에러(role=status·aria-invalid) + 저장 비활성.

## 이월(서버 슬라이스)

- 워크스페이스 아이콘 업로드(presign/finalize) · joinMode 설정 편집 · AutoMod 규칙 폼 · 감사 로그 5열 DTO ·
  채널 권한 override 편집기 · FR-RT-20 연결 불가 배너(realtime → N6 후보).
