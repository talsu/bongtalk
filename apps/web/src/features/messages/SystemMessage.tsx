import type { MessageDto, MessageType } from '@qufox/shared-types';
import { Icon, type IconName } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { renderMessageContent } from './parseContent';

/**
 * S04 (FR-MSG-19 / FR-RC10) — 시스템 메시지 렌더.
 *
 * SYSTEM_* 타입 메시지는 아바타 없이 "아이콘 + 이탤릭 텍스트" 인라인 시스템
 * 행으로 표시합니다. 편집·삭제 컨텍스트 메뉴는 노출하지 않습니다(컴포넌트
 * 자체가 toolbar/dropdown 을 렌더하지 않음 — DOM 에 편집/삭제 노드 없음).
 * contentRaw 는 서버 생성 템플릿이라 그대로 표시합니다.
 *
 * 색조 변형(FR-MSG-19 표): BANNED 는 위험(danger), ARCHIVED 는 muted.
 * DS 토큰 alias(Tailwind) 만 사용하며 raw hex/px 는 쓰지 않습니다.
 */

type SystemMeta = { icon: IconName; tone: 'default' | 'danger' | 'muted' };

const SYSTEM_META: Record<Exclude<MessageType, 'DEFAULT'>, SystemMeta> = {
  SYSTEM_MEMBER_JOINED: { icon: 'user-plus', tone: 'default' },
  SYSTEM_MEMBER_LEFT: { icon: 'logout', tone: 'muted' },
  SYSTEM_MEMBER_BANNED: { icon: 'shield', tone: 'danger' },
  SYSTEM_PIN: { icon: 'pin', tone: 'default' },
  SYSTEM_CHANNEL_RENAME: { icon: 'edit', tone: 'default' },
  SYSTEM_CHANNEL_TOPIC_CHANGED: { icon: 'edit', tone: 'default' },
  SYSTEM_CHANNEL_ARCHIVED: { icon: 'folder', tone: 'muted' },
  SYSTEM_THREAD_BROADCAST: { icon: 'thread', tone: 'default' },
};

const TONE_CLASS: Record<SystemMeta['tone'], string> = {
  default: 'text-text-secondary',
  // S35 fix-forward (DS 토큰화): `qf-text-danger` 는 DS 미정의 유틸이라 색이 안
  // 먹었다. 등록된 --danger-400 토큰을 Tailwind arbitrary color 로 직접 적용한다
  // (raw hex 없음 — 토큰 참조). MessageItem.tsx 의 동일 클래스도 함께 교체한다.
  danger: 'text-[color:var(--danger-400)]',
  muted: 'text-text-muted',
};

export function SystemMessage({
  msg,
  onOpenThread,
  onDelete,
}: {
  msg: MessageDto;
  // S35 (FR-TH-06): broadcast 행 클릭 시 스레드를 연다(parentMessageId = 루트).
  onOpenThread?: (rootId: string) => void;
  // S51 (FR-PS-15): SYSTEM_PIN 행은 채널 멤버 누구나 삭제할 수 있다(Discord 방식).
  // 부모가 onDelete 를 전달하면(SYSTEM_PIN 행에 한해) 인라인 X 삭제 버튼을 노출한다.
  // 삭제해도 원본 핀은 유지된다(서버 게이트가 보장).
  onDelete?: () => void | Promise<void>;
}): JSX.Element {
  // S35 (FR-TH-06): broadcast 행은 일반 SYSTEM 템플릿 행과 달리, 채널에 게시된
  // 답글 본문 + "스레드에 답글" 레이블 + 루트 excerpt 를 보여주고 클릭 시
  // 스레드를 연다. type 은 SYSTEM_THREAD_BROADCAST 지만 콘텐츠는 답글 본문이다.
  if (msg.isBroadcast && msg.parentMessageId) {
    return (
      <BroadcastMessage
        msg={msg}
        onOpen={onOpenThread ? () => onOpenThread(msg.parentMessageId as string) : undefined}
      />
    );
  }

  const meta =
    msg.type !== 'DEFAULT'
      ? SYSTEM_META[msg.type]
      : { icon: 'info' as IconName, tone: 'default' as const };
  // 서버 생성 템플릿이 contentRaw 에 들어있고, 없으면 content 로 폴백.
  const text = msg.contentRaw ?? msg.content ?? '';
  return (
    <div
      data-testid={`msg-system-${msg.id}`}
      data-message-type={msg.type}
      role="status"
      className={cn(
        'qf-message qf-message--system flex items-center gap-[var(--s-2)] px-[var(--s-7)] py-[var(--s-1)] text-[length:var(--fs-13)] italic',
        TONE_CLASS[meta.tone],
      )}
    >
      <Icon name={meta.icon} size="sm" />
      <span data-testid={`msg-system-text-${msg.id}`}>{text}</span>
      <time className="qf-message__time not-italic" dateTime={msg.createdAt}>
        {new Date(msg.createdAt).toLocaleTimeString()}
      </time>
      {/* S51 (FR-PS-15): SYSTEM_PIN 행 인라인 삭제(X). 부모가 onDelete 를 전달한
         경우(SYSTEM_PIN 한정)만 노출 — 채널 멤버 누구나 삭제 가능하며 원본 핀은 유지. */}
      {onDelete && msg.type === 'SYSTEM_PIN' ? (
        <button
          type="button"
          data-testid={`msg-system-delete-${msg.id}`}
          onClick={() => void onDelete()}
          aria-label="시스템 메시지 삭제"
          className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm not-italic"
        >
          <Icon name="trash" size="sm" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * S35 (FR-TH-06): 채널 타임라인의 broadcast 행. "스레드에 답글" 레이블 +
 * 루트 메시지 excerpt(parentExcerpt) + 답글 본문(content)을 보여주고, 클릭하면
 * 스레드를 연다. DS 에 broadcast 전용 클래스가 없어 기존 `qf-message` 골격 +
 * DS 토큰 유틸로 구성한다(신규 DS 클래스/DS 파일 수정 없음 — raw hex/px 없음).
 * 삭제된 broadcast 는 본문이 마스킹(null)되어 placeholder 로 렌더한다.
 */
function BroadcastMessage({ msg, onOpen }: { msg: MessageDto; onOpen?: () => void }): JSX.Element {
  const clickable = !!onOpen && !msg.deleted;
  const Tag = clickable ? 'button' : 'div';
  // A-06/A-12: broadcast 버튼 aria-label 에 루트 excerpt 를 실어 어떤 스레드를
  // 여는지 스크린리더가 알 수 있게 한다. excerpt 가 없으면(삭제 루트 등) 일반
  // 레이블로 폴백한다.
  const openLabel = msg.parentExcerpt ? `스레드 열기: ${msg.parentExcerpt}` : '스레드 열기';
  return (
    <Tag
      data-testid={`msg-broadcast-${msg.id}`}
      data-message-type={msg.type}
      data-broadcast="true"
      type={clickable ? 'button' : undefined}
      onClick={clickable ? onOpen : undefined}
      // A-07: 활성 <button> 은 암묵 role=button 이므로 중복 role="button" 을 두지
      // 않는다. 비활성(삭제/onOpen 부재) <div> 도 role="status" 를 부여하지 않는다
      // — broadcast 행은 라이브 영역 알림이 아니라 정적 콘텐츠라 status 가 부적절
      // 했다(읽힐 때마다 스크린리더 announce 유발). role 없는 일반 콘텐츠로 둔다.
      aria-label={clickable ? openLabel : undefined}
      className={cn(
        'qf-message qf-message--system block w-full text-left',
        'px-[var(--s-7)] py-[var(--s-1)] text-[length:var(--fs-13)]',
        clickable ? 'cursor-pointer' : undefined,
      )}
    >
      <div className="flex items-center gap-[var(--s-2)] text-text-muted italic">
        <Icon name="thread" size="sm" />
        <span data-testid={`msg-broadcast-label-${msg.id}`}>스레드에 답글</span>
        {msg.parentExcerpt ? (
          <span data-testid={`msg-broadcast-excerpt-${msg.id}`} className="truncate">
            · {msg.parentExcerpt}
          </span>
        ) : null}
        <time className="qf-message__time not-italic" dateTime={msg.createdAt}>
          {new Date(msg.createdAt).toLocaleTimeString()}
        </time>
      </div>
      <div data-testid={`msg-broadcast-body-${msg.id}`} className="text-text">
        {msg.deleted ? (
          <span className="italic text-text-muted">(삭제된 메시지)</span>
        ) : (
          renderMessageContent(msg.content ?? '')
        )}
      </div>
    </Tag>
  );
}
