import type { Channel } from '@qufox/shared-types';
import type { IconName } from '../../design-system/primitives';

/**
 * 072-N3-4(리뷰): 채널 prefix 표현의 단일 출처. DraggableChannelRow·SectionChannelRow
 * 가 공유해 시각/SR 표기 불일치를 막는다(개인 섹션 행이 '#' 로 남던 회귀 수리).
 *
 * 비공개 → lock, 공지(ANNOUNCEMENT) → megaphone, 그 외 → '#'(텍스트 글리프).
 * SR 용 한글 단어(비공개/공지)도 함께 반환해 행 aria-label 이 채널 종류를 전달하게 한다.
 */
export type ChannelPrefixKind = 'private' | 'announcement' | 'text';

export function channelPrefixKind(channel: Pick<Channel, 'isPrivate' | 'type'>): ChannelPrefixKind {
  if (channel.isPrivate) return 'private';
  if (channel.type === 'ANNOUNCEMENT') return 'announcement';
  return 'text';
}

/** lock/megaphone 아이콘 이름. text 는 null(글리프 '#' 사용). */
export function channelPrefixIcon(kind: ChannelPrefixKind): IconName | null {
  if (kind === 'private') return 'lock';
  if (kind === 'announcement') return 'megaphone';
  return null;
}

/** SR/aria-label 용 채널 종류 단어. text 는 빈 문자열. */
export function channelTypeWord(kind: ChannelPrefixKind): string {
  if (kind === 'private') return '비공개';
  if (kind === 'announcement') return '공지';
  return '';
}

/** 행 네비게이션 aria-label("비공개 #foo 채널 열기"). 종류 없으면 "# foo 채널 열기". */
export function channelOpenLabel(channel: Pick<Channel, 'isPrivate' | 'type' | 'name'>): string {
  const word = channelTypeWord(channelPrefixKind(channel));
  return `${word ? `${word} ` : ''}# ${channel.name} 채널 열기`;
}
