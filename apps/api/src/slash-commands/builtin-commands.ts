import type { SlashCommandItem } from '@qufox/shared-types';

/**
 * S79 (D15 / FR-SC-01) — 빌트인 슬래시 커맨드 카탈로그 (NestJS 상수, Fork B = Option 1).
 *
 * 빌트인 커맨드는 DB 에 시드하지 않고 이 상수로만 제공한다. GET 목록 엔드포인트가
 * 이 배열과 워크스페이스 SlashCommand 테이블의 커스텀 행을 병합해 반환한다. id 는
 * `builtin:<name>` 합성 식별자라 커스텀(uuid)과 충돌하지 않으며, isBuiltin=true 로
 * 클라이언트가 구분한다.
 *
 * 값 집합 / responseType / handlerType 은 PRD D15 빌트인 상세 테이블과 1:1 정합한다.
 * S79 는 자동완성 표시/삽입까지만 다루므로(실행은 S80), 여기 등록은 "목록 노출" 만을
 * 의미한다 — 실제 실행 핸들러는 S80 에서 붙는다.
 *
 * `/giphy` 는 GIPHY_API_KEY env 가 설정된 경우에만 목록에 포함한다(PRD: NAS 기본
 * 비활성화, env-gated). buildBuiltinCommands() 가 이 게이트를 적용한 배열을 만든다.
 */

/** GIPHY env 미설정 시에도 항상 노출되는 빌트인 커맨드. */
const BASE_BUILTIN_COMMANDS: readonly SlashCommandItem[] = [
  {
    id: 'builtin:shrug',
    name: 'shrug',
    description: '메시지 끝에 ¯\\_(ツ)_/¯ 를 덧붙입니다',
    usageHint: '/shrug [메시지]',
    responseType: 'IN_CHANNEL',
    handlerType: 'BUILTIN',
    isBuiltin: true,
  },
  {
    id: 'builtin:tableflip',
    name: 'tableflip',
    description: '메시지 끝에 (╯°□°）╯︵ ┻━┻ 를 덧붙입니다',
    usageHint: '/tableflip [메시지]',
    responseType: 'IN_CHANNEL',
    handlerType: 'BUILTIN',
    isBuiltin: true,
  },
  {
    id: 'builtin:unflip',
    name: 'unflip',
    description: '메시지 끝에 ┬─┬ ノ( ゜-゜ノ) 를 덧붙입니다',
    usageHint: '/unflip [메시지]',
    responseType: 'IN_CHANNEL',
    handlerType: 'BUILTIN',
    isBuiltin: true,
  },
  {
    id: 'builtin:me',
    name: 'me',
    description: '액션 형식(이탤릭)으로 메시지를 보냅니다',
    usageHint: '/me [메시지]',
    responseType: 'IN_CHANNEL',
    handlerType: 'BUILTIN',
    isBuiltin: true,
  },
  {
    id: 'builtin:away',
    name: 'away',
    description: '내 상태를 자리 비움으로 바꿉니다',
    usageHint: '/away',
    responseType: 'EPHEMERAL',
    handlerType: 'INTERNAL_ACTION',
    isBuiltin: true,
  },
  {
    id: 'builtin:active',
    name: 'active',
    description: '내 상태를 온라인으로 바꿉니다',
    usageHint: '/active',
    responseType: 'EPHEMERAL',
    handlerType: 'INTERNAL_ACTION',
    isBuiltin: true,
  },
  {
    id: 'builtin:status',
    name: 'status',
    description: '커스텀 상태(이모지+텍스트)를 설정합니다',
    usageHint: '/status :이모지: [텍스트]',
    responseType: 'EPHEMERAL',
    handlerType: 'INTERNAL_ACTION',
    isBuiltin: true,
  },
  {
    id: 'builtin:dnd',
    name: 'dnd',
    description: '방해 금지(DND) 모드를 켭니다',
    usageHint: '/dnd [30m|1h|2h|tonight]',
    responseType: 'EPHEMERAL',
    handlerType: 'INTERNAL_ACTION',
    isBuiltin: true,
  },
  {
    id: 'builtin:remind',
    name: 'remind',
    description: '리마인더를 예약합니다',
    usageHint: '/remind [@사람] "할일" [시간]',
    responseType: 'EPHEMERAL',
    handlerType: 'INTERNAL_ACTION',
    isBuiltin: true,
  },
  {
    id: 'builtin:nick',
    name: 'nick',
    description: '이 워크스페이스에서의 닉네임을 바꿉니다',
    usageHint: '/nick [별명]',
    responseType: 'EPHEMERAL',
    handlerType: 'INTERNAL_ACTION',
    isBuiltin: true,
  },
  {
    id: 'builtin:shortcuts',
    name: 'shortcuts',
    description: '단축키 치트시트를 엽니다',
    usageHint: '/shortcuts',
    responseType: 'EPHEMERAL',
    handlerType: 'BUILTIN',
    isBuiltin: true,
  },
  {
    id: 'builtin:darkmode',
    name: 'darkmode',
    description: '다크/라이트 테마를 토글합니다',
    usageHint: '/darkmode',
    responseType: 'EPHEMERAL',
    handlerType: 'BUILTIN',
    isBuiltin: true,
  },
];

/**
 * GIPHY_API_KEY env 가 설정된 경우에만 노출되는 빌트인 커맨드. PRD: NAS 기본
 * 비활성화이며 외부 SaaS 호출 없이 기능이 완전 동작해야 하므로 게이트한다.
 * 실행(GIPHY 프록시)은 S81 — S79 는 자동완성 목록 노출만 다룬다.
 */
const GIPHY_COMMAND: SlashCommandItem = {
  id: 'builtin:giphy',
  name: 'giphy',
  description: 'GIF 를 검색해 미리보고 전송합니다',
  usageHint: '/giphy [키워드]',
  responseType: 'EPHEMERAL',
  handlerType: 'INTERNAL_ACTION',
  isBuiltin: true,
};

/** S80 실행 단계에서 참조할 전체 빌트인 이름 집합(테스트/검증 편의). */
export const BUILTIN_COMMAND_NAMES = [
  ...BASE_BUILTIN_COMMANDS.map((c) => c.name),
  GIPHY_COMMAND.name,
] as const;

/**
 * 게이트를 적용한 빌트인 커맨드 배열을 만든다. `/giphy` 는 giphyEnabled=true 일 때만
 * 포함한다. 호출부(서비스)가 `Boolean(process.env.GIPHY_API_KEY)` 로 게이트를 판정한다.
 */
export function buildBuiltinCommands(giphyEnabled: boolean): SlashCommandItem[] {
  const list = [...BASE_BUILTIN_COMMANDS];
  if (giphyEnabled) list.push(GIPHY_COMMAND);
  return list;
}
