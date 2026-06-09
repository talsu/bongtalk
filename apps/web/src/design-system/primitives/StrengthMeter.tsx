// AUTH-1 (PRD D18): 비밀번호 강도 미터. zxcvbn 등 무거운 의존성 없이 가벼운 휴리스틱
// (길이 + 문자클래스 다양성)으로 강도를 산출한다.
//
// ※ 백엔드 비밀번호 정책은 현재 "최소 8자"만 강제한다(packages/shared-types PasswordSchema
//   = z.string().min(8).max(128) · 문자클래스 요건 없음). 이 미터는 정책을 *대체하지 않고*
//   그 위에 권장 강도를 자문 표시할 뿐이다 — 정책을 통과하는 약한 비밀번호(예: '12345678')도
//   "약함"으로 안내해 더 강한 비밀번호를 유도한다. 시각 표현은 DS .qf-strength-meter
//   클래스(토큰 기반)에 위임한다.

/** 강도 단계. 빈 입력은 `empty`(미터 숨김), 그 외 3단계. */
export type PasswordStrength = 'empty' | 'weak' | 'ok' | 'strong';

/** 채워질 막대 개수(총 4칸)와 한국어 라벨까지 포함한 강도 평가 결과. */
export interface StrengthResult {
  strength: PasswordStrength;
  /** 채워지는 막대 수(0~4). */
  filledBars: number;
  /** `__label` 에 노출할 한국어 안내. 빈 입력이면 빈 문자열. */
  label: string;
}

const TOTAL_BARS = 4;

/**
 * 비밀번호 강도를 순수 함수로 산출한다(단위테스트 대상).
 *
 * 점수 기준:
 * - 길이: 8자 이상 +1, 12자 이상 +1 (누적)
 * - 문자클래스: 소문자/대문자/숫자/기호 충족 개수에서, 2종 이상 +1, 3종 이상 +1 (누적)
 *
 * 합산 점수(0~4)를 단계로 사상한다:
 * - 0~1 → weak, 2~3 → ok, 4 → strong
 *
 * (참고: 백엔드는 8자만 강제하므로 이 점수는 정책이 아니라 권장 강도 자문이다.)
 */
export function evaluatePasswordStrength(password: string): StrengthResult {
  if (password.length === 0) {
    return { strength: 'empty', filledBars: 0, label: '' };
  }

  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;

  const classes =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(password) ? 1 : 0);
  if (classes >= 2) score += 1;
  if (classes >= 3) score += 1;

  if (score <= 1) {
    return { strength: 'weak', filledBars: 1, label: '약함' };
  }
  if (score <= 3) {
    return { strength: 'ok', filledBars: score, label: '보통' };
  }
  return { strength: 'strong', filledBars: TOTAL_BARS, label: '강함 — 좋은 비밀번호예요' };
}

/**
 * 비밀번호 강도 미터. 입력값을 받아 실시간으로 강도를 시각화한다.
 *
 * a11y(HIGH-2): 라이브 영역(라벨 span·aria-live="polite")을 **빈 입력일 때도 DOM 에
 * 유지**한다 — 빈 입력에서 컴포넌트를 통째로 null 반환하면 첫 글자 입력(empty→weak)
 * 시점에 라이브 영역이 새로 삽입돼 일부 SR 이 그 첫 전환을 고지하지 않는다. 빈 입력이면
 * 막대 트랙과 `.qf-strength-meter` 시각 컨테이너 클래스만 빼고(시각 중립), 라벨은 빈
 * 텍스트로 자리만 지킨다. 라벨 텍스트는 단계가 바뀔 때만 변하므로 키 입력마다 과한
 * 낭독은 없다.
 */
export function StrengthMeter({ password }: { password: string }): JSX.Element {
  const { strength, filledBars, label } = evaluatePasswordStrength(password);
  const isEmpty = strength === 'empty';

  return (
    <div
      data-testid="strength-meter"
      data-strength={strength}
      className={isEmpty ? undefined : 'qf-strength-meter'}
    >
      {!isEmpty && (
        <div className="qf-strength-meter__track" aria-hidden="true">
          {Array.from({ length: TOTAL_BARS }, (_, i) => (
            <span
              key={i}
              data-testid="strength-bar"
              className={i < filledBars ? 'qf-strength-meter__bar is-on' : 'qf-strength-meter__bar'}
            />
          ))}
        </div>
      )}
      <span data-testid="strength-label" className="qf-strength-meter__label" aria-live="polite">
        {isEmpty ? '' : `비밀번호 강도: ${label}`}
      </span>
    </div>
  );
}
