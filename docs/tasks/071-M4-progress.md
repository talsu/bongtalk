# 071-M4 진행 상황 (세션 핸드오프 문서)

> 단일 진실원. 계획 전문: `docs/tasks/071-mobile-uiux-overhaul.md` M4 절,
> 감사 근거: `docs/audits/2026-06-10-mobile-uiux-audit.md` D 절(D-1~59). 규약·검증·배포는
> M0~M3 과 동일 — **GitHub push-only, 게이트는 로컬**, 배포는 main 체크아웃에서 수동
> `sudo DEPLOY_PUSHER=... bash scripts/deploy/auto-deploy.sh`.
> 브랜치: feat/071-m4-prd (develop e3377b2 기점).
> ★게이트(리뷰 H-6 정정): 슬라이스가 **앱 코드 6파일도 변경**(검색 ?q=/게이트/더보기,
> 채널 시트 '읽음으로 표시', 시트 시각 헤더, YouTab 주석)하므로 코드 게이트 전체 적용 —
> 전체 모바일 e2e 스위트(신규 표면 단언 포함) + standalone verify + /prd/ 시각 프로브
>
> - 적대 리뷰(코드 3각도+문서 3각도) fix-forward.

## 범위 (071 M4 절 — PRD 개정: "PRD 자체가 UX에 악영향" D-1~59)

1. 탭바 카노니컬 통일 — §02 5탭(채팅·인박스·스레드·검색·나)으로 D02/D03/D06/D07/D09/
   D11/D12/D14/D17 일괄 정정.
2. 모바일 대체 인터랙션 표준 문구 신설(hover→롱프레스 시트, 우클릭→롱프레스 시트,
   드래그→순서 편집, 단축키→화면 내 진입점) + 해당 FR 전수 모바일 절(D-2·15·16·17·
   18·19·31·32·33·50·52).
3. 모바일 Enter 의미 명문화(Enter=줄바꿈·전송=버튼·enterKeyHint 옵션) (D-3·56).
4. iOS Web Push 전제(PWA 설치 요건) 문서화 (D-21·40·55).
5. 768px 경계 1px 정정·AC 뷰포트 390×844 표준화·과명세 완화(FR-IA-MOB-04a/FR-RS-07)·
   커스텀 상태 프리셋 단일화(D08 vs D14)·FR-IA-WS-02 vs 미읽 앵커 긴장 해소
   (D-5·6·9·14·38·41) + 멘션 정규식 uuid|cuid2 표기(M1 수리 정합).
6. fr-matrix 재감사 — 모바일 미충족 done 재분류(최소 FR-S07·P04·P17·PS-05),
   "done=양 플랫폼 AC 충족" 정의 강화.

## 청크 상태

| 청크 | 내용                                                              | 상태 | 커밋    |
| ---- | ----------------------------------------------------------------- | ---- | ------- |
| G1   | (정찰) 6영역 Workflow + 완전성 비평 — 라인 단위 수정 맵           | done | 138항목 |
| G2   | 탭바 카노니컬 통일(작업 1) + 구 모델 잔재 정정(M2/M3 실구현 정합) | done | b16d319 |
| G3   | 모바일 대체 인터랙션 표준 절 신설 + FR 전수 모바일 절(작업 2)     | done | b16d319 |
| G4   | Enter 의미 + iOS Web Push 전제(작업 3·4)                          | done | b16d319 |
| G5   | 경계/AC/과명세/프리셋/긴장 해소 + 멘션 정규식 표기(작업 5)        | done | b16d319 |
| G6   | fr-matrix 재감사·재분류(작업 6) + 동반 코드 보강 4건              | done | aba9141 |
| G7   | 게이트: e2e 스위트+/prd/ 프로브+verify+적대 리뷰 fix-forward      | done | 63477bf |
| G8   | develop 머지(ls-remote)→main 승격→수동 배포→/readyz→REPORT        | todo |         |

## 세션 진행 노트 (M4)

- G1 완료 — m4-prd-recon Workflow(6영역 138항목 + 비평: 누락 D 24건·충돌 8건·순서).
  비평 1단계 결정 5건 확정: (a)FR-RS-09 시트 항목 제공+코드 추가 (b)액션 시트
  목록=실구현 1:1·퀵반응 데스크톱3/모바일5 분리 (c)MOB-07=대체 인터랙션 표준·
  MOB-08=서버 메뉴 시트 (d)FR-MN-07 NotifLevel 후속 보류 (e)FR-RC16 (수정됨)
  배지 팝오버. (f)FR-IA-WS-02 첫 미읽 앵커 (g)뮤트 6종 단일.
- G2~G5 완료(b16d319) — m4-prd-edit Workflow(순차 6스테이지+검증): 탭바 13블록
  전원 5탭, FR-IA-MOB-07/08 신설, 모바일 절 전수(~150 Edit), Enter/iOS PWA,
  과명세 완화, 멘션 uuid|cuid2, replyToId 폐기, 횡단 뷰 매핑 표, changelog v4.
  HTML 파서 무결 검증 pass.
- G6 완료(aba9141) — csv status 정의 신설 + partial 7 + S10 P0 정정, 동반 코드:
  검색 ?q= 동기화/게이트 정렬/더보기/수식어 힌트, 채널 시트 '읽음으로 표시',
  YouTab 주석. 메모리 project_all_buildable_fr_done 개정(352/354 는 데스크톱 기준).
- G7 진행 — e2e 45/45 ×2(touch-target 1회 부하 flake, 단독 green) + /prd/ 프로브
  PASS(섹션 24·탭바 13·MOB-07/08·페이지 에러 0) + verify 19/19 + 적대 리뷰
  (6각도) 12 HIGH CONFIRMED 전부 fix-forward:
  ①FR-MN-14 탭바 배지 후속 한정+partial ②Undo 5초→8초 7곳 통일(서버 스냅샷
  TTL 5분 확인) ③본 문서 청크 표 갱신 ④⑧FR-S12 후속 한정+partial ⑤FR-S07
  복귀 AC 를 브라우저 back+?q= 복원으로 현실화+e2e ⑥게이트 서술 정정(코드
  포함) ⑦FR-MSG-10/12 시트 시각 헤더 **구현**(+FR-IA-MOB-05 목록 반영+e2e)
  ⑨FR-KS-01 동등 경로 = 채널 목록 필터+DM 슬롯으로 정정 ⑩FR-S01/S02 후속
  한정+partial ⑪Cmd+K→퀵스위처 전용(검색은 Cmd+G) 3곳 통일 ⑫Mock C 배지를
  채팅 탭으로 이동(카노니컬 표 정합). fr-matrix partial 계 11.
- 서브에이전트 브리프 필수 문구: "읽기 전용 — git checkout/branch 전환 금지" +
  "머지/배포/prod 접근 금지".
