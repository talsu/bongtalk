/**
 * S80 (D15 / FR-SC-04·05·06) — 슬래시 커맨드 순수 변환 헬퍼.
 *
 * 부수효과 없는 변환/파싱 함수만 모은다(서비스가 DB/큐/presence 를 호출하기 전에 호출).
 * 단위 테스트가 고정 시간(vi.setSystemTime)으로 결정성을 검증할 수 있도록 now 를 인자로 받는다.
 */

// IN_CHANNEL 텍스트 변환에 덧붙이는 sigil(FR-SC-04).
const SHRUG = '¯\\_(ツ)_/¯';
const TABLEFLIP = '(╯°□°）╯︵ ┻━┻';
const UNFLIP = '┬─┬ ノ( ゜-゜ノ)';

/**
 * IN_CHANNEL 텍스트 변환(FR-SC-04). `/shrug`·`/tableflip`·`/unflip` 은 인자 뒤에 sigil 을
 * 덧붙이고, `/me` 는 본문을 마크다운 이탤릭(`_..._`)으로 감싸 me_message 로 렌더되게 한다
 * (FR-RC18 — renderAst 의 italic 마크 경로 재사용). 변환 불가 커맨드는 null.
 *
 * 결과 본문은 호출부에서 MessagesService.send 의 content 로 그대로 쓰인다(빈 본문 방지를
 * 위해 항상 비어 있지 않은 문자열을 돌려준다).
 */
export function transformInChannel(command: string, text: string): string | null {
  const body = text.trim();
  switch (command) {
    case 'shrug':
      return body.length > 0 ? `${body} ${SHRUG}` : SHRUG;
    case 'tableflip':
      return body.length > 0 ? `${body} ${TABLEFLIP}` : TABLEFLIP;
    case 'unflip':
      return body.length > 0 ? `${body} ${UNFLIP}` : UNFLIP;
    case 'me':
      // FR-RC18: me_message 는 이탤릭으로 렌더한다. mrkdwn `_..._` 가 renderAst 에서
      // <em className="italic"> 로 렌더되므로 본문을 이탤릭 마크로 감싼다. 본문이 비면
      // 변환 의미가 없으므로 null(상위에서 EPHEMERAL 에러 안내).
      return body.length > 0 ? `_${body}_` : null;
    default:
      return null;
  }
}

/**
 * `/dnd [기간]` 의 기간 파싱(FR-SC-05). 인자가 없으면 무기한(null), `30m`·`1h`·`2h`·
 * `tonight` 만 인식한다(chrono 불요 — 제한 토큰). `tonight` 은 사용자 tz 가 없으므로
 * UTC 기준 "오늘 23:59:59" 를 쓴다(근사 — presence DND 는 만료가 엄밀할 필요 없음).
 * 알 수 없는 토큰은 'invalid' 를 돌려 상위에서 EPHEMERAL 에러로 안내한다.
 *
 * 반환:
 *   { kind: 'indefinite' }           — 인자 없음(무기한 DND).
 *   { kind: 'until', until: Date }   — 만료 시각 지정.
 *   { kind: 'invalid' }              — 인식 불가 토큰.
 */
export type DndDuration =
  | { kind: 'indefinite' }
  | { kind: 'until'; until: Date }
  | { kind: 'invalid' };

export function parseDndDuration(text: string, now: Date): DndDuration {
  const token = text.trim().toLowerCase();
  if (token.length === 0) return { kind: 'indefinite' };
  const relative = token.match(/^(\d{1,3})\s*(m|min|minutes?|h|hours?)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const minutes = unit.startsWith('h') ? amount * 60 : amount;
    if (minutes <= 0) return { kind: 'invalid' };
    return { kind: 'until', until: new Date(now.getTime() + minutes * 60_000) };
  }
  if (token === 'tonight') {
    // 오늘 23:59:59(UTC). presence DND 만료는 분 단위 정확도면 충분(근사).
    const until = new Date(now);
    until.setUTCHours(23, 59, 59, 0);
    // 이미 자정 이후 새벽이면 "오늘 밤" 이 미래가 되도록 보장(now < until).
    if (until.getTime() <= now.getTime()) until.setUTCDate(until.getUTCDate() + 1);
    return { kind: 'until', until };
  }
  return { kind: 'invalid' };
}

/**
 * `/status` 인자 파싱(FR-SC-05). 선두 `:shortcode:` 또는 단일 유니코드 이모지를 emoji 로,
 * 나머지를 text 로 분리한다. 이모지가 없으면 emoji=null, 전체를 text 로 본다. 빈 인자면
 * 둘 다 null(상태 클리어 의도). CustomStatusService.set 에 그대로 넘긴다.
 */
export function parseStatusArgs(text: string): { emoji: string | null; text: string | null } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { emoji: null, text: null };
  // :shortcode: 선두 매칭.
  const shortcode = trimmed.match(/^(:[a-z0-9_+-]+:)\s*(.*)$/i);
  if (shortcode) {
    const rest = shortcode[2].trim();
    return { emoji: shortcode[1], text: rest.length > 0 ? rest : null };
  }
  return { emoji: null, text: trimmed };
}
