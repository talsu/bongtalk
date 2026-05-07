# Iteration 1 — PLAN

## Scope

**Markdown bold / italic / strike / quote** 를 `renderMessageContent` 에 추가.

> Note: 본 iteration 은 FE 한 파일 + spec 변경의 작은 표면이라 메인 agent 가 직접 구현합니다. 더 큰 표면 (pinned / link unfurl) 은 feature-implementer (Opus) subagent 위임.

## 구현 전략

### 1. Block-level: `> quote`

- 라인의 시작이 `> ` (or `>` + space) 인 연속 라인을 묶어 `<blockquote>` 로 wrap
- fenced code 외부에서만 적용 (fenced 내부의 `>` 는 raw)
- 처리 위치: `renderMessageContent` 의 fenced 분리 후 non-fenced 세그먼트 안에서 line scan
- 출력: `<blockquote class="border-l-2 border-border-subtle pl-3 text-text-secondary my-1">…</blockquote>` (Tailwind = DS token alias)

### 2. Inline: bold / italic / strike

- `**…**` → `<strong class="font-semibold">`
- `*…*` 또는 `_…_` → `<em class="italic">`
- `~~…~~` → `<s class="line-through">`
- 처리 순서 (greedy): 우선 `**` 매칭, 다음 `~~`, 그 다음 단일 `*` / `_`
- 인라인 코드 (`` ` ``) 안에서는 markdown 무시 → 기존 코드 처리가 우선이므로 자연 보장
- mention / URL / emoji 와 alternation 같이 두면 한 토큰만 매칭 → 우선순위 안전

### 3. 정규식 합성

기존 `pattern`:

```
/`([^`\n]+)`|@([A-Za-z0-9_.-]{1,32})|(https?:\/\/[^\s<>]+[^\s<>.,;:!?'"()\]])|:([a-z0-9_]{2,32}):/g
```

확장:

```
/`([^`\n]+)`|@([A-Za-z0-9_.-]{1,32})|(https?:\/\/[^\s<>]+[^\s<>.,;:!?'"()\]])|:([a-z0-9_]{2,32}):|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|(?:\*|_)([^*_\n]+)(?:\*|_)/g
```

분기 추가:

- `m[5]` → bold
- `m[6]` → strike
- `m[7]` → italic

### 4. 엣지 케이스

- `**a *b* c**` → bold 가 외부 매칭 후 internal `*b*` 는 plain text (greedy, bold 만)
  → 파일 안에서 alt 처리는 단일 pass 로 한정. 사용자 케이스 우선순위 (Discord/Slack 와 동일).
- `_word_word_` → 단어 중간 underscore 는 italic 처리하지 않도록 word-boundary 보강은 현재 패턴 한계 내에서 허용 (Discord 동작 동일).
- `> line1\n> line2\nplain` → blockquote 2 라인 + plain 별도 라인.
- 빈 quote (`>` 단독) → blockquote 안 빈 paragraph (Slack 동작).
- 중첩 quote (`>>`) → 단일 quote 로 처리 (Discord 동작; 추가 nesting 은 OUT).

## Spec 추가 case (parseContent.spec.tsx)

1. bold `**hello**` → `<strong class="font-semibold">hello</strong>`
2. italic asterisk `*emph*` → `<em class="italic">emph</em>`
3. italic underscore `_emph_` → `<em class="italic">emph</em>`
4. strike `~~old~~` → `<s class="line-through">old</s>`
5. block quote 단일 라인 `> note` → `<blockquote …>note</blockquote>`
6. block quote 다중 라인 (연속) → 한 `<blockquote>` 안에 줄바꿈
7. fenced 안의 markdown 무시 (`__no__` raw)
8. inline code 안의 markdown 무시 (`` `**no**` `` raw)
9. bold 안의 italic skip (`**a *b* c**` → bold 만)

## 회귀 spec

- 위 9개 추가가 회귀 spec 역할 수행 (parseContent.spec.tsx)
- 추가로 e2e: `apps/web/e2e/messages/markdown.e2e.ts` (신규) — DM 으로 `**hello**` 송신 → 수신 measure

## DS 정합

- `.qf-bold` / `.qf-italic` / `.qf-strike` / `.qf-quote` 추가 ❌ (DS 4파일 금지)
- semantic tag + Tailwind utility (DS 토큰 alias) → DS 정합 유지

## 측정

- bundle delta: `renderMessageContent` 정규식 확장만 → +200 bytes 미만 예상
- 렌더 비용: 추가 alt 분기 → 무시 가능

## DoD (iteration 1)

- [ ] parseContent.spec.tsx 9개 신규 case green
- [ ] e2e markdown.e2e.ts 1개 시나리오 green (또는 정성 검증)
- [ ] DS 4파일 md5 unchanged
- [ ] `pnpm verify` green
- [ ] develop merge → main auto-promote
- [ ] /readyz 200 + idle 30s
- [ ] pane 1 mini-progress 1줄 forward
