/**
 * Single source of truth for the workspace permission matrix.
 * Both the table-driven integration test (`permissions.matrix.int.spec.ts`)
 * and the rendered docs table (`docs/tasks/002-workspace.md`) read from here.
 *
 * Outcome codes:
 *   '201'|'200'|'202'|'204' — success codes per endpoint
 *   '401'                    — unauthenticated
 *   '403:<code>'             — forbidden with a specific errorCode
 *   '404:<code>'             — not found / hidden
 *   '409:<code>' | '410:<code>' | '422:<code>' — structured
 */
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'NON_MEMBER' | 'ANON';
export type Outcome =
  | '200'
  | '201'
  | '202'
  | '204'
  | '401'
  | `403:${string}`
  | `404:${string}`
  | `409:${string}`
  | `410:${string}`
  | `422:${string}`;

export type MatrixEntry = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** `:id` is resolved to the workspace being tested; `:uid` to the target user. */
  path: string;
  description: string;
  /** If true, the target of the mutation is the caller themselves (e.g. self-leave). */
  selfTarget?: boolean;
  /** Per-role expected outcome. */
  roles: Record<Role, Outcome>;
};

export const PERMISSION_MATRIX: MatrixEntry[] = [
  {
    method: 'POST',
    path: '/workspaces',
    description: 'create workspace',
    roles: {
      ANON: '401',
      NON_MEMBER: '201',
      MEMBER: '201',
      ADMIN: '201',
      OWNER: '201',
    },
  },
  {
    method: 'GET',
    path: '/workspaces/:id',
    description: 'get workspace',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '200',
      ADMIN: '200',
      OWNER: '200',
    },
  },
  {
    method: 'PATCH',
    path: '/workspaces/:id',
    description: 'update workspace',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '403:WORKSPACE_INSUFFICIENT_ROLE',
      ADMIN: '200',
      OWNER: '200',
    },
  },
  {
    method: 'DELETE',
    path: '/workspaces/:id',
    description: 'soft delete workspace',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '403:WORKSPACE_INSUFFICIENT_ROLE',
      ADMIN: '403:WORKSPACE_INSUFFICIENT_ROLE',
      OWNER: '202',
    },
  },
  {
    method: 'GET',
    path: '/workspaces/:id/members',
    description: 'list members',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '200',
      ADMIN: '200',
      OWNER: '200',
    },
  },
  {
    method: 'PATCH',
    path: '/workspaces/:id/members/:uid/role',
    description: 'change member role (target a MEMBER, promote to ADMIN)',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '403:WORKSPACE_INSUFFICIENT_ROLE',
      ADMIN: '200',
      OWNER: '200',
    },
  },
  {
    method: 'DELETE',
    path: '/workspaces/:id/members/:uid',
    description: 'remove member (target a MEMBER)',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '403:WORKSPACE_INSUFFICIENT_ROLE',
      ADMIN: '204',
      OWNER: '204',
    },
  },
  {
    method: 'POST',
    path: '/workspaces/:id/members/me/leave',
    description: 'self-leave as MEMBER/ADMIN; OWNER must transfer first',
    selfTarget: true,
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '204',
      ADMIN: '204',
      OWNER: '409:WORKSPACE_OWNER_MUST_TRANSFER',
    },
  },
  {
    method: 'POST',
    path: '/workspaces/:id/transfer-ownership',
    description: 'transfer ownership to another admin/member',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '403:WORKSPACE_INSUFFICIENT_ROLE',
      ADMIN: '403:WORKSPACE_INSUFFICIENT_ROLE',
      OWNER: '200',
    },
  },
  {
    method: 'POST',
    path: '/workspaces/:id/invites',
    description: 'create invite',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '403:WORKSPACE_INSUFFICIENT_ROLE',
      ADMIN: '201',
      OWNER: '201',
    },
  },
  {
    method: 'GET',
    path: '/workspaces/:id/invites',
    description: 'list invites',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '403:WORKSPACE_INSUFFICIENT_ROLE',
      ADMIN: '200',
      OWNER: '200',
    },
  },
  // -------- Channels (task-003) --------
  {
    method: 'GET',
    path: '/workspaces/:id/channels',
    description: 'list channels',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '200',
      ADMIN: '200',
      OWNER: '200',
    },
  },
  {
    method: 'POST',
    path: '/workspaces/:id/channels',
    description: 'create channel',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '403:WORKSPACE_INSUFFICIENT_ROLE',
      ADMIN: '201',
      OWNER: '201',
    },
  },
  {
    method: 'POST',
    path: '/workspaces/:id/categories',
    description: 'create category',
    roles: {
      ANON: '401',
      NON_MEMBER: '404:WORKSPACE_NOT_MEMBER',
      MEMBER: '403:WORKSPACE_INSUFFICIENT_ROLE',
      ADMIN: '201',
      OWNER: '201',
    },
  },
];
