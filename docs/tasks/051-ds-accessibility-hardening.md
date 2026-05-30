# Task 051 — DS Accessibility Hardening (follow-up to 050)

## Context

Task 050(Slack/Discord-level DS 업그레이드) 직후 accessibility-auditor +
ui-designer 리뷰에서 다수의 a11y/markup 이슈가 확인됨. 그중 **050이
도입한 것**은 050에서 즉시 fix-forward 완료(아래 "이미 처리"). 나머지는
**050 이전부터 존재하던 systemic / styleguide-demo 이슈**라 본 후속 태스크로
분리해 정직하게 추적함.

## 이미 처리 (050에서 fix-forward)

- `--badge-unread-bg` violet a-500→a-600 (white 텍스트 4.23→5.52:1, WCAG 1.4.3)
- `--unread-divider-accent` a-500→a-400 (다크 위 11px 라벨 대비), divider pill bg→a-600
- `.qf-m-filter-chip--solid` 선택 bg→a-600
- drawer-scrim `--mention-bg`→전용 `--scrim` 토큰
- prefers-reduced-motion 전역 가드(WCAG 2.3.3) — 신규 도입, PASS

## Scope (이번 태스크에서 다룰 후보 — 우선순위순)

### P0 — systemic (DS/실앱 영향)

- [ ] 텍스트 입력 focus 가시성(WCAG 2.4.7): 현재 input/textarea 는 글로벌 halo
      opt-out(의도된 결정, tokens.css 주석). caret 만으로는 빈 필드에서 약함.
      `:focus` 시 `border-color: var(--accent)` 최소 적용 검토 → **결정 필요**
      (기존 설계 의도 vs WCAG). `.qf-m-composer__input:focus` 는 이미 accent border.
- [ ] `.qf-switch` 키보드 접근(WCAG 2.1.1): role=switch 에 tabindex=0 + Enter/Space.
      DS 는 CSS 만; 실제 tabindex/핸들러는 앱 primitive(`design-system/theme`,
      `primitives`)에서. 앱 Switch 컴포넌트 점검.
- [ ] 상태 dot 색-only(WCAG 1.4.1): online/idle/dnd/offline 가 색만. aria-label
      또는 shape 차이(dnd=minus, idle=crescent) 검토 — 단 brand 차별성 가드와 충돌
      주의(crescent 는 Discord 모방). aria-label 경로 우선.

### P1 — app primitives ARIA (styleguide 데모가 아니라 실앱 컴포넌트)

- [ ] Modal/Dialog: role=dialog + aria-modal + aria-labelledby + focus trap
      (앱 primitive Dialog 점검 — 데모뿐 아니라 실제 컴포넌트)
- [ ] Toast: role=status / aria-live=polite (앱 ToastProvider)
- [ ] 아이콘 전용 버튼 aria-label: 모바일 topbar back/action, composer send/plus,
      quickreact 이모지, format-btn(title→aria-label), server-btn(서버명)
- [ ] autocomplete/cmd-palette/emoji-picker ARIA: role=listbox/option, tablist/tab,
      combobox + aria-activedescendant (앱 CommandPalette 등 배선 시)
- [ ] form `<label for>` 연결: 앱 Input/Field primitive

### P1 — DS token cleanup (raw 잔존, 050 이전부터)

- [ ] components.css: `#fff`→var(--text-onAccent) (qf-btn--danger, qf-switch::after),
      light `#1A1540`→토큰, light `#F4F1FA`→var(--bg-panel)
- [ ] index.html(styleguide) 구버전 페이지 raw hex(#22C55E/#EF4444/#06B6D4 등) →
      토큰/상태 클래스 (icons·app-screen 데모)
- [ ] 미정의 유령 클래스: qf-topbar\_\_channel, qf-label, qf-input-wrap (정의 추가 or
      데모 클래스 교체)

### P2 — minor

- [ ] `.qf-row-iconbtn` 18px → 24px+ (터치 노출 시 2.5.5)
- [ ] 데스크톱 emoji-picker tab 36px, composer 버튼 28-32px (터치 컨텍스트 시 44px)
- [ ] qf-m-segment role=group, qf-tabs role=tablist (앱)
- [ ] qf-slash-menu BEM(`qf-autocomplete--slash` 검토)

## Non-goals

- brand accent(violet) 자체 변경(대비 위해 a-600 으로 전역 darken)은 금지 —
  white-on-violet 이 필요한 개별 지점만 a-600 사용(050 패턴 유지).

## Risks

- focus-ring 복원은 "caret 이 cue" 라는 기존 설계 결정을 뒤집음 → 사용자 확인 필요.
- 다수가 DS CSS 가 아니라 앱 primitive/markup 영역 → 050(DS-only) 와 별개 워크.
