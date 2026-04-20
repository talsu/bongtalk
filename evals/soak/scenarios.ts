/**
 * Scenario definitions for the 48h staging soak. Each scenario is a tiny
 * state machine that the runner invokes on a schedule — no per-scenario
 * workers, everything runs from the main loop so we can see ordering
 * effects clearly in logs.
 */
import { randomUUID } from 'node:crypto';

export type Context = {
  baseUrl: string;
  wsUrl: string;
  /** Stamp for unique user/workspace names across runs. */
  runId: string;
  api: {
    signup: (
      email: string,
      username: string,
      password: string,
    ) => Promise<{ accessToken: string; userId: string }>;
    login: (email: string, password: string) => Promise<{ accessToken: string }>;
    createWorkspace: (token: string, slug: string) => Promise<{ id: string }>;
    createChannel: (
      token: string,
      wsId: string,
      name: string,
    ) => Promise<{ id: string; name: string }>;
    sendMessage: (
      token: string,
      wsId: string,
      chId: string,
      content: string,
      idempotencyKey?: string,
    ) => Promise<void>;
    invite: (token: string, wsId: string) => Promise<{ code: string }>;
    accept: (token: string, code: string) => Promise<void>;
    removeMember: (token: string, wsId: string, uid: string) => Promise<void>;
  };
};

export type Scenario = {
  name: string;
  everyMs: number;
  run: (ctx: Context) => Promise<void>;
};

/** A pool of re-usable actors + the current workspace/channel they live in. */
export type World = {
  owner: { token: string; userId: string } | null;
  workspaceId: string | null;
  channelId: string | null;
  members: Array<{ token: string; userId: string; email: string }>;
};

export function makeWorld(): World {
  return { owner: null, workspaceId: null, channelId: null, members: [] };
}

// ---- scenarios ----

export const steadyState = (world: World, intervalMs = 5_000): Scenario => ({
  name: 'steady-state',
  everyMs: intervalMs,
  run: async (ctx) => {
    if (!world.owner || !world.workspaceId || !world.channelId) return;
    const actor = world.members[Math.floor(Math.random() * Math.max(1, world.members.length))];
    const token = actor?.token ?? world.owner.token;
    await ctx.api.sendMessage(
      token,
      world.workspaceId,
      world.channelId,
      `tick ${new Date().toISOString()}`,
      randomUUID(),
    );
  },
});

export const channelChurn = (world: World, intervalMs = 10 * 60 * 1000): Scenario => ({
  name: 'channel-churn',
  everyMs: intervalMs,
  run: async (ctx) => {
    if (!world.owner || !world.workspaceId) return;
    // Create a new channel each tick. The message-send scenario picks a
    // random channel so traffic spreads over time.
    const channel = await ctx.api.createChannel(
      world.owner.token,
      world.workspaceId,
      `ch-${Date.now().toString(36).slice(-6)}`,
    );
    world.channelId = channel.id;
  },
});

export const memberChurn = (world: World, intervalMs = 3 * 60 * 1000): Scenario => ({
  name: 'member-churn',
  everyMs: intervalMs,
  run: async (ctx) => {
    if (!world.owner || !world.workspaceId) return;
    // Invite + accept a fresh member, then (random) kick one previous member.
    const inv = await ctx.api.invite(world.owner.token, world.workspaceId);
    const stamp = Date.now().toString(36);
    const email = `soak-${ctx.runId}-${stamp}@qufox.dev`;
    const u = await ctx.api.signup(email, `soak${stamp}`, 'Quanta-Beetle-Nebula-42!');
    await ctx.api.accept(u.accessToken, inv.code);
    world.members.push({ token: u.accessToken, userId: u.userId, email });
    // Trim — kick the oldest if we have more than 10 live members.
    if (world.members.length > 10) {
      const victim = world.members.shift();
      if (victim) {
        await ctx.api.removeMember(world.owner.token, world.workspaceId, victim.userId);
      }
    }
  },
});
