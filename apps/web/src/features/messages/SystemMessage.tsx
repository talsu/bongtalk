import type { MessageDto, MessageType } from '@qufox/shared-types';
import { Icon, type IconName } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

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
  danger: 'qf-text-danger',
  muted: 'text-text-muted',
};

export function SystemMessage({ msg }: { msg: MessageDto }): JSX.Element {
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
    </div>
  );
}
