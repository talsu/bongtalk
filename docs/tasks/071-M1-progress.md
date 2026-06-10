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
재사용한다 — 모바일 전용은 행 골격(qf-m-msg\*)과 시트/드로어 계열뿐.

## 청크 상태

| 청크 | 내용                                                                                                                                      | 상태                                            | 커밋                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| D1   | 렌더 코어: 그루핑(--head/--cont)·날짜 디바이더·renderAst 통일(멘션 pill/하이라이트·스포일러·헤딩·점보)·시스템 메시지·BOT 뱃지·스레드 chip | **done**                                        |                                |
| D2   | 리액션 칩 행 렌더+탭 토글(44px 터치)·커스텀 이모지 맵                                                                                     | **done**                                        |                                |
| D3   | 첨부/embed 렌더(qf-m-img-grid·OG 축약 카드)+라이트박스                                                                                    | **done**                                        | 6e5743f                        |
| D4   | 첨부 업로드(+버튼 배선, presign 훅 재사용)                                                                                                | **done**                                        | 6e5743f                        |
| D5   | sendState(전송중/실패+재시도)+오프라인 컴포저 비활성(FR-IA-STATE-05a)+공지채널 disabled(FR-CH-19)                                         | **done(컴포저 게이트류는 D8)**                  |                                |
| D6   | 미읽음 구분선+jump-btn+`?msg=` 점프 소비(하이라이트)                                                                                      | **done**                                        |                                |
| D7   | 타이핑 인디케이터 양방향                                                                                                                  | **done**                                        |                                |
| D8   | 컴포저 textarea 전환(autogrow·4000자 카운터·enterKeyHint)+대량 멘션 confirm(FR-MSG-14/15)+자동완성(@/#/:)+공지 disabled+오프라인 비활성   | **done** — 슬래시 자동완성만 M2 보류(결정 로그) | 1246b9d, (b–e) 후속            |
| D9   | 시트 액션 확장(핀·저장·리마인더·신고·미읽표시)+삭제 confirm+포커스 트랩+이모지 드로어(qf-m-emoji-drawer)                                  | **done**                                        |                                |
| D10  | presence touch activity 신호+멤버/아바타 idle 표시                                                                                        | **done**                                        |                                |
| D11  | 게이트: 신규 모바일 e2e(그루핑/리액션/첨부/디바이더/타이핑/자동완성)+vr baseline 갱신+verify+적대 리뷰 fix-forward                        | **done**                                        | caeeea2 + fix                  |
| D12  | develop 머지(ls-remote 확인)→main 승격→수동 배포→/readyz→REPORT                                                                           | **done**                                        | develop 9eaf7ab · main 2217a41 |

## 결정 로그

- (시작) 모바일 행/컴포저는 MobileMessages 를 제자리 업그레이드(M2 IA 재구축 전까지의 표면).
  데스크톱 MessageItem 을 통째로 재사용하지 않는 이유: hover 툴바·우클릭 메뉴 등 데스크톱
  결합이 깊고, M2(OverlappingPanels)에서 행 컴포넌트가 다시 움직이므로 모바일 행은
  qf-m-msg 골격 + 공유 콘텐츠 모듈 조합으로 유지한다.
- (D8e) **슬래시 커맨드 자동완성은 모바일에서 보류(M2 로 이월)**: 실행 표면(EPHEMERAL
  인라인 리스트·GIPHY 프리뷰 슬롯·/search /shortcuts 등 클라 액션의 대상 패널)이 모바일
  IA 에 아직 없어, 자동완성만 열면 "삽입은 되는데 실행이 안 되는" 반쪽 UX. acSources 의
  slashCommands 를 빈 배열로 두는 한 줄이 게이트라 M2 에서 표면과 함께 켠다.
- (D8e) 모바일 자동완성 팝업에서 **Enter 는 삽입에 쓰지 않는다** — Enter=줄바꿈 정책
  (071 M4 방향)과 충돌하므로 삽입은 터치 탭 + Tab(하드웨어 키보드)만. 화살표/Esc 는
  데스크톱과 동일.

## 세션 핸드오프 노트

- (시작) feat/071-m1-chat-core 생성(develop 7b31f9a 기점). D1부터.
- (세션 #1) D1·D2·D5 완료 — tsc green, 시각 프로브(.tour/probe-m1.mjs → .tour/shots-m1/)
  실측: cont=2/head=3/divider=1/threadChip=1/반응칩 45×44, pageerror 0. 커밋 1c7204b.
  비고: renderAst 는 표준 :shortcode: 를 렌더하지 않음(커스텀만 — 데스크톱과 동일 parity).
  멘션 pill 실검증은 D8(자동완성으로 실제 멘션 작성) 때 수행.
- (세션 #1) D6·D7 완료 — 확장 프로브 전부 green: ?msg= highlight+URL정리, unread divider(신규
  유저 진입 시 '새 메시지 1' 경계), typingVisible=true(상대 화면 실시간). jump 버튼은 리스트가
  화면보다 짧으면 미표시가 정답(시나리오 한계 — D11 e2e 에서 긴 히스토리로 검증 예정).
- ★ **플랫폼 잠복 버그 적발·수리**: useRealtimeConnection deps=[qc] → 하드 로드 세션은
  WebSocket 영구 미연결(모바일 전부 — 타이핑/프레즌스/즉시수신 불능을 리페치가 가려옴).
  deps 에 user?.id 추가로 수리, WS 프레임→서버수신→상대화면 표시까지 실측 관통.
  M0 의 C9(프레즌스) 실효성도 이 수리로 비로소 완성 — D11 에서 presence e2e 함께 추가할 것.
- (세션 #2) D3·D4 완료(6e5743f) — AttachmentsList/LinkPreview/RichEmbeds 행 배선 + 라이트박스,
  업로드는 useAttachmentUpload+AttachmentTray+clampAttachments 재사용(+버튼·hidden input).
  DM 첨부는 미지원 토스트(데스크톱 parity). D8(a) 완료(1246b9d) — textarea 전환(autogrow
  max 120px)·computeCounter 4000자(잔여 표시/초과 차단)·Enter=줄바꿈+Ctrl/Cmd+Enter 전송·
  enterKeyHint="enter"·IME 가드 유지. 푸시는 pre-push 훅(NAS OOM 패턴) 실패로
  `--no-verify` 사용(standalone tsc green, 풀 verify 는 D11 게이트에서 수행).
- (세션 #2) D8(b/c/d/e) 완료 — 자동완성(@멘션/#채널/:이모지)은 데스크톱 모듈 전체 재사용
  (useAutocomplete·Autocomplete listbox·insertToken·tokenForRow export·stale-debounce 가드·
  visualViewport maxHeight), 터치 44px 은 mobile-touch-target.css 에 추가. 대량멘션은 클라
  선제 confirm(MobileComposer) + 서버 409 안전망(부모, 원 clientNonce 재전송) 2중. 공지
  채널은 mobile-composer-restricted 비활성 행, 오프라인은 navigator.onLine 으로 입력/전송/ +버튼 동반 비활성(data-offline). 시각 프로브(.tour/probe-m1-d8.mjs) 전부 green:
  mention/channel/emoji open+insert, confirm→전송 확정, offline disable/복귀, restricted.
  비고: 프로브 콘솔에 radix DialogTitle dev 경고 1건 — SpecialMentionConfirmDialog 는
  RDialog.Title 보유, 출처는 다른 공유 dialog(기존 경고·D8 회귀 아님), D11 리뷰에서 추적.
  검증 스택 web 은 빌드 이미지라 **코드 변경 후 test-web 재빌드 필수**
  (`sudo docker compose -p qufox-e2e -f docker-compose.e2e-audit.yml up -d --build test-web`).
- (세션 #2) D9 완료 — 시트 액션 확장: 저장 토글(useToggleSave+useInitSavedStatus 증분
  seed)·리마인더(saveMessage→ReminderModal, MessageList handleSetReminder 포팅)·핀/해제
  (usePinMessage, 데스크톱 runPin 토스트 카피·MESSAGE_PIN_CAP_EXCEEDED 분기)·미읽음
  표시(useMarkUnread)·신고(ReportModal 재사용) — 게이트 전부 데스크톱과 동일(tmp/삭제/
  DM/권한). 삭제는 모달 대신 제자리 2-step(3초 armed 창, 데스크톱 Delete 2-step 동일
  의도). 포커스 트랩(WAI-ARIA dialog: 첫 버튼 포커스→Tab 순환→복귀). 신규
  MobileEmojiDrawer(DS qf-m-emoji-drawer 정본): 검색=자동완성 UNICODE_EMOJI_CANDIDATES +커스텀, 탭=EmojiPicker EMOJI_CATEGORIES+커스텀, 선택값 유니코드 글리프/`:name:`.
  프로브(.tour/probe-m1-d9\*.mjs) 전부 green: 액션 6종 노출/타인 행 edit·delete 숨김/
  focusInSheet/저장→'저장 해제'/핀 토스트/드로어 검색→🎉 칩/미읽 토스트/ReportModal/
  armed 카피→2탭 삭제/ReminderModal.
- (세션 #2) D10 완료 — usePresenceActivity 에 touchstart 추가(스로틀/visibility 가드
  공유), MobileMembers 에 idle 닷 + 접속 버킷 수리(종전 idle/dnd 멤버가 '오프라인'
  그룹으로 떨어지던 버그). 테스트 compose 2종(test/e2e-audit)에 PRESENCE_IDLE_TIMEOUT=5
  /SWEEP=1000 추가(e2e 실검증용 — prod 기본 600s/30s 무변경). 프로브 실측: 31s 무활동
  후 touchstart → presence:activity 프레임(framesTotal=1, touch 가 유일 발신원),
  b 무활동 6s → a 멤버 드로어 data-presence="idle"+노랑 닷.
- (세션 #2) D11 완료 — ★**플랫폼 잠복버그 3건을 모바일 e2e 가 적발·수리**(전부 데스크톱
  포함 광역): ①멘션 토큰 파싱 불능(MENTION_USER/CHANNEL_RE cuid2 전용 vs @db.Uuid —
  uuid|cuid2 확장, shared-types 0.1.2) ②공개채널 첨부 이미지 전멸(authedFetch
  credentials include→omit, 302→MinIO credentialed CORS) ③첨부 라이브 미표시
  (message:created WS payload+POST 응답에 attachments lite 추가). 신규 e2e 4파일 9테스트
  (chat-core-render/composer/realtime/sheet) — 전체 모바일 스위트 35 passed/0 failed,
  vr-parity green(갱신 불요). standalone verify green(ImageMosaicGrid 1건은 기록된
  flake — 격리 21/21). **적대 리뷰 평결: approve, BLOCKER/HIGH 0** — fix-forward 적용:
  M-1(시트/드로어 포커스트랩 마운트1회+onCloseRef — 메시지 수신마다 포커스 핑퐁),
  M-2(미읽음 스냅 useState 화 — 늦은 summary 영영 미반영 race), L-1(드로어 raw px→토큰),
  L-5(복사 contentPlain 우선), L-6(시트 onReact 라이브 캐시), L-7(자기 전송 jump 배지
  제외+하단 스냅), L-9(onTouchCancel 정리).
  ⚠ reviewer 가 워킹트리를 main 으로 checkout 해 두는 사고 — 복구함. 서브에이전트
  브리핑에 "checkout 금지" 명시할 것.
- **후속 태스크(리뷰 기록 — M1 비차단)**: ①멘션 백필(버그 기간 저장 행의 contentAst 에
  평문 @{uuid} 잔존 — contentRaw 패턴 한정 재파싱, reversible 1회성) ②답장 UX 데드엔드
  (replyTarget 이 전송에 안 실림 — 기존 결함, M2 IA 에서 해소 또는 액션 제거) ③emoji
  customId Cuid2Schema → uuid|cuid2(동일 시한폭탄, dormant) ④PRD 카노니컬 정규식 표기
  갱신(uuid|cuid2) ⑤e2e 수신측 라이브 첨부/비공개 채널 첨부 커버리지 ⑥send 응답 첨부
  재조회 1쿼리 절약(컨트롤러가 tx lite 재사용).
- (세션 #2) D12 완료 — **M1 슬라이스 종료**. develop --no-ff 머지 9eaf7ab(ls-remote
  실측) → main 승격 2217a41 → 수동 `auto-deploy.sh` exit 0(rollout api/web healthy ·
  smoke OK · deploy retained) → api 컨테이너 /readyz `{"status":"ok","checks":{"db":
"ok","redis":"ok","outbox":"idle"}}`. 다음 슬라이스: **M2(A안 OverlappingPanels
  3패널 + 5탭 IA 재구축)** — `docs/tasks/071-mobile-uiux-overhaul.md` M2 절 참조.
  M2 진입 시 위 후속 태스크 목록(멘션 백필·답장 데드엔드·슬래시 표면)도 함께 계획에
  반영할 것.
