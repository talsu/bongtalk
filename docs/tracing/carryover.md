# Carryover findings (슬라이스 리뷰에서 스코프 외로 발견 → 후속 슬라이스에서 처리)

| from | finding                                                                                                                                       | severity | 처리 슬라이스(예정)     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| S00  | channels.controller allowMask/denyMask class-validator 미적용 → ADMIN의 권한 상승 주입(`allowMask:-1`). DTO + `& ALL_PERMISSIONS` 마스킹 필요 | BLOCKER  | S12~S15 (D02 채널 권한) |
| S00  | apps/web parseContent.tsx fencePattern O(n²) ReDoS (닫는 fence 없을 때). MRKDWN_PARSE_LIMITS enforce 필요                                     | HIGH     | S02 (D01 mrkdwn 코어)   |
| S00  | apps/api ErrorCode enum에 PARSE_TIMEOUT/PARSE_DEPTH_EXCEEDED/PARSE_NODE_LIMIT/PARSE_AST_TOO_LARGE 누락(shared-types엔 존재) + HTTP 매핑       | HIGH     | S02 (D01 mrkdwn 코어)   |
