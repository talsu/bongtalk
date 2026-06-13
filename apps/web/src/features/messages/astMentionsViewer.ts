/**
 * 072-N0 (N0-3 · 감사 D01 3335 / D16 16313): 뷰어 멘션 판정 공용 유틸.
 *
 * 071-M1 D1 에서 MobileMessages 내부에 있던 동일 워커를 features/messages 로
 * 끌어올려 데스크톱(MessageItem)·모바일(MobileMessages)이 한 구현을 공유한다.
 * 동작은 071 원본과 100% 동일하다(모바일 회귀 금지) — contentAst 를 1회 순회해
 * mention_user(내 id)가 있으면 true. AST 스키마에 의존하지 않는 관대한 워커라
 * 노드 모양 변화에도 안전하며, guard(5_000)로 순환/거대 트리를 방어한다.
 */
export function astMentionsViewer(ast: unknown, meId: string | undefined): boolean {
  if (!ast || !meId) return false;
  const stack: unknown[] = [ast];
  let guard = 0;
  while (stack.length > 0 && guard < 5_000) {
    guard += 1;
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (typeof node !== 'object' || node === null) continue;
    const rec = node as Record<string, unknown>;
    if (rec.type === 'mention_user' && rec.userId === meId) return true;
    for (const v of Object.values(rec)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}
