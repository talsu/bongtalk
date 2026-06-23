# 072-N3 진행 — 채널 사이드바·CRUD·횡단 진입

> 계획: `docs/tasks/072-desktop-uiux-overhaul.md` N3. 감사: `docs/audits/2026-06-13-desktop-uiux-audit.md`.
> 브랜치 feat/072-n3-channels (develop 1c1f4f6 기점). DS 4파일 frozen. 규약 동일.

## 정찰 결론

- **계약 완비**: CreateChannelRequest(name·type[TEXT/ANNOUNCEMENT]·topic≤1024·description·isPrivate)·
  archive/unarchive 라우트·useArchiveChannel/useUnarchiveChannel 존재. DS qf-switch/qf-toggle-row
  존재(qf-radio 없음 → 네이티브 radio). ChannelSettingsPage GeneralSection(247) + isDefaultChannel 가드(79).
- **갭**: CreateChannelModal 이 type=TEXT 하드코딩·private 토글 없음·'설명' 라벨이 topic 에 바인딩(description 미사용).
  아카이브 UI 부재. ChannelBrowser 멤버수/정렬/가입-열기 분기 부족. 사이드바 prefix 아이콘(lock/megaphone/#) 부재.

## 청크

| 청크 | 내용                                                                                         | 상태           | 커밋          |
| ---- | -------------------------------------------------------------------------------------------- | -------------- | ------------- |
| N3-1 | CreateChannelModal — 타입 라디오(텍스트/공지)+비공개 qf-switch+topic/description 분리 (HIGH) | green          |               |
| N3-2 | ChannelSettingsPage 아카이브/해제 토글(useArchiveChannel, 기본채널 비활성) (HIGH)            | green          |               |
| N3-3 | ChannelBrowser 멤버수 표시·정렬·가입/열기 분기 (MEDIUM)                                      | deferred(서버) |               |
| N3-4 | ChannelList prefix 아이콘(lock/megaphone/#) (LOW)                                            | green          |               |
| N3-G | 게이트: 데스크톱 e2e(channels) + standalone verify + 적대 리뷰(w0m6yn8dh)                    | green          | (fix-forward) |
| N3-D | develop 머지→main 승격→배포→/readyz→REPORT                                                   | todo           |               |

## N3-G 적대 리뷰(w0m6yn8dh — 10 에이전트·3각도) fix-forward

raw 7 → confirmed 6 / plausible 0.

**수리 완료:**

- **HIGH**: 타입 radiogroup 이 ARIA radio 키보드 모델 위반(roving tabindex·화살표 핸들러 없음) →
  TYPE_OPTIONS + radioRefs + roving tabindex(선택만 tab 진입) + Arrow←→↑↓ 이동·선택·포커스.
- **MEDIUM**: description textarea maxLength 1024→500(계약 ChannelDescriptionSchema.max(500) 정합 —
  501~1024 입력이 서버 400 raw-zod 토스트로 떨어지던 회귀).
- **MEDIUM**: 행 네비 aria-label 이 항상 '# name'이라 비공개/공지 미전달 → channelOpenLabel 헬퍼로
  '비공개/공지' 단어 포함.
- **LOW**: prefix 분기를 공용 헬퍼(channelGlyph.ts)로 추출 → SectionChannelRow(개인 섹션)에도 적용
  (메인 목록만 lock/megaphone, 개인 섹션은 '#' 던 불일치 해소).
- **LOW**: 채널 이름 maxLength 80→32 + 계약 정규식(소문자 alphanum/\_/-) 클라 검증·인라인 에러
  (대문자/공백/33+자가 서버 raw-zod 토스트로 떨어지던 진단불가 UX 개선).

**이월(문서화):**

- 보관(아카이브) 채널의 사이드바 숨김/읽기전용 enforcement — 서버 list 쿼리가 archivedAt 미필터·
  toggleArchive 가 이동 안 함(critic). 사이드바 client 필터 + read-only 분기는 데이터 흐름 광범위
  변경이라 후속 슬라이스로 이월. 힌트 문구는 과대표기 제거(정확화).
- N3-3(멤버수/가입-열기) 서버 의존 이월(상단).

## 이월(문서화)

- **N3-3 (MEDIUM) — 서버 의존**: 감사가 "memberCount 워크스페이스 응답에 존재"라 했으나 실측상
  그 memberCount 는 **워크스페이스 discover** 용이고 채널 목록 응답엔 per-channel memberCount·
  isMember(멤버 여부)가 없다. 채널 둘러보기의 멤버수 표시·멤버수 정렬·가입/열기 분기는 서버
  채널 목록 응답에 memberCount+isMember 추가가 선행돼야 함 → **서버 슬라이스** 필요. (정렬 name/activity·
  검색·가입은 이미 동작.)
- 사이드바 횡단 4종 고정행(검색/인박스/스레드/저장됨 — 미발견 표면) → N5 미발견 표면 정찰과 함께 평가.
- 토픽 100자 접기(FR-CH-09 S) → 헤더 토픽 truncate(현 단순 표시) 개선, 후속 LOW.
- 감사 기각: 채널 타입 변경(GeneralSection 이미 존재) · ANNOUNCEMENT composer disabled(전제 오류).
