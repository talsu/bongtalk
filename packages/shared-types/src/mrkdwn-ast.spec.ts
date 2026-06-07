import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RichTextRootSchema,
  RichTextNodeSchema,
  TextNodeSchema,
  MentionUserNodeSchema,
  MentionChannelNodeSchema,
  MentionRoleNodeSchema,
  CodeBlockNodeSchema,
  DividerNodeSchema,
  LinkNodeSchema,
  isSafeLinkUrl,
  isRichTextRoot,
  type RichTextRoot,
} from './mrkdwn-ast';
import { MRKDWN_AST_NODE_TYPES } from './mrkdwn';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('RichTextRootSchema (D16 / FR-RC02)', () => {
  it('accepts an empty root', () => {
    const root = { type: 'root', nodes: [] };
    expect(() => RichTextRootSchema.parse(root)).not.toThrow();
  });

  it('accepts a paragraph with inline text marks', () => {
    const root: RichTextRoot = {
      type: 'root',
      nodes: [
        {
          type: 'paragraph',
          nodes: [{ type: 'text', text: 'hello', marks: ['bold', 'italic'] }],
        },
      ],
    };
    expect(() => RichTextRootSchema.parse(root)).not.toThrow();
  });

  it('rejects a root whose top-level type is not "root"', () => {
    expect(() => RichTextRootSchema.parse({ type: 'paragraph', nodes: [] })).toThrow();
  });

  it('accepts every D16 node type at least once', () => {
    expect(MRKDWN_AST_NODE_TYPES).toHaveLength(14);
  });

  it('lists divider in the canonical node-type contract (S00 single source)', () => {
    // reviewer S01 MAJOR: mrkdwn-ast.ts adds a DividerNode, so the S00
    // MRKDWN_AST_NODE_TYPES contract must include it — no split-brain.
    expect(MRKDWN_AST_NODE_TYPES).toContain('divider');
  });

  it('round-trips a divider block node inside a root', () => {
    const root = { type: 'root', nodes: [{ type: 'divider' }] };
    const parsed = RichTextRootSchema.parse(root);
    expect(parsed.nodes[0]).toEqual({ type: 'divider' });
    expect(() => DividerNodeSchema.parse({ type: 'divider' })).not.toThrow();
  });
});

describe('RichTextRootSchema parse limits (FR-MSG-23 / reviewer S01 MAJOR)', () => {
  it('rejects a tree deeper than MAX_DEPTH (nested blockquotes)', () => {
    // build a blockquote chain past MRKDWN_PARSE_LIMITS.MAX_DEPTH (10).
    let node: unknown = { type: 'paragraph', nodes: [{ type: 'text', text: 'x' }] };
    for (let i = 0; i < 30; i++) {
      node = { type: 'blockquote', nodes: [node] };
    }
    const root = { type: 'root', nodes: [node] };
    expect(RichTextRootSchema.safeParse(root).success).toBe(false);
    expect(isRichTextRoot(root)).toBe(false);
  });

  it('rejects a tree with more than MAX_NODES nodes', () => {
    const nodes = Array.from({ length: 600 }, () => ({ type: 'divider' }));
    const root = { type: 'root', nodes };
    expect(RichTextRootSchema.safeParse(root).success).toBe(false);
  });

  it('accepts a tree within the depth/node limits', () => {
    let node: unknown = { type: 'paragraph', nodes: [{ type: 'text', text: 'x' }] };
    for (let i = 0; i < 5; i++) {
      node = { type: 'blockquote', nodes: [node] };
    }
    const root = { type: 'root', nodes: [node] };
    expect(RichTextRootSchema.safeParse(root).success).toBe(true);
  });
});

describe('TextNodeSchema marks', () => {
  it('accepts the supported marks (bold/italic/underline/strike/code/spoiler)', () => {
    for (const mark of ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler'] as const) {
      expect(() => TextNodeSchema.parse({ type: 'text', text: 'x', marks: [mark] })).not.toThrow();
    }
  });

  it('defaults marks to [] when omitted', () => {
    const parsed = TextNodeSchema.parse({ type: 'text', text: 'plain' });
    expect(parsed.marks).toEqual([]);
  });

  it('rejects an unknown mark', () => {
    expect(() => TextNodeSchema.parse({ type: 'text', text: 'x', marks: ['blink'] })).toThrow();
  });
});

describe('MentionUserNodeSchema (FR-RC02)', () => {
  it('accepts a cuid2 userId', () => {
    expect(() =>
      MentionUserNodeSchema.parse({ type: 'mention_user', userId: 'clh3z2k0v0000abcd1234ef' }),
    ).not.toThrow();
  });

  it('rejects a non-cuid2 userId', () => {
    expect(() => MentionUserNodeSchema.parse({ type: 'mention_user', userId: 'BAD' })).toThrow();
  });

  // S04 review HIGH (FR-MSG-13): mention 노드에 optional label 을 additive 로
  // 추가합니다. 서버가 정규화 시점에 해석한 username 을 박아, 렌더러가 멤버 맵
  // 도착 전에도 raw cuid 대신 @username 을 그릴 수 있게 합니다.
  it('accepts an optional label alongside the userId (additive)', () => {
    const parsed = MentionUserNodeSchema.parse({
      type: 'mention_user',
      userId: 'clh3z2k0v0000abcd1234ef',
      label: 'alice',
    });
    expect(parsed.label).toBe('alice');
  });

  it('stays backward-compatible when label is omitted (legacy AST)', () => {
    const parsed = MentionUserNodeSchema.parse({
      type: 'mention_user',
      userId: 'clh3z2k0v0000abcd1234ef',
    });
    expect(parsed.label).toBeUndefined();
  });

  it('rejects an empty-string label (min length 1 — never an empty pill source)', () => {
    expect(() =>
      MentionUserNodeSchema.parse({
        type: 'mention_user',
        userId: 'clh3z2k0v0000abcd1234ef',
        label: '',
      }),
    ).toThrow();
  });
});

describe('MentionChannelNodeSchema label (S04 review HIGH / FR-MSG-13)', () => {
  it('accepts an optional channel-name label (additive)', () => {
    const parsed = MentionChannelNodeSchema.parse({
      type: 'mention_channel',
      channelId: 'clh3z2k0v0000abcd1234ef',
      label: 'general',
    });
    expect(parsed.label).toBe('general');
  });

  it('stays backward-compatible when label is omitted', () => {
    const parsed = MentionChannelNodeSchema.parse({
      type: 'mention_channel',
      channelId: 'clh3z2k0v0000abcd1234ef',
    });
    expect(parsed.label).toBeUndefined();
  });
});

describe('MentionRoleNodeSchema label (S88a / FR-MN-03)', () => {
  it('accepts an optional role-name label (additive)', () => {
    const parsed = MentionRoleNodeSchema.parse({
      type: 'mention_role',
      roleId: 'clh3z2k0v0000abcd1234ef',
      label: 'Project Managers',
    });
    expect(parsed.label).toBe('Project Managers');
  });

  it('stays backward-compatible when label is omitted (legacy AST)', () => {
    const parsed = MentionRoleNodeSchema.parse({
      type: 'mention_role',
      roleId: 'clh3z2k0v0000abcd1234ef',
    });
    expect(parsed.label).toBeUndefined();
  });

  it('rejects an empty-string label (min length 1)', () => {
    expect(() =>
      MentionRoleNodeSchema.parse({
        type: 'mention_role',
        roleId: 'clh3z2k0v0000abcd1234ef',
        label: '',
      }),
    ).toThrow();
  });

  // S88a review F1 (ADR D2): Role.id 는 @db.Uuid 라 roleId 는 uuid 도 수용해야
  // 한다. 종전 Cuid2Schema 전용이면 라이브 <@&uuid> 노드가 AST 검증서 거부됐다.
  it('accepts a uuid roleId (Role.id = @db.Uuid — transitional id)', () => {
    const parsed = MentionRoleNodeSchema.parse({
      type: 'mention_role',
      roleId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      label: 'Project Managers',
    });
    expect(parsed.roleId).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('still accepts a cuid2 roleId (legacy / non-uuid)', () => {
    const parsed = MentionRoleNodeSchema.parse({
      type: 'mention_role',
      roleId: 'clh3z2k0v0000abcd1234ef',
    });
    expect(parsed.roleId).toBe('clh3z2k0v0000abcd1234ef');
  });

  it('rejects a non-uuid / non-cuid2 roleId', () => {
    expect(() =>
      MentionRoleNodeSchema.parse({
        type: 'mention_role',
        roleId: 'not-an-id',
      }),
    ).toThrow();
  });
});

describe('CodeBlockNodeSchema', () => {
  it('accepts an optional lang', () => {
    expect(() =>
      CodeBlockNodeSchema.parse({ type: 'code_block', code: 'print(1)', lang: 'python' }),
    ).not.toThrow();
    expect(() => CodeBlockNodeSchema.parse({ type: 'code_block', code: 'plain' })).not.toThrow();
  });
});

describe('LinkNodeSchema url scheme allowlist (security S01 MED — XSS)', () => {
  it('accepts http(s) absolute urls', () => {
    expect(() =>
      LinkNodeSchema.parse({ type: 'link', url: 'https://example.com/a?b=1#c' }),
    ).not.toThrow();
    expect(() => LinkNodeSchema.parse({ type: 'link', url: 'http://example.com' })).not.toThrow();
  });
  it('accepts relative / anchor / protocol-relative urls', () => {
    for (const url of ['/path', './rel', '#anchor', '//cdn.example.com/x']) {
      expect(() => LinkNodeSchema.parse({ type: 'link', url })).not.toThrow();
    }
  });
  it('rejects active schemes (javascript/data/vbscript)', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:msgbox']) {
      expect(isSafeLinkUrl(url)).toBe(false);
      expect(() => LinkNodeSchema.parse({ type: 'link', url })).toThrow();
    }
  });
  it('rejects scheme with leading/trailing whitespace evasion', () => {
    expect(isSafeLinkUrl('  javascript:alert(1)')).toBe(false);
    expect(isSafeLinkUrl('\tdata:x')).toBe(false);
  });
});

describe('isRichTextRoot guard', () => {
  it('narrows a valid root', () => {
    expect(isRichTextRoot({ type: 'root', nodes: [] })).toBe(true);
  });
  it('returns false for junk', () => {
    expect(isRichTextRoot({ foo: 'bar' })).toBe(false);
    expect(isRichTextRoot(null)).toBe(false);
  });
});

describe('RichTextNodeSchema union', () => {
  it('discriminates a heading node with level', () => {
    expect(() =>
      RichTextNodeSchema.parse({
        type: 'heading',
        level: 2,
        nodes: [{ type: 'text', text: 'Title' }],
      }),
    ).not.toThrow();
  });
  it('rejects heading level outside 1..3', () => {
    expect(() => RichTextNodeSchema.parse({ type: 'heading', level: 4, nodes: [] })).toThrow();
  });
});
