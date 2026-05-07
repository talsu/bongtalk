# Visual regression baseline (task 044)

Playwright `toHaveScreenshot()` baseline 모음. iteration 별 의도된 변경
시에만 `--update-snapshots` 으로 갱신하고, 그 외 변경은 BLOCKER 등급으로
처리합니다.

## Surface 목록

- 데스크톱: shell / channel-empty / channel-with-messages / DM list / DM thread / settings / discover
- 모바일 (375x667): home / DM list / channel / settings

## 갱신 정책

`visual-regression-scanner` subagent 가 의도 명확 판정 시에만 commit
`chore(visual-regression): update baseline @ <reason>` 로 분리합니다.

## 첫 baseline

baseline 캡처는 NAS 환경에 Playwright 브라우저가 설치되어 있는지에 따라
조건부로 진행합니다. Playwright 미설치 시 첫 iteration 에서 정성 평가로
대체하고 baseline 은 후속 iteration 에서 캡처합니다.
