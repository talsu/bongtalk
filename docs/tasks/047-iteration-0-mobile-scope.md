# 모바일 4 row Production Code Scope (Section I, 046 reclass 후속)

046 iter 8 에서 HIGH 라벨이 제거된 4 row 의 production code 정리. 본
doc 은 047 iter 0 의 carry-over scope 명세 (실제 ship 은 별도 iter).

## 4 row 현재 상태 (96 row matrix Section I)

| #   | Row             | 현재 상태 | DS 디자인                           | Visual baseline                  | Production code |
| --- | --------------- | --------- | ----------------------------------- | -------------------------------- | --------------- |
| I3  | reaction picker | 🔵 (0.25) | ✅ (DS qf-reactions)                | ✅ (mobile-046-thread baseline)  | ❌              |
| I4  | emoji picker    | 🔵 (0.25) | ✅ (DS qf-emoji-picker)             | ✅ (thread baseline 포함)        | ❌              |
| I7  | onboarding      | 🔵 (0.25) | ✅ (DS qf-m-screen 새 워크스페이스) | ✅ (mobile-046-workspace-create) | ❌              |
| I8  | pinned panel    | 🔵 (0.25) | ✅ (DS qf-m-pinned)                 | ✅ (mobile-046-pinned-panel)     | ❌              |

## 의존성 분석

### I3 모바일 reaction picker

- **DS 컴포넌트**: 데스크톱 dropdown (`MessageItem.tsx`) 이미 사용. 모바일 bottom sheet 패턴.
- **API**: `POST /messages/:id/reactions` (013-B 기존, 변경 없음)
- **신규 코드**:
  - `MobileReactionPicker.tsx` — bottom sheet 컨테이너 + emoji grid
  - `MessageRow` 의 long-press handler (mobile detection + Picker open)
- **데이터 모델**: 변경 0
- **시간 추산**: ~150 라인 + spec ~80 라인 = ~230 라인

### I4 모바일 emoji picker (Unicode + custom)

- **DS 컴포넌트**: 데스크톱 emoji picker (`EmojiPicker.tsx`) 이미 존재.
  모바일 viewport 적응 + bottom sheet 변종.
- **API**: `GET /workspaces/:id/emojis` (custom emoji 023 기존)
- **신규 코드**:
  - `MobileEmojiPicker.tsx` — full-height sheet + tab (Unicode / Custom)
  - composer 에서 emoji 진입점 (모바일 keyboard 위 toolbar)
- **데이터 모델**: 변경 0
- **시간 추산**: ~250 라인 + spec ~100 라인 = ~350 라인

### I7 모바일 onboarding

- **DS 컴포넌트**: DS 의 새 워크스페이스 page (mobile mockup). 첫 진입 흐름.
- **API**: `GET /me/onboarding-state` (027 기존), `PATCH /me/onboarding`
- **신규 코드**:
  - `MobileOnboardingFlow.tsx` — 3-단계 wizard
  - 첫 진입 detect (User.firstSeen 또는 onboardingShown 플래그)
- **데이터 모델**: 기존 User 의 onboarding 필드 활용 가능, 단 step 추적 시 `onboardingStep INT` 추가 필요할 수 있음
- **시간 추산**: ~200 라인 + spec ~80 라인 = ~280 라인

### I8 모바일 pinned panel

- **DS 컴포넌트**: DS 의 mobile pinned panel mockup (drawer overlay)
- **API**: `GET /channels/:id/pins` (044 기존)
- **신규 코드**:
  - `MobilePinnedPanel.tsx` — drawer overlay + 메시지 리스트
  - 채널 헤더에 진입점 (📌 아이콘)
- **데이터 모델**: 변경 0
- **시간 추산**: ~180 라인 + spec ~70 라인 = ~250 라인

## 총합

- 총 영향 ~1100 라인 (코드 + spec) + visual baseline 갱신
- 한 iter 분량보다 큼 → 1 iter 당 1-2 row 권장
- Section M3 profile page (047 iter 4 권장) 와 함께 모바일 surface 분량 큰 iter 가 됨

## 047 적용 옵션

### Option A: 본 047 안에서 분할 ship (권장 안 함)

iter 4 (M3 profile page) 외에 모바일 4 production code 도 동시에
처리하려면 cap 10 안에서 score 90% 도달이 어려워짐. iter 5/6/7 의
N3+O+P 가 여전히 필요하므로 모바일 4 ship 은 cap 초과 위험.

### Option B: 048 task 로 이월 (권장)

M3 profile page 만 047 iter 4 에서 모바일 surface 시드. 다른 4 row 는
**TODO(task-048-mobile-section-i-production)** 로 명시 이월. 본 047
iter 0 에서는 scope 명세 + 의존성 분석 산출 (=본 doc).

본 doc 을 047 의 row 가중치 일부 진급에 활용 (🔵→🟡 — DS + visual +
이행 계획서 보유).

## row 가중치 변화 (본 doc 효과)

| #   | Row             | iter 0 직전 (046 종료) | iter 0 직후                        |
| --- | --------------- | ---------------------- | ---------------------------------- |
| I3  | reaction picker | 🔵 (0.25)              | 🟡 (0.5) — scope doc + DS + visual |
| I4  | emoji picker    | 🔵 (0.25)              | 🟡 (0.5) — scope doc + DS + visual |
| I7  | onboarding      | 🔵 (0.25)              | 🟡 (0.5) — scope doc + DS + visual |
| I8  | pinned panel    | 🔵 (0.25)              | 🟡 (0.5) — scope doc + DS + visual |

Section I 변화: 3.0 → 4.0 / 8 = 50% (046 종료 37.5% 대비 +12.5pp).

가중치 진급은 ✅ 가 아닌 🟡 임 — production code 가 없으므로 ❌→🔵 가
아닌 🔵→🟡 가 적정 (DS + visual baseline + 이행 계획서 보유는 partial,
production code 도착 시 ✅).

## 결정

**Option B 채택**. 047 안에서는 본 doc 으로 4 row 진급. ship 은
task-048 (또는 후속) 으로 이월 + TODO 등록.

## 관련 TODO

- `TODO(task-048-mobile-reaction-picker)` — I3
- `TODO(task-048-mobile-emoji-picker)` — I4
- `TODO(task-048-mobile-onboarding-flow)` — I7
- `TODO(task-048-mobile-pinned-panel-route)` — I8
