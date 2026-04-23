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
    for (const ce of list) byName.set(ce.name, ce);
    return { byName, list };
  }, [data?.items]);
  return <CustomEmojiCtx.Provider value={value}>{children}</CustomEmojiCtx.Provider>;
}

export function useCustomEmojiLookup(): CustomEmojiLookup {
  return useContext(CustomEmojiCtx);
}
