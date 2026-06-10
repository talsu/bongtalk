# 071-M1 진행 상황 (세션 핸드오프 문서)

> 단일 진실원. 계획 전문: `docs/tasks/071-mobile-uiux-overhaul.md` M1 절(+2차 확정분),
> 감사 근거: `docs/audits/2026-06-10-mobile-uiux-audit.md`. 작업 규약·검증 환경·배포 절차는
> `docs/tasks/071-M0-progress.md` 와 동일 — **GitHub push-only, 게이트는 로컬**
> (standalone `pnpm verify` + `e2e/mobile` green), 배포는 main 체크아웃에서 수동
> `sudo bash scripts/deploy/auto-deploy.sh`.

## 전략

데스크톱 messages feature 가 순수 모듈로 분해돼 있어 M1 은 **공유 모듈을 모바일 표현에
배선**하는 작업이 중심: `grouping.isContinuation` · `newMessages.computeFirstUnreadIndex/
shouldShowJumpPill` · `sendState.ts` · `renderAst`(+MentionLookup) · `jumboEmoji` ·
`formatMessageTime` · `AttachmentsList/LinkPreview/RichEmbed` · `autocomplete/*` ·
`composerCounter/composerAnnouncement/composerSlash` · 업로드 훅(MessageComposer 참조).
DS 모바일 목업도 본문 콘텐츠 클래스(qf-mention/qf-codeblock/qf-reactions)는 데스크톱 정본을
재사용한다 — 모바일 전용은 행 골격(qf-m-msg*)과 시트/드로어 계열뿐.

## 청크 상태

| 청크 | 내용 | 상태 | 커밋 |
|------|------|------|------|
| D1 | 렌더 코어: 그루핑(--head/--cont)·날짜 디바이더·renderAst 통일(멘션 pill/하이라이트·스포일러·헤딩·점보)·시스템 메시지·BOT 뱃지·스레드 chip | **done** | |
| D2 | 리액션 칩 행 렌더+탭 토글(44px 터치)·커스텀 이모지 맵 | **done** | |
| D3 | 첨부/embed 렌더(qf-m-img-grid·OG 축약 카드)+라이트박스 | todo | |
| D4 | 첨부 업로드(+버튼 배선, presign 훅 재사용) | todo | |
| D5 | sendState(전송중/실패+재시도)+오프라인 컴포저 비활성(FR-IA-STATE-05a)+공지채널 disabled(FR-CH-19) | **done(컴포저 게이트류는 D8)** | |
| D6 | 미읽음 구분선+jump-btn+`?msg=` 점프 소비(하이라이트) | todo | |
| D7 | 타이핑 인디케이터 양방향 | todo | |
| D8 | 컴포저 textarea 전환(autogrow·4000자 카운터·enterKeyHint)+대량 멘션 confirm(FR-MSG-14/15)+자동완성(@/#/:/슬래시) | todo | |
| D9 | 시트 액션 확장(핀·저장·리마인더·신고·미읽표시)+삭제 confirm+포커스 트랩+이모지 드로어(qf-m-emoji-drawer) | todo | |
| D10 | presence touch activity 신호+멤버/아바타 idle 표시 | todo | |
| D11 | 게이트: 신규 모바일 e2e(그루핑/리액션/첨부/디바이더/타이핑/자동완성)+vr baseline 갱신+verify+적대 리뷰 fix-forward | todo | |
| D12 | develop 머지(ls-remote 확인)→main 승격→수동 배포→/readyz→REPORT | todo | |

## 결정 로그

- (시작) 모바일 행/컴포저는 MobileMessages 를 제자리 업그레이드(M2 IA 재구축 전까지의 표면).
  데스크톱 MessageItem 을 통째로 재사용하지 않는 이유: hover 툴바·우클릭 메뉴 등 데스크톱
  결합이 깊고, M2(OverlappingPanels)에서 행 컴포넌트가 다시 움직이므로 모바일 행은
  qf-m-msg 골격 + 공유 콘텐츠 모듈 조합으로 유지한다.

## 세션 핸드오프 노트

- (시작) feat/071-m1-chat-core 생성(develop 7b31f9a 기점). D1부터.
- (세션 #1) D1·D2·D5 완료 — tsc green, 시각 프로브(.tour/probe-m1.mjs → .tour/shots-m1/)
  실측: cont=2/head=3/divider=1/threadChip=1/반응칩 45×44, pageerror 0. 커밋 1c7204b.
  비고: renderAst 는 표준 :shortcode: 를 렌더하지 않음(커스텀만 — 데스크톱과 동일 parity).
  멘션 pill 실검증은 D8(자동완성으로 실제 멘션 작성) 때 수행.
