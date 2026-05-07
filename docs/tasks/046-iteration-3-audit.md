# Iteration 3 — AUDIT (search depth, Section J)

## 처리 범위

Section J (검색 깊이 4 row) 의 HIGH 갭 2건 + 부분 row 2건 closure.

- **J1 autocomplete (HIGH)**: `GET /search/suggest?q=` 신설 — 워크스페이스
  visible 채널 이름 + 멤버 username prefix-match. 60/min/user rate.
- **J3 filter (HIGH)**: `GET /search` 에 `senderId` / `since` / `until`
  / `hasAttachment` 쿼리 추가. service args + base CTE clause 분기.
- **J2 결과 navigation**: 기존 cursor 기반 (rank desc + createdAt desc)
  유지 — UI 측 키보드 nav 는 follow-up. 매트릭스 row 충족도 🟡 유지.
- **J4 highlight**: 기존 `ts_headline` `<mark>` 마크 + frontend
  sanitizer 가 cover. 코드블록 안 highlight 는 내용 자체에 markdown
  fence 가 들어있으면 자연스러움. 매트릭스 🟡 → 🟡 유지.

## row 상태 변화 (Section J)

| #   | Row                                         | iter 1 상태    | iter 3 상태            | 가중치 변화 |
| --- | ------------------------------------------- | -------------- | ---------------------- | ----------- |
| J1  | 검색 autocomplete                           | ❌ HIGH (0)    | 🟡 (0.5) **HIGH→해소** | +0.5        |
| J2  | 결과 navigation                             | 🟡 (0.5)       | 🟡 (0.5)               | 0           |
| J3  | filter (channel/sender/기간/has-attachment) | 🔵 HIGH (0.25) | 🟡 (0.5) **HIGH→해소** | +0.25       |
| J4  | 코드블록 / 멘션 highlight                   | 🟡 (0.5)       | 🟡 (0.5)               | 0           |

소계: 1.25 → **2.0 / 4** (= 50%, +18.75pp)

**HIGH 갭 12 → 10 (-2)**.

## API 변경

### 신규 endpoint

- `GET /search/suggest?q=&workspaceId=&limit=`
  - 응답: `{ channels: [{ id, name }], users: [{ id, username }] }`
  - rate: 60/min/user
  - validation: q (필수, 빈 trim 차단), workspaceId (필수), limit (1~20, default 5)

### 확장 endpoint

- `GET /search?q=&workspaceId=&channelId=&cursor=&limit=&senderId=&since=&until=&hasAttachment=`
  - 추가 query: `senderId` (UUID), `since` (ISO), `until` (ISO), `hasAttachment` (true/false/1/0)
  - validation: ISO 검증, since < until 검증, hasAttachment 임의값은 undefined
  - 기존 응답 schema 변화 없음 (filter 만 message 후보 줄임)

## DB / migration

- 추가 안 함 — 기존 `Message.search_tsv` GIN 인덱스 + `Attachment.messageId`
  인덱스 + `Message.authorId` 인덱스 이미 존재.

## 회귀 spec

| 신규 / 확장                      | Cases | 상태 |
| -------------------------------- | ----- | ---- |
| search.controller.spec.ts (신규) | +11   | ✅   |
| - filter params (J3)             | 6     | ✅   |
| - suggest endpoint (J1)          | 5     | ✅   |

## Score 재산정 (확장 매트릭스 96 row)

- iter 2 종료 row 합: 68.25 / 96
- Section J 변화: +0.75
- iter 3 종료 row 합: **69.0 / 96**
- 단순 score: 69.0 / 96 = **71.875%** (+0.78pp)
- HIGH×2 적용 (HIGH 12 → 10):
  effective denom = 96 + 10 = 106
  score: 69.0 / 106 = **65.09%** (+1.90pp)

iter 3 score recovery: **+0.78 ~ +1.90pp**. HIGH 2건 closure 가
HIGH×2 score 에 더 큰 효과 (denom 감소).

## DoD

- [x] J1 suggest endpoint + spec 5
- [x] J3 filter params + spec 6
- [x] HIGH 2건 (J1, J3) closure → 12 → 10
- [x] pnpm verify green (200 unit tests)
- [x] DS untouched

## 측정

- 영향 라인: ~120 (search.service ~80 + search.controller ~30 + spec)
- API 200 unit tests (이전 189 → +11)
- 신규 라우트 1, 확장 query param 4
