import { useState, type ReactNode } from 'react';
import {
  isSafeLinkUrl,
  type RichTextRoot,
  type RichTextNode,
  type InlineNode,
  type TextNode,
} from '@qufox/shared-types';
import type { CustomEmoji } from '../emojis/api';
import { CodeBlock } from './CodeBlock';

/**
 * S04 (FR-MSG-13) — mention 표시명 해석 룩업.
 *
 * 서버는 `@username` 을 `@{cuid2}` 토큰으로 정규화해 저장하므로 AST 의
 * `mention_user` 노드는 안정적인 userId(cuid2) 를 담습니다. review HIGH
 * 수정으로 서버가 정규화 시점에 해석한 username/channel name 을 노드에
 * `label` 로 함께 박아 두므로, 렌더러는 우선 그 label 을 씁니다. label 이
 * 없는 구(legacy) AST 는 본 룩업(워크스페이스 멤버 맵 userId→handle)으로
 * 표시명을 해석하고, 그래도 없으면 userId 로 폴백합니다(절대 빈 pill 금지).
 * channel 도 동일한 label→룩업→id 폴백 전략을 씁니다.
 */
export type MentionLookup = {
  /** userId(cuid2) → 표시명. 없으면 userId 폴백. */
  userName?: (userId: string) => string | undefined;
  /** channelId → 채널명. 없으면 channelId 폴백. */
  channelName?: (channelId: string) => string | undefined;
  /** roleId → 역할명. 없으면 roleId 폴백. */
  roleName?: (roleId: string) => string | undefined;
};

/**
 * S02 — contentAst(rich_text AST) 렌더러 (FR-MSG-01 / FR-MSG-20).
 *
 * carryover(S00) 교체분: 기존 parseContent.tsx 의 정규식 fencePattern
 * (O(n^2) ReDoS) 대신, 서버/클라가 공유하는 ReDoS-안전 파서
 * (`@qufox/shared-types` parseMrkdwn — 선형 단일 패스 + MRKDWN_PARSE_LIMITS
 * enforce)가 만든 AST 를 React 노드로 렌더합니다. 본 렌더러는 정규식
 * 백트래킹을 일절 쓰지 않으며, AST 트리를 1회 순회할 뿐입니다.
 *
 * XSS (FR-MSG-20): React 는 모든 text child / 속성을 자동 escape 하므로
 * `<script>` · `<img onerror>` 같은 입력은 literal 텍스트로 렌더됩니다
 * (`dangerouslySetInnerHTML` 미사용). 링크는 parse 단계에서 이미
 * sanitize 되지만, 렌더 단계에서도 `isSafeLinkUrl` 로 2차 방어해
 * 활성 스킴이면 href 를 `#` 으로 치환합니다. 모든 링크는
 * rel="noopener noreferrer" target="_blank".
 *
 * DS: 기존 `.qf-mention` / `.qf-code-inline` / `.qf-codeblock` /
 * `.qf-emoji-custom` 클래스를 재사용합니다. 스포일러는 DS 4 파일에 전용
 * 클래스가 없어 Tailwind utility(모두 DS 토큰 alias) + `.qf-spoiler` 훅
 * 클래스로 마스킹/reveal 을 구현합니다(raw hex/px 미사용).
 */
export function renderAst(
  ast: RichTextRoot | null | undefined,
  customEmojis?: Map<string, CustomEmoji>,
  mentions?: MentionLookup,
): ReactNode[] {
  if (!ast || ast.nodes.length === 0) return [];
  return ast.nodes.map((node, i) => renderBlock(node, `b-${i}`, customEmojis, mentions));
}

function renderBlock(
  node: RichTextNode,
  key: string,
  customEmojis?: Map<string, CustomEmoji>,
  mentions?: MentionLookup,
): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return (
        <p key={key} className="whitespace-pre-wrap break-words">
          {node.nodes.map((n, i) => renderInline(n, `${key}-i${i}`, customEmojis, mentions))}
        </p>
      );
    case 'heading': {
      // FR-MD-01 (S78 reviewer B1): PRD 명세 24/20/18px. 모두 tokens.css 에
      // 등록된 폰트 토큰을 씁니다 — 종전 h2 `--fs-17` 은 미등록 토큰이라
      // var() 가 빈 값으로 해석돼 글자 크기가 깨졌습니다.
      const cls =
        node.level === 1
          ? 'text-[length:var(--fs-24)] font-semibold'
          : node.level === 2
            ? 'text-[length:var(--fs-20)] font-semibold'
            : 'text-[length:var(--fs-18)] font-semibold';
      const children = node.nodes.map((n, i) =>
        renderInline(n, `${key}-i${i}`, customEmojis, mentions),
      );
      if (node.level === 1)
        return (
          <h1 key={key} className={cls}>
            {children}
          </h1>
        );
      if (node.level === 2)
        return (
          <h2 key={key} className={cls}>
            {children}
          </h2>
        );
      return (
        <h3 key={key} className={cls}>
          {children}
        </h3>
      );
    }
    case 'subtext':
      return (
        <p key={key} className="text-[length:var(--fs-11)] text-text-muted">
          {node.nodes.map((n, i) => renderInline(n, `${key}-i${i}`, customEmojis, mentions))}
        </p>
      );
    case 'blockquote':
      return (
        <blockquote
          key={key}
          className="my-[var(--s-1)] border-l-2 border-border-subtle pl-[var(--s-3)] text-text-secondary"
        >
          {node.nodes.map((n, i) => renderBlockOrInline(n, `${key}-c${i}`, customEmojis, mentions))}
        </blockquote>
      );
    case 'code_block':
      // S04 (FR-MSG-02 / FR-RC13): 언어 지정 시 highlight.js 클라 하이라이트,
      // 미지정/미지원이면 plain 폴백. 서버는 lang 만 보존.
      return <CodeBlock key={key} code={node.code} lang={node.lang} />;
    case 'list': {
      const items = node.items.map((it, i) => (
        <li key={`${key}-li${i}`}>
          {it.nodes.map((n, j) =>
            renderBlockOrInline(n, `${key}-li${i}-c${j}`, customEmojis, mentions),
          )}
        </li>
      ));
      return node.ordered ? (
        <ol key={key} className="ml-[var(--s-5)] list-decimal">
          {items}
        </ol>
      ) : (
        <ul key={key} className="ml-[var(--s-5)] list-disc">
          {items}
        </ul>
      );
    }
    case 'divider':
      return <hr key={key} className="my-[var(--s-2)] border-border-subtle" />;
    default:
      // inline node appearing at block level — render inline.
      return renderInline(node, key, customEmojis, mentions);
  }
}

/** blockquote / list item children can be either block or inline nodes. */
function renderBlockOrInline(
  node: RichTextNode,
  key: string,
  customEmojis?: Map<string, CustomEmoji>,
  mentions?: MentionLookup,
): ReactNode {
  const blockTypes = [
    'paragraph',
    'heading',
    'subtext',
    'blockquote',
    'code_block',
    'list',
    'divider',
  ];
  if (blockTypes.includes(node.type)) return renderBlock(node, key, customEmojis, mentions);
  return renderInline(node as InlineNode, key, customEmojis, mentions);
}

function renderInline(
  node: RichTextNode,
  key: string,
  customEmojis?: Map<string, CustomEmoji>,
  mentions?: MentionLookup,
): ReactNode {
  switch (node.type) {
    case 'text':
      return renderTextNode(node, key);
    case 'mention_user': {
      // FR-MSG-13 (review HIGH): 정규화로 저장된 @{cuid2} 를 표시명으로 해석.
      // 우선순위: AST 노드에 박힌 label(서버가 정규화 시점에 해석한 username)
      // → 런타임 룩업(워크스페이스 멤버 맵) → userId 폴백. label 이 있으면
      // 멤버 맵이 아직 도착하지 않아도 raw cuid 가 아니라 @username 을 그려
      // 라이브 렌더 회귀를 막습니다. 어떤 경우에도 빈 pill 은 금지합니다.
      const handle = node.label ?? mentions?.userName?.(node.userId) ?? node.userId;
      return (
        <span
          key={key}
          className="qf-mention"
          data-user-id={node.userId}
          aria-label={`멘션: @${handle}`}
        >
          @{handle}
        </span>
      );
    }
    case 'mention_channel': {
      // 동일 우선순위: 노드 label → 런타임 룩업 → channelId 폴백.
      const name = node.label ?? mentions?.channelName?.(node.channelId) ?? node.channelId;
      return (
        <span
          key={key}
          className="qf-mention"
          data-channel-id={node.channelId}
          aria-label={`채널: #${name}`}
        >
          #{name}
        </span>
      );
    }
    case 'mention_role': {
      // S88a (FR-MN-03): user/channel 과 동일 우선순위 — 노드 label(서버가 정규화
      // 시점에 박은 역할명) → 런타임 룩업(roleId→name) → roleId 폴백.
      const name = node.label ?? mentions?.roleName?.(node.roleId) ?? node.roleId;
      return (
        <span
          key={key}
          className="qf-mention"
          data-role-id={node.roleId}
          aria-label={`역할: @${name}`}
        >
          @{name}
        </span>
      );
    }
    case 'emoji': {
      const ce = customEmojis?.get(node.name);
      if (ce) {
        return (
          <img
            key={key}
            src={ce.url}
            alt={`:${ce.name}:`}
            title={`:${ce.name}:`}
            className="qf-emoji-custom"
            style={{
              display: 'inline-block',
              width: 20,
              height: 20,
              verticalAlign: 'text-bottom',
              objectFit: 'contain',
            }}
          />
        );
      }
      return <span key={key}>{`:${node.name}:`}</span>;
    }
    case 'link':
      return renderLink(node.url, node.text, key);
    default:
      return null;
  }
}

/** Apply text marks (bold/italic/strike/code/spoiler) as nested wrappers. */
function renderTextNode(node: TextNode, key: string): ReactNode {
  const marks = node.marks ?? [];
  // inline code: literal, no further mark wrapping needed beyond the code box.
  if (marks.includes('code')) {
    return (
      <code key={key} className="qf-code-inline">
        {node.text}
      </code>
    );
  }
  let el: ReactNode = node.text;
  // order doesn't matter for the visual marks; spoiler last so the toggle
  // wraps the styled content.
  if (marks.includes('strike')) el = <s className="line-through">{el}</s>;
  if (marks.includes('italic')) el = <em className="italic">{el}</em>;
  if (marks.includes('underline')) el = <u className="underline">{el}</u>;
  if (marks.includes('bold')) el = <strong className="font-semibold">{el}</strong>;
  if (marks.includes('spoiler')) {
    return <Spoiler key={key}>{el}</Spoiler>;
  }
  return <span key={key}>{el}</span>;
}

/**
 * FR-MSG-16 — 스포일러. 클릭 전 마스킹(qf-spoiler 훅 + Tailwind 토큰 alias),
 * 클릭 시 reveal, 재클릭 시 재마스킹. data-revealed 로 Playwright 가
 * 상태 전이를 관찰합니다.
 */
function Spoiler({ children }: { children: ReactNode }): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      className={
        revealed
          ? 'qf-spoiler cursor-pointer rounded-[var(--r-sm)]'
          : 'qf-spoiler cursor-pointer rounded-[var(--r-sm)] text-transparent'
      }
      // FR-MD-02 (S78 ui HIGH): 마스킹 배경. 종전 `bg-bg-strong` 은 tailwind
      // config 에 키가 없는 무효 유틸리티라 배경이 적용되지 않았고, `.qf-spoiler`
      // 는 DS 4파일에 정의가 없어 자체 background 도 제공하지 않았습니다. 등록
      // 토큰 `--n-6`(중성 강조 면)로 솔리드 마스킹 블록을 그려 reveal 전 텍스트가
      // 실제로 가려지게 합니다(text-transparent 와 함께).
      style={revealed ? undefined : { background: 'var(--n-6)' }}
      role="button"
      tabIndex={0}
      aria-label={revealed ? '스포일러 숨기기' : '스포일러 보기'}
      data-revealed={revealed ? 'true' : 'false'}
      onClick={() => setRevealed((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setRevealed((v) => !v);
        }
      }}
    >
      {children}
    </span>
  );
}

/**
 * 링크 렌더 + 2차 sanitize (FR-MSG-20). parse 단계에서 활성 스킴은 이미
 * 걸러지지만, hand-crafted AST 방어를 위해 렌더 단계에서도 isSafeLinkUrl
 * 로 검사해 위험하면 href 를 `#` 으로 치환합니다.
 */
function renderLink(url: string, text: string | null, key: string): ReactNode {
  const safe = isSafeLinkUrl(url);
  const href = safe ? url : '#';
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {text ?? url}
    </a>
  );
}
