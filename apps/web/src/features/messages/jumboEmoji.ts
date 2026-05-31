import type { RichTextRoot } from '@qufox/shared-types';

/**
 * S06 (FR-RC15, P2) — "이모지만 1~3개" 메시지 판정(클라이언트 전용 순수 함수).
 *
 * 메시지 본문이 이모지 1~3개로만 구성되면 본문 폰트를 32px(--fs-32)로
 * 확대(jumbo)합니다. 슬랙/디스코드의 큰 이모지 UX 와 동일하며, 판정은
 * contentAst(RichTextRoot) 구조로만 수행합니다.
 *
 * jumbo 조건(모두 충족):
 *   (a) 루트가 단일 paragraph 블록일 것(헤딩·코드블록·리스트 등 혼합 금지).
 *   (b) 그 paragraph 의 inline 자식이 공백-only text 노드를 제외하면 전부
 *       `type: 'emoji'` 노드일 것(텍스트·멘션·링크 혼합 시 false).
 *   (c) emoji 노드 수가 1 이상 3 이하일 것(0 개·4 개 이상 false).
 *
 * 유니코드/커스텀 공통 — EmojiNode 가 둘 다 표현하므로 customId 유무는 보지
 * 않습니다. contentAst 가 없는 legacy(content 평문) 행은 판정 대상이 아니며
 * 호출부에서 기본 크기로 폴백합니다(과확대 위험 회피).
 */
export function isJumboEmoji(ast: RichTextRoot | null | undefined): boolean {
  if (!ast || ast.nodes.length !== 1) return false;
  const block = ast.nodes[0];
  if (block.type !== 'paragraph') return false;

  let emojiCount = 0;
  for (const inline of block.nodes) {
    if (inline.type === 'emoji') {
      emojiCount += 1;
      continue;
    }
    // 공백-only text 노드(이모지 사이 띄어쓰기)는 무시.
    if (inline.type === 'text' && inline.text.trim().length === 0) {
      continue;
    }
    // 그 외 inline(텍스트/멘션/링크 등)이 섞이면 jumbo 아님.
    return false;
  }

  return emojiCount >= 1 && emojiCount <= 3;
}
