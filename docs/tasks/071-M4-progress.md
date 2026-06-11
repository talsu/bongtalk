# 071-M4 진행 상황 (세션 핸드오프 문서)

> 단일 진실원. 계획 전문: `docs/tasks/071-mobile-uiux-overhaul.md` M4 절,
> 감사 근거: `docs/audits/2026-06-10-mobile-uiux-audit.md` D 절(D-1~59). 규약·검증·배포는
> M0~M3 과 동일 — **GitHub push-only, 게이트는 로컬**, 배포는 main 체크아웃에서 수동
> `sudo DEPLOY_PUSHER=... bash scripts/deploy/auto-deploy.sh`.
> 브랜치: feat/071-m4-prd (develop e3377b2 기점).
> ★주의: 대상이 문서(PRD 정적 HTML + fr-matrix.csv)라 코드 게이트는 가볍다 —
> standalone verify(문서 변경 무영향 확인) + PRD 페이지 시각 프로브(/prd/ 렌더 확인)
>
> - 적대 리뷰(문서 정합 — 구현·감사·계획 3자 대조)로 대체한다.

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

| 청크 | 내용                                                              | 상태 | 커밋 |
| ---- | ----------------------------------------------------------------- | ---- | ---- |
| G1   | (정찰) 6영역 Workflow + 완전성 비평 — 라인 단위 수정 맵           | 진행 |      |
| G2   | 탭바 카노니컬 통일(작업 1) + 구 모델 잔재 정정(M2/M3 실구현 정합) | todo |      |
| G3   | 모바일 대체 인터랙션 표준 절 신설 + FR 전수 모바일 절(작업 2)     | todo |      |
| G4   | Enter 의미 + iOS Web Push 전제(작업 3·4)                          | todo |      |
| G5   | 경계/AC/과명세/프리셋/긴장 해소 + 멘션 정규식 표기(작업 5)        | todo |      |
| G6   | fr-matrix 재감사·재분류(작업 6)                                   | todo |      |
| G7   | 게이트: /prd/ 시각 프로브 + standalone verify + 적대 문서 리뷰    | todo |      |
| G8   | develop 머지(ls-remote)→main 승격→수동 배포→/readyz→REPORT        | todo |      |

## 세션 진행 노트 (M4)

- (착수) M3 종결(main 50d2b24+4cb3c58 · 배포 exit 0 · readyz ok) 직후. G1 정찰
  Workflow(m4-prd-recon — 6영역+비평) 가동.
- 서브에이전트 브리프 필수 문구: "읽기 전용 — git checkout/branch 전환 금지" +
  "머지/배포/prod 접근 금지".
