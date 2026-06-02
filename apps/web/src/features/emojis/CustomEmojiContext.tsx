import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useCustomEmojis } from './useCustomEmojis';
import type { CustomEmoji } from './api';

/**
 * task-037-D: workspace-scoped custom emoji map. Exposed to message
 * rendering + picker + composer under a single React context so each
 * consumer doesn't have to invoke the React Query hook separately —
 * saves both the duplicate request volley and the effect ordering
 * churn when the same render tree reads the list in 3 places.
 *
 * `null` workspaceId (Global DM surface) → empty map; the parser
 * leaves `:name:` tokens as literal text. This matches the backend
 * scoping: emojis live on a workspace, and DMs have no workspace.
 */
export interface CustomEmojiLookup {
  byName: Map<string, CustomEmoji>;
  list: CustomEmoji[];
}

const EMPTY: CustomEmojiLookup = { byName: new Map(), list: [] };

const CustomEmojiCtx = createContext<CustomEmojiLookup>(EMPTY);

export function CustomEmojiProvider({
  workspaceId,
  children,
}: {
  workspaceId: string | null | undefined;
  children: ReactNode;
}): JSX.Element {
  const { data } = useCustomEmojis(workspaceId ?? null);
  const value = useMemo<CustomEmojiLookup>(() => {
    const list = data?.items ?? [];
    const byName = new Map<string, CustomEmoji>();
    for (const ce of list) {
      byName.set(ce.name, ce);
      // S42 (FR-EM07): 별칭도 byName 의 키로 등록해 `:alias:` 토큰이 파서에서 동일
      // 이모지 <img> 로 렌더되게 한다(parseContent 코드 무수정 목표 — 파서는 Map
      // 조회만 한다). canonical name 이 우선하도록, 별칭이 다른 이모지의 name 과
      // 충돌하면(서버가 이미 금지하므로 정상 데이터에서는 발생 안 함) name 매핑을
      // 덮어쓰지 않는다.
      for (const alias of ce.aliases ?? []) {
        if (!byName.has(alias)) byName.set(alias, ce);
      }
    }
    return { byName, list };
  }, [data?.items]);
  return <CustomEmojiCtx.Provider value={value}>{children}</CustomEmojiCtx.Provider>;
}

export function useCustomEmojiLookup(): CustomEmojiLookup {
  return useContext(CustomEmojiCtx);
}
