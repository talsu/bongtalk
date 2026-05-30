# qufox 디자인 시스템 — Slack/Discord 수준 통합 업그레이드 스펙

## 0. 전제와 철학

우리 DS의 **기반은 이미 단단합니다.** 다크-퍼스트 3단 배경 레이어(`--bg-app`/`--bg-chat`/`--bg-panel`), 시맨틱 상태색, 4단 elevation, 4px 베이스 spacing, medium radii, 모션 토큰(`--dur-*`/`--ease-*`), z-index 스케일, 데스크톱 3-컬럼 골격과 스레드 패널까지 — Slack/Discord와 구조적으로 동급입니다.

격차는 **"기반 위에 올라가는 완성도"** 에 있습니다. 본 스펙은 Slack/Discord의 **밀도·정보 위계·인터랙션·모바일 동선·모션 언어**를 흡수하되, **색과 브랜드는 100% qufox(violet accent + night/lavender 중립)** 로 유지합니다. Slack aubergine(#4A154B)·Discord blurple(#5865F2)은 어디에도 복제하지 않습니다.

원칙: **raw hex/px/shadow 금지.** 이번 업그레이드는 새 raw 값을 추가하는 것이 아니라, 기존에 잠입한 raw 위반(14px dot, 10px time, 1.4 line-height, 36px touch)을 **토큰으로 교정**하는 방향입니다.

---

## 1. 가장 약한 지점 Top 5

| 순위 | 약점                                                                              | 영향                                                             | 대응 우선순위 |
| ---- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- |
| 1    | **모바일 내비게이션 패러다임 부재** (3패널 스와이프·탭바 고정·키보드 inset 없음)  | 채팅 진입 후 채널 변경 불가, OS 뒤로가기 의존 — 사용자 핵심 불만 | P0            |
| 2    | **데스크톱 메인 컴포저 전무** (`.qf-composer*` 0개)                               | 입력/전송/포맷/자동완성 비표준화, raw 값 남발                    | P0            |
| 3    | **오버레이 컴포넌트 11종 공백** (Cmd+K, 이모지 picker, hovercard 등)              | 프리미엄 기능 완성도 격차                                        | P0–P1         |
| 4    | **모션 결핍 + 접근성 위반** (`prefers-reduced-motion` 전무, toolbar display 토글) | WCAG 2.3.3 위반, 정적/깜빡임 UX                                  | P0–P1         |
| 5    | **정보 위계·밀도 + DS 규칙 위반** (unread 색만, raw px)                           | 스캔성 저하, 거버넌스 붕괴                                       | P1            |

---

## 2. tokens.css — 변경 및 신규

### 2.1 기존 토큰 교정 (raw/방향 오류)

| 토큰                          | Before                     | After                        | 근거                                              |
| ----------------------------- | -------------------------- | ---------------------------- | ------------------------------------------------- |
| `--bg-input`                  | `var(--n-0)` (가장 어두움) | `var(--n-2)` (chat보다 밝게) | 입력창이 '구덩이'처럼 보임. 벤치마크는 tonal lift |
| `.qf-thread-msg__time`        | `10px` (raw)               | `var(--fs-11)`               | DS 규칙 위반 + 접근성 경계선 (**P0**)             |
| `.qf-m-msg__body` line-height | `1.4` (raw)                | `var(--lh-snug)` (1.35)      | 토큰 거버넌스 위반 (**P0**)                       |
| `.qf-m-msg--head` padding-top | `14px` (raw)               | `var(--s-4)` (12px)          | 4px 베이스 정렬                                   |
| `.qf-channel` margin          | `1px 0`                    | `0`                          | 누적 공백 제거, hover로만 구분                    |

### 2.2 신규 토큰 (정당화)

```
/* 레이어 */
--bg-floating: var(--n-0);            /* 드롭다운/팝오버 전용, 모달과 분리 */

/* 상태 dot (raw px 박멸) */
--sz-status-dot:     14px;
--sz-status-dot-sm:  10px;
--sz-status-dot-ring: var(--s-1);     /* 2px */

/* 밀도 */
--msg-group-gap-cozy:     var(--s-5);  /* 16px */
--msg-group-gap-compact:  var(--s-2);  /* 4px  */
--msg-group-gap-spacious: var(--s-6);  /* 20px */
--msg-indent:    calc(var(--s-10) + var(--s-4));  /* 60px */

/* 컴포저 / 채널 row */
--h-composer: var(--s-10);            /* 48px (--h-typingbar는 인디케이터 줄로 재정의) */
--h-channel-row-default:  var(--s-9); /* 40px — 현행 28px를 표준 격상 */
--h-channel-row-compact:  var(--s-7); /* 24px */
--h-channel-row-spacious: var(--s-10);/* 48px */

/* 사이드바 resize */
--w-channellist-min: 160px;
--w-channellist-max: 400px;
--w-drawer-left: calc(var(--w-serverlist) + var(--w-channellist)); /* 312px */

/* z-index (빈 구간 활용) */
--z-drawer:  15;   /* header 위, dropdown 아래 */
--z-tabbar:  40;   /* sticky 위, settings-bg 아래 */

/* 모바일 모션·제스처·키보드 */
--m-swipe-threshold: 60px;
--m-keyboard-pad: env(keyboard-inset-height, 0px);
--m-panel-ease: var(--ease-standard);  --m-panel-dur: var(--dur-slow);
--m-sheet-ease: var(--ease-emphasized); --m-sheet-dur: var(--dur-base);
--m-tabbar-h-ios: 49px;

/* 의미 분리 (브랜드 표현) */
--badge-unread-bg:  var(--a-500);     /* 일반 unread = violet */
--badge-mention-bg: var(--danger-600);/* @멘션 = danger */
--unread-divider-accent: var(--a-500);

/* 인터랙션 */
--nav-pill-h-hover:  var(--s-3);  /* 8px */
--nav-pill-h-active: var(--s-8);  /* 32px */
--dur-longpress: 500ms;
--status-streaming: var(--a-400);
--msg-group-threshold-ms: 480000; /* 8분, shared-types 미러링 */
```

**핵심:** 신규 색 토큰은 `--status-streaming: var(--a-400)` 하나뿐이며 그조차 기존 accent 스케일 파생입니다. 나머지는 전부 spacing/layout/motion이라 brand_risk가 없습니다.

---

## 3. components.css — 데스크톱

### 3.1 [P0] 메인 컴포저 신설 (`.qf-composer*`)

현재 `.qf-m-composer`(모바일)만 존재하고 데스크톱 컴포저 클래스가 **0개**입니다.

```
.qf-composer { background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--r-lg); padding: var(--s-2) var(--s-3); }
.qf-composer:focus-within { border-color: var(--border-strong); }
.qf-composer__row { display:flex; align-items:flex-end; gap: var(--s-2); }
.qf-composer__input { flex:1; min-height: var(--h-composer-input-min); max-height:200px;
  background:transparent; border:none; outline:none;
  font: 400 var(--fs-15)/var(--lh-normal) var(--font-sans); color: var(--text); resize:none; }
.qf-composer__attach { /* = .qf-btn--ghost.qf-btn--icon.qf-btn--sm */ }
.qf-composer__formatbar { /* slide-down: max-height 0 → open, transition var(--dur-fast) */ }
.qf-composer__format-btn--active { color: var(--accent); background: var(--accent-subtle); }
```

### 3.2 [P0] 자동완성 / Command Palette / Emoji Picker

- `.qf-autocomplete` (슬래시/@/#, 컴포저 위 `bottom: calc(100% + var(--s-2))`), 선택 행 `aria-selected` + 좌측 `2px solid var(--accent)` bar.
- `.qf-slash-menu` (위만 둥근 `border-radius: var(--r-lg) var(--r-lg) 0 0`, 3열 그리드 icon/이름/설명).
- `.qf-cmd-palette` (`top:20vh`, `min(600px, 100vw-패딩)`, `bg-elevated`, `elev-4`, `z-modal`, 행 44px).
- `.qf-emoji-picker` (350×420, 9열 32px 그리드, 카테고리 탭, 검색바).

### 3.3 [P1] 정보 위계 — 멘션 / unread

```
.qf-message--mention { background: var(--mention-bg); border-left: 2px solid var(--accent); }
.qf-message--mention:hover { background: var(--mention-bgHov); }
.qf-channel--unread { color: var(--text-strong); font-weight: 700; }   /* 색+굵기 이중 */
.qf-channel { position: relative; }
.qf-channel--unread::before { content:''; position:absolute; left:0; top:50%;
  transform:translateY(-50%); width: var(--s-1); height: var(--s-3);
  background: var(--text-strong); border-radius: var(--r-pill); }
.qf-message__time { opacity:0; transition: opacity var(--dur-fast) var(--ease-standard); }
.qf-message:hover .qf-message__time { opacity:1; }
```

**Before/After:** unread 채널이 색만 → 색 + bold + 좌측 violet pill. 멘션 메시지가 배경색만 → 좌측 violet anchor bar로 시각 정착.

### 3.4 [P1] 모션 입히기

```
/* hover action bar: display 토글(transition 불가) → opacity 패턴 */
.qf-message__toolbar { display:flex; opacity:0; visibility:hidden; pointer-events:none;
  transform: translateY(var(--s-2)); border-radius: var(--r-lg);
  transition: opacity var(--dur-instant) var(--ease-standard),
              transform var(--dur-fast) var(--ease-standard); }
.qf-message:hover .qf-message__toolbar { opacity:1; visibility:visible;
  pointer-events:auto; transform: translateY(0); }

.qf-channel { transition: background-color var(--dur-fast) var(--ease-standard),
              color var(--dur-fast) var(--ease-standard); }   /* instant-on/smooth-off */
.qf-btn:active { transform: scale(0.97); transition-duration: var(--dur-instant); } /* translateY 제거 */
@keyframes qf-typing { 0%,100%{transform:translateY(0);opacity:0.4} 40%{transform:translateY(-4px);opacity:1} }
@keyframes qf-modal-in { from{opacity:0;transform:scale(0.96)} to{opacity:1;transform:scale(1)} }
```

### 3.5 [P1] 메시지 액션 완성도

quickreact 3슬롯(`.qf-msg-quickreact`), `.qf-reaction--add`(dashed pill), 코드블록 복사(`.qf-codeblock__copy` hover 노출), `.qf-embed__dismiss`, 스레드 followup 아바타 스택+카운트(`.qf-thread-followup__avatars/__count`).

### 3.6 [P1] 오버레이 컴포넌트군 (11종)

`.qf-status-picker` · `.qf-hovercard`(280px, banner 80px) · `.qf-search-overlay`(2패널) · `.qf-upload-overlay`(드래그앤드롭, `2px dashed var(--accent)`) · `.qf-banner`(info/warn/danger/neutral 4종) · `.qf-kbd-sheet` + `.qf-kbd` · `.qf-role-chip`(`--role-color` 인라인 변수) · `.qf-embed--image/video/bot`.

### 3.7 [P1, brand_risk med] 서버 레일

```
.qf-server-btn:hover { border-radius: var(--r-md); background: var(--bg-hover); color: var(--text); } /* accent fill 제거 */
.qf-server-btn[aria-selected="true"] { background: var(--accent); }  /* selected만 violet */
.qf-server-btn::before { height: 0; }
.qf-server-btn:hover::before { height: var(--nav-pill-h-hover); }      /* 8px (현행 20px) */
.qf-server-btn[aria-selected="true"]::before { height: var(--nav-pill-h-active); } /* 32px */
```

→ **방향 결정 필요** (§7-1). hover에서 violet을 빼는 변경이므로 사용자 취향 확인.

---

## 4. mobile.css — 모바일 (사용자 핵심 영역)

### 4.1 [P0] 3패널 OverlappingPanels

```
.qf-m-panels { position:fixed; inset:0; overflow:hidden; touch-action: pan-y; }
.qf-m-panel-left  { position:absolute; top:0; bottom:0; left:0; width: var(--w-drawer-left);
  transform: translateX(-100%); will-change: transform; background: var(--bg-panel); z-index: var(--z-drawer); }
.qf-m-panel-center{ position:absolute; inset:0; will-change: transform; }
.qf-m-panel-right { position:absolute; top:0; bottom:0; right:0; width: var(--w-memberlist);
  transform: translateX(100%); will-change: transform; background: var(--bg-panel); }
.qf-m-panels--show-left   { transform: translateX(0); }
.qf-m-panels--show-center { transform: translateX(-100vw); }
.qf-m-panels--show-right  { transform: translateX(-200vw); }
.qf-m-panel--dragging { transition: none !important; }                        /* 추종 */
.qf-m-panel--snapping { transition: transform var(--m-panel-dur) var(--m-panel-ease); } /* snap */
.qf-m-drawer-scrim { position:absolute; inset:0; background: rgba(10,8,30,0.55);
  opacity:0; pointer-events:none; transition: opacity var(--m-panel-dur) var(--m-panel-ease);
  z-index: calc(var(--z-drawer) - 1); }
```

### 4.2 [P0] 탭바 전역 고정 + 메모리

```
.qf-m-tabbar { position: fixed; bottom:0; left:0; right:0; z-index: var(--z-tabbar);
  background: var(--bg-app); }                  /* --n-2 → --n-0: 계층 역전 해소 */
.qf-m-screen { padding-bottom: calc(var(--m-tabbar-h) + env(safe-area-inset-bottom)); }
.qf-m-tabpanel[hidden] { visibility: hidden; pointer-events: none; position: absolute; inset: 0; }
.qf-m-tab__pill { /* 하단 violet 막대, width:20px height:3px background:var(--accent) */ }
.qf-m-tab[aria-selected="true"] .qf-m-tab__icon { transform: scale(1.1); }
.qf-m-tab__dot   { background: var(--text-strong); }         /* 일반 unread = 흰색 */
.qf-m-tab__badge { background: var(--badge-unread-bg); }     /* violet, --mention만 danger */
```

### 4.3 [P0] 키보드 inset + 컴포저 HIG

```
.qf-m-screen { height: 100%; }
@supports (height: 100dvh) { .qf-m-screen { height: 100dvh; } }
.qf-m-composer { padding-bottom: calc(var(--s-3) + env(safe-area-inset-bottom) + var(--m-keyboard-pad)); }
.qf-m-composer__input { min-height: var(--m-touch); line-height: var(--lh-snug); } /* 36→44, raw 1.4 제거 */
.qf-m-composer__plus, .qf-m-composer__send { width: var(--m-touch); height: var(--m-touch);
  display: grid; place-items: center; }   /* 히트박스 44, 내부 아이콘만 36 */
```

### 4.4 [P0] 채널 탐색 동선

`.qf-m-unread-divider`(수평선 + 중앙 violet pill 'NEW MESSAGES'), `.qf-m-jump-btn`(elevated+border+unread badge, accent FAB 아님), swipe-to-reply 트랜지션(`.qf-m-swipe` + `--m-swipe-threshold`).

### 4.5 [P1] IA 컴포넌트

`.qf-m-server-header`(채널리스트 상단 서버명+드롭다운), `.qf-m-tile-row/.qf-m-tile`(Home 퀵타일), `.qf-m-filter-bar/chip`(Activity 필터), `.qf-m-you-*`(You 탭), `.qf-m-thread-inbox`, `.qf-m-composer__accessory`(키보드 액세서리 바), `.qf-m-img-grid`(다중 이미지 1/2/3/4 레이아웃).

### 4.6 [P1] 모바일 모션

`.qf-m-sheet { transition: transform var(--m-sheet-dur) var(--ease-spring); }`(드래그 중 JS가 none), 화면 push slide(`qf-slide-in/out`), double-tap `.qf-m-react-toast`(spring pop).

---

## 5. 접근성 (P0 필수)

```
/* tokens.css 하단 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

현재 DS 전체에 reduced-motion 가드가 **전무**합니다. 전정기관 장애 사용자 보호 + WCAG 2.1 SC 2.3.3. `opacity`/`color` 80ms 이하 fade는 별도 transition 재선언으로 예외 허용 가능.

추가 접근성: 탭 활성표시 색→색+pill 이중화(색약), unread 색→색+bold 이중화, 서버 아이콘 `aria-label`+tooltip 강제.

---

## 6. 구현 로드맵

- **P0 (1차):** reduced-motion 가드 → raw 토큰 교정 → 모바일 HIG·키보드·탭바 고정·3패널 → NEW MESSAGES/jump FAB → 데스크톱 컴포저 → 자동완성/Cmd+K/이모지 picker.
- **P1 (2차):** 멘션/unread 위계 → 모션 입히기 → 서버 레일(med, 결정 후) → 메시지 액션 → 오버레이 11종 → 모바일 IA → 탭 indicator.
- **P2 (3차):** 밀도 3단계 → 사이드바 resize → 카테고리/멤버 → floating 레이어 → spring 디테일 → 잔여.

---

## 7. 사용자 결정 필요 (코드로 못 정하는 취향)

1. **서버 hover:** violet fill 유지 vs Discord식 형태 morph (selected는 양쪽 violet). → 추천: 형태 morph (단 violet 노출 감소, brand_risk med).
2. **밀도 단계:** 2단계(cozy/compact) vs 3단계(spacious/default/compact). → 추천: 2단계 시작, 토큰은 3단계까지 개방.
3. **탭 활성표시:** 색만 vs 하단 violet pill vs 알약 배경. → 추천: 하단 violet pill (접근성+미니멀).
4. **eyebrow 폰트:** 전부 sans vs 컨텍스트 분리(코드만 mono) vs 전부 mono. → 추천: 컨텍스트 분리 규칙 명문화.

---

## 8. 브랜드 불변식 요약

모든 변경에서 **accent = violet(`--a-500`), 중립 = night/lavender(`--n-*`), 폰트 = Space Grotesk + Geist Mono, radii = medium, spacing = 4px**. Slack aubergine / Discord blurple은 단 한 곳에도 들어가지 않습니다. 우리는 그들의 **밀도·위계·인터랙션·동선·모션**을 흡수하지만, 화면은 명백히 **qufox**로 보입니다.
