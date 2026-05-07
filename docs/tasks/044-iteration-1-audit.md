# Iteration 1 — AUDIT

## Parity matrix score (시작점)

- 시드 score: 78%
- HIGH 갭 7개 (시드)

## 이번 iteration 선정

**Round A 항목 2 — Markdown bold / italic / strike / quote** (단독)

선정 사유:

- 가장 작은 표면 (BE 변경 0, FE `parseContent.tsx` 한 파일 + spec)
- 메가 loop 의 검증 단위로 적합 (deploy / readyz / pane 1 forward 흐름 검증)
- pinned + link unfurl 은 schema/migration 이 따라오는 큰 단위 → iteration 2/3 단독

## 현재 상태

- `parseContent.tsx` 가 처리: fenced block, inline code, @mention, http URL, `:emoji:`
- 미처리: `**bold**` / `*italic*` / `_italic_` / `~~strike~~` / `> quote`
- DS 4파일 (`tokens.css` / `components.css` / `mobile.css` / `icons.css`) 은 markdown 전용 클래스 미정의 (`.qf-bold` 등 없음)

## 제약

- DS 4파일 수정 금지 → semantic tag (`<strong>` / `<em>` / `<s>` / `<blockquote>`) + Tailwind utility class (DS 토큰을 alias 로 라우트) 만 사용
- 외부 markdown parser 도입 금지 (`markdown-it` 기각 사유: bundle scope)
- 메시지 저장 시 raw 텍스트 그대로 — render 만 변경

## 측정

- DOM/렌더 비용: 추가 정규식 alternation 1단계, 영향 무시할 수준
- Bundle: parseContent.tsx 안에서 처리 → 신규 dep 0
- spec coverage: 기존 test + 신규 8개 case 추가
