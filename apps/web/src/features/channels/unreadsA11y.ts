/**
 * S24 fix-forward (a11y BLOCKER #4/#5): Unreads/ChannelList 접근성 라벨 + 키보드
 * 판정의 단일 출처(테스트 대상 순수 로직). UI 컴포넌트가 이 함수들을 참조해
 * 라벨 문자열/키 판정을 일관되게 만든다.
 */

/** BLOCKER #5: 채널별 고유 "읽음 처리" 라벨(다중 동일 라벨 해소). */
export function markReadAriaLabel(channelName: string): string {
  return `# ${channelName} 읽음 처리`;
}

/** BLOCKER #4: 키보드로 컨텍스트 메뉴를 여는 키 조합인지 판정(ContextMenu / Shift+F10). */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}
