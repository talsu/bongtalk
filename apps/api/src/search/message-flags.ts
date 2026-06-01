import type { AttachmentKind } from '@prisma/client';
import type { RichTextRoot } from '@qufox/shared-types';

/**
 * S29 (FR-S05): 메시지 비정규화 검색 플래그(hasLink/hasImage/hasFile) 계산.
 *
 * send/edit 트랜잭션에서 1회 호출해 Message 행에 박습니다. hasLink 는 mrkdwn
 * AST 를 재귀 순회해 `link` 노드(파서가 allowlist 스킴만 link 로 인정)가 있으면
 * true. hasImage/hasFile 은 이 메시지에 연결될 첨부의 kind 집합에서 유도합니다.
 *
 * 순수 함수 — DB / 시계 의존 없음. 단위 테스트 cover.
 */

/** AST 어딘가에 `link` 노드가 있는지 재귀 탐색. */
export function astHasLink(ast: RichTextRoot | null | undefined): boolean {
  if (!ast) return false;
  // RichTextRoot 는 `nodes` 배열을 가진다. 형식 안전을 위해 unknown 으로
  // 좁혀 순회한다(임의 JSONB 입력에도 깨지지 않게).
  return nodesHaveLink((ast as { nodes?: unknown }).nodes);
}

// 각 노드는 `nodes`(paragraph/heading/subtext/blockquote) 또는 `items`(list →
// ListItem[] → item.nodes) 로 하위 노드를 품는다. 어떤 깊이든 type==='link'
// 이면 true.
function nodesHaveLink(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  for (const node of nodes) {
    if (nodeHasLink(node)) return true;
  }
  return false;
}

function nodeHasLink(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const rec = node as Record<string, unknown>;
  if (rec.type === 'link') return true;
  if (Array.isArray(rec.nodes) && nodesHaveLink(rec.nodes)) return true;
  if (Array.isArray(rec.items)) {
    for (const item of rec.items) {
      if (
        item !== null &&
        typeof item === 'object' &&
        nodesHaveLink((item as Record<string, unknown>).nodes)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** 첨부 kind 집합에서 hasImage / hasFile 유도(VIDEO 는 file 버킷 — has:video DEFER). */
export function flagsFromAttachmentKinds(kinds: readonly AttachmentKind[]): {
  hasImage: boolean;
  hasFile: boolean;
} {
  let hasImage = false;
  let hasFile = false;
  for (const k of kinds) {
    if (k === 'IMAGE') hasImage = true;
    else hasFile = true; // FILE | VIDEO
  }
  return { hasImage, hasFile };
}
