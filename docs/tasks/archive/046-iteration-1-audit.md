# Iteration 1 — AUDIT (matrix expansion, audit-only)

> **목적**: 045 종료 매트릭스 (60+ row, score ≈ 95%) 에 신규 dimension
> 8개 추가 → 매트릭스 자체 확장. score 일시 하락 측정. **code 변경 0**,
> deploy 없음, commit 만.

## 가중치 룰 (044/045 동일)

- 완성 (✅) = 1.0
- 부분 (🟡) = 0.5
- 계획 (🔵) = 0.25
- 없음 (❌) = 0
- HIGH 갭 가중치 ×2

## 045 종료 매트릭스 (60 row baseline)

044 시드 + 045 closure 기준. score = (각 row 가중치 합 / row 수) × 100%.

### Section A — 메시지 표면 (12 row)

| #   | Row                                 | 상태 | 가중치 | HIGH? |
| --- | ----------------------------------- | ---- | ------ | ----- |
| A1  | 메시지 송수신 + ACK                 | ✅   | 1.0    | -     |
| A2  | 메시지 편집 / 삭제 / 5min 윈도우    | ✅   | 1.0    | -     |
| A3  | Reactions (이모지 + custom)         | ✅   | 1.0    | -     |
| A4  | Threads (parent + replies + count)  | ✅   | 1.0    | -     |
| A5  | Markdown bold/italic/strike/quote   | ✅   | 1.0    | -     |
| A6  | Code fence + inline code            | ✅   | 1.0    | -     |
| A7  | @user mention extractor             | ✅   | 1.0    | -     |
| A8  | @everyone permission gate           | ✅   | 1.0    | -     |
| A9  | @here mention                       | 🔵   | 0.25   | -     |
| A10 | Pinned messages BE + UI             | ✅   | 1.0    | -     |
| A11 | Link unfurl / OpenGraph + .qf-embed | ✅   | 1.0    | -     |
| A12 | Cursor 페이지네이션 + 검색          | ✅   | 1.0    | -     |

소계: 11.25 / 12 = **93.75%**

### Section B — 채널 / DM (10 row)

| #   | Row                                       | 상태 | 가중치 |
| --- | ----------------------------------------- | ---- | ------ |
| B1  | Channel CRUD + 카테고리                   | ✅   | 1.0    |
| B2  | Channel reorder (fractional position)     | ✅   | 1.0    |
| B3  | Channel mute (BE + dispatcher gate)       | ✅   | 1.0    |
| B4  | Channel discovery / discover              | ✅   | 1.0    |
| B5  | DM 1:1 (createOrGet + idempotent)         | ✅   | 1.0    |
| B6  | Group DM (3+, BE + listing)               | ✅   | 1.0    |
| B7  | DM mute                                   | ✅   | 1.0    |
| B8  | Channel settings (이름 / topic / private) | ✅   | 1.0    |
| B9  | Channel ACL / permission override         | ✅   | 1.0    |
| B10 | Per-channel pin permission                | 🔵   | 0.25   |

소계: 9.25 / 10 = **92.5%**

### Section C — 워크스페이스 (8 row)

| #   | Row                               | 상태 | 가중치 |
| --- | --------------------------------- | ---- | ------ |
| C1  | Workspace CRUD + soft-delete      | ✅   | 1.0    |
| C2  | Invite (link + 만료 + 재발급)     | ✅   | 1.0    |
| C3  | Member list + role                | ✅   | 1.0    |
| C4  | Role: OWNER / ADMIN / MEMBER      | ✅   | 1.0    |
| C5  | Member remove / leave             | ✅   | 1.0    |
| C6  | Discovery / public toggle         | ✅   | 1.0    |
| C7  | Owner transfer                    | ✅   | 1.0    |
| C8  | Workspace mention permission gate | 🔵   | 0.25   |

소계: 7.25 / 8 = **90.625%**

### Section D — Realtime (8 row)

| #   | Row                               | 상태 | 가중치 |
| --- | --------------------------------- | ---- | ------ |
| D1  | WS gateway + Redis adapter        | ✅   | 1.0    |
| D2  | Multi-node fanout                 | ✅   | 1.0    |
| D3  | Reconnect + replay                | ✅   | 1.0    |
| D4  | Membership revocation             | ✅   | 1.0    |
| D5  | Presence (auto/dnd)               | ✅   | 1.0    |
| D6  | Typing indicator                  | ✅   | 1.0    |
| D7  | Custom status text + WS broadcast | ✅   | 1.0    |
| D8  | Outbox + at-least-once            | ✅   | 1.0    |

소계: 8.0 / 8 = **100%**

### Section E — Auth / Security (8 row)

| #   | Row                                     | 상태 | 가중치 |
| --- | --------------------------------------- | ---- | ------ |
| E1  | Signup / login / refresh (JWT 15m + 7d) | ✅   | 1.0    |
| E2  | Refresh rotation (HttpOnly cookie)      | ✅   | 1.0    |
| E3  | Rate limit (IP + user)                  | ✅   | 1.0    |
| E4  | CSRF / origin guard                     | ✅   | 1.0    |
| E5  | SSRF guard (link unfurl, IPv6 변종)     | ✅   | 1.0    |
| E6  | Friend / DM guard                       | ✅   | 1.0    |
| E7  | gitleaks / Trivy / Syft / ZAP           | ✅   | 1.0    |
| E8  | Password breach check                   | ✅   | 1.0    |

소계: 8.0 / 8 = **100%**

### Section F — 알림 / Activity (6 row)

| #   | Row                                    | 상태 | 가중치 |
| --- | -------------------------------------- | ---- | ------ |
| F1  | Notification preferences               | ✅   | 1.0    |
| F2  | Mention dispatcher                     | ✅   | 1.0    |
| F3  | Activity counter (mention / DM / 모든) | ✅   | 1.0    |
| F4  | Read state (per channel)               | ✅   | 1.0    |
| F5  | Unread total                           | ✅   | 1.0    |
| F6  | Activity inbox (read state)            | ✅   | 1.0    |

소계: 6.0 / 6 = **100%**

### Section G — 첨부 / Storage (4 row)

| #   | Row                           | 상태 | 가중치 |
| --- | ----------------------------- | ---- | ------ |
| G1  | Image / video / file 업로드   | ✅   | 1.0    |
| G2  | MinIO object lifecycle        | ✅   | 1.0    |
| G3  | Custom emoji upload + cleanup | ✅   | 1.0    |
| G4  | Attachment ACL                | ✅   | 1.0    |

소계: 4.0 / 4 = **100%**

### Section H — UI / DS (4 row)

| #   | Row                                    | 상태 | 가중치 |
| --- | -------------------------------------- | ---- | ------ |
| H1  | DS 4 파일 untouched + tokens           | ✅   | 1.0    |
| H2  | DS mockup parity                       | ✅   | 1.0    |
| H3  | Visual regression baseline (DS-mockup) | ✅   | 1.0    |
| H4  | Dark theme + qf-\* 컴포넌트            | ✅   | 1.0    |

소계: 4.0 / 4 = **100%**

### 045 종료 매트릭스 합계

- 60 row 가중치 합: 11.25 + 9.25 + 7.25 + 8 + 8 + 6 + 4 + 4 = **57.75**
- 점수: 57.75 / 60 × 100% = **96.25%** (≈ 95%, 045 보고치와 일치)

---

## 046 신규 dimension 8 추가 (36 row)

### Section I — 모바일 surface 확장 (8 row)

| #   | Row                                    | 상태 | 가중치 | HIGH? |
| --- | -------------------------------------- | ---- | ------ | ----- |
| I1  | 모바일 composer (입력 / 첨부 / 멘션)   | 🔵   | 0.25   | -     |
| I2  | 모바일 DM thread (1:1 + group)         | 🔵   | 0.25   | -     |
| I3  | 모바일 reaction picker                 | ❌   | 0      | HIGH  |
| I4  | 모바일 emoji picker (Unicode + custom) | ❌   | 0      | HIGH  |
| I5  | 모바일 workspace switch (long-press)   | 🟡   | 0.5    | -     |
| I6  | 모바일 sidebar drawer (전체 nav)       | 🟡   | 0.5    | -     |
| I7  | 모바일 onboarding (첫 진입)            | ❌   | 0      | HIGH  |
| I8  | 모바일 pinned panel (진입)             | ❌   | 0      | HIGH  |

소계: 1.5 / 8 = **18.75%**. **HIGH 4건** (I3 / I4 / I7 / I8).

### Section J — 검색 깊이 (4 row)

| #   | Row                                               | 상태 | 가중치 | HIGH? |
| --- | ------------------------------------------------- | ---- | ------ | ----- |
| J1  | 검색 autocomplete (typing 중 suggestion)          | ❌   | 0      | HIGH  |
| J2  | 결과 navigation (이전/다음, 키보드)               | 🟡   | 0.5    | -     |
| J3  | filter (channel / sender / 기간 / has-attachment) | 🔵   | 0.25   | HIGH  |
| J4  | 결과 코드블록 / 멘션 highlight                    | 🟡   | 0.5    | -     |

소계: 1.25 / 4 = **31.25%**. **HIGH 2건** (J1 / J3).

### Section K — 알림 다양성 (4 row)

| #   | Row                                        | 상태 | 가중치 | HIGH? |
| --- | ------------------------------------------ | ---- | ------ | ----- |
| K1  | DnD 시간대 schedule (per-day / weekly)     | ❌   | 0      | HIGH  |
| K2  | 우선순위 (mention / thread reply / 일반)   | 🟡   | 0.5    | -     |
| K3  | Badge 동작 (unread vs mention / OS bridge) | 🔵   | 0.25   | -     |
| K4  | 첫 알림 onboarding (권한 요청 + 안내)      | ❌   | 0      | HIGH  |

소계: 0.75 / 4 = **18.75%**. **HIGH 2건** (K1 / K4).

### Section L — Keyboard shortcut cheat sheet (3 row)

| #   | Row                                    | 상태 | 가중치 | HIGH? |
| --- | -------------------------------------- | ---- | ------ | ----- |
| L1  | `?` 모달 (모든 단축키 list + 카테고리) | ❌   | 0      | HIGH  |
| L2  | 단축키 학습 (Cmd+K → suggestion)       | 🔵   | 0.25   | -     |
| L3  | Cheat sheet 한국어 mnemonic            | ❌   | 0      | -     |

소계: 0.25 / 3 = **8.33%**. **HIGH 1건** (L1).

### Section M — Profile 확장 (3 row)

| #   | Row                            | 상태 | 가중치 | HIGH? |
| --- | ------------------------------ | ---- | ------ | ----- |
| M1  | bio (한 줄 + 다단)             | ❌   | 0      | HIGH  |
| M2  | 외부 URL list (links)          | ❌   | 0      | -     |
| M3  | profile page 데스크톱 + 모바일 | 🔵   | 0.25   | -     |

소계: 0.25 / 3 = **8.33%**. **HIGH 1건** (M1).

### Section N — Thread follow / 구독 (3 row)

| #   | Row                                     | 상태 | 가중치 | HIGH? |
| --- | --------------------------------------- | ---- | ------ | ----- |
| N1  | follow toggle                           | ❌   | 0      | HIGH  |
| N2  | follow 상태 알림 분기 (subscribed only) | ❌   | 0      | HIGH  |
| N3  | 자동 follow (자신이 시작 / 답변)        | 🔵   | 0.25   | -     |

소계: 0.25 / 3 = **8.33%**. **HIGH 2건** (N1 / N2).

### Section O — Empty state 풍부화 (7 row)

| #   | Row 영역                     | 상태 | 가중치 | HIGH? |
| --- | ---------------------------- | ---- | ------ | ----- |
| O1  | channel empty + CTA          | 🟡   | 0.5    | -     |
| O2  | DM list empty + CTA          | 🟡   | 0.5    | -     |
| O3  | search empty (no results)    | 🔵   | 0.25   | -     |
| O4  | discover empty (workspace 0) | 🟡   | 0.5    | -     |
| O5  | pinned empty (메시지 0)      | 🟡   | 0.5    | -     |
| O6  | activity empty (멘션 0)      | 🟡   | 0.5    | -     |
| O7  | thread empty (자기 시작)     | 🔵   | 0.25   | -     |

소계: 3.0 / 7 = **42.86%**. HIGH 0건 (모두 부분 / 계획).

### Section P — Error recovery 일관성 (4 row)

| #   | Row                                               | 상태 | 가중치 | HIGH? |
| --- | ------------------------------------------------- | ---- | ------ | ----- |
| P1  | 모든 mutation 의 retry pattern (idempotency 활용) | 🟡   | 0.5    | -     |
| P2  | 일관된 에러 메시지 (한국어 friendly)              | 🟡   | 0.5    | -     |
| P3  | recovery action (retry / cancel / 새로고침)       | 🔵   | 0.25   | -     |
| P4  | 글로벌 에러 boundary + telemetry                  | 🟡   | 0.5    | -     |

소계: 1.75 / 4 = **43.75%**. HIGH 0건.

---

## 신규 36 row 합계

- 36 row 가중치 합: 1.5 + 1.25 + 0.75 + 0.25 + 0.25 + 0.25 + 3.0 + 1.75 = **9.0**
- 신규 row 점수: 9.0 / 36 × 100% = **25.0%**

## 확장 매트릭스 합계 (60 + 36 = 96 row)

- 가중치 합: 57.75 (045) + 9.0 (046 신규) = **66.75**
- 점수 (단순): 66.75 / 96 × 100% = **69.53%**

## HIGH 갭 가중치 ×2 적용 score

신규 HIGH 갭 = **12건**:

- I3 / I4 / I7 / I8 (모바일 4)
- J1 / J3 (검색 2)
- K1 / K4 (알림 2)
- L1 (단축키 1)
- M1 (프로필 1)
- N1 / N2 (thread follow 2)

가중치 ×2 룰: HIGH 갭 row 의 결손 점수에 ×2 패널티.

- HIGH 갭 row 12개 모두 ❌ (가중치 0). 각 row 의 결손 = 1.0 × 2 = 2.0 (= ×2 가중치 적용 시)
- 045 의 ×2 룰 해석: HIGH 갭 row 의 점수 결손이 score 산정 시 두 배.
- 신규 HIGH 갭 12건 → 결손 12 × 2 = 24 → 효과적 결손 row 가 24.
- 효과적 row 수 = 96 + 12 = 108 (HIGH 갭 row 가 score denominator 에서 한 번 더 카운팅)
- 확장 매트릭스 score (HIGH ×2 적용): 66.75 / 108 × 100% = **61.81%**

이는 매트릭스 정의 차이 (확장 전엔 HIGH 갭 0 이었음). **task 명세의 예상 (95% → 85-88%) 보다 더 큰 하락**의 원인:

1. **HIGH 가중치 ×2 룰 해석**: 045 종료 시점엔 HIGH 갭 = 0 이었으므로 룰이 무력화 (확장 매트릭스에서 처음 활성화).
2. **신규 36 row 의 평균 충족도**: 25% (대부분 ❌/🔵).

## **확장 매트릭스 비교 표**

| Phase                           | Row | HIGH 갭 | Score (단순) | Score (HIGH×2) |
| ------------------------------- | --- | ------- | ------------ | -------------- |
| 045 종료                        | 60  | 0       | 96.25%       | 96.25%         |
| 046 iter 1 (확장 직후, no work) | 96  | 12      | 69.53%       | 61.81%         |

**Δ score = -27pp ~ -34pp**. 명세 예상 (-7pp ~ -10pp) 보다 큼 — HIGH 12건의
×2 패널티 + 신규 row 의 base 충족도가 25% 인 게 합쳐진 결과.

> 본 iter 의 의도된 결과. 정체 (95%) 에서 빠져나와 "여전히 끌어올릴
> 영역" 의 신호를 명시화함. 다음 iter 2~N 에서 재 ≥ 90% 추구.

## 우선순위 (iter 2~N 처리 순서)

| Iter | Section + HIGH 처리                       | 예상 score 회복    |
| ---- | ----------------------------------------- | ------------------ |
| 2    | I (모바일 8 row) — visual baseline 8 추가 | +5~8pp             |
| 3    | J (검색 4 row)                            | +3~4pp             |
| 4    | K (알림 4 row, 단독 cross-cutting)        | +3~4pp             |
| 5    | L (단축키 3 row) + M (Profile 3 row)      | +4~5pp             |
| 6    | N (thread follow 3 row) + O (empty 7 row) | +5~6pp             |
| 7    | P (error recovery 4 row)                  | +2~3pp             |
| 8+   | AUDIT 결과 기반 잔여 HIGH 처리            | 종료 조건 도달까지 |

목표: 7 iter 안에 ≥ 90% AND HIGH = 0 (확장 매트릭스 기준).

## 매트릭스 row 추가 commit (이번 iter)

본 audit doc + plan log 만. 코드 변경 0. develop merge X. deploy X.

## DoD (이번 iteration)

- [x] 8 dimension × 36 row 추가 명시
- [x] 가중치 룰 044/045 동일 유지
- [x] HIGH 갭 식별 (12건)
- [x] score 재산정 (96.25 → 69.53 / 61.81% HIGH×2)
- [x] iter 2~N 우선순위 부여
- [x] DS 4파일 untouched (당연 — 코드 변경 0)
