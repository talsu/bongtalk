import { useState, type ReactNode } from 'react';
import {
  isSafeLinkUrl,
  type RichTextRoot,
  type RichTextNode,
  type InlineNode,
  type TextNode,
} from '@qufox/shared-types';
import type { CustomEmoji } from '../emojis/api';

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
): ReactNode[] {
  if (!ast || ast.nodes.length === 0) return [];
  return ast.nodes.map((node, i) => renderBlock(node, `b-${i}`, customEmojis));
}

function renderBlock(
  node: RichTextNode,
  key: string,
  customEmojis?: Map<string, CustomEmoji>,
): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return (
        <p key={key} className="whitespace-pre-wrap break-words">
          {node.nodes.map((n, i) => renderInline(n, `${key}-i${i}`, customEmojis))}
        </p>
      );
    case 'heading': {
      const cls =
        node.level === 1
          ? 'text-[length:var(--fs-20)] font-semibold'
          : node.level === 2
            ? 'text-[length:var(--fs-17)] font-semibold'
            : 'text-[length:var(--fs-15)] font-semibold';
      const children = node.nodes.map((n, i) => renderInline(n, `${key}-i${i}`, customEmojis));
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
          {node.nodes.map((n, i) => renderInline(n, `${key}-i${i}`, customEmojis))}
        </p>
      );
    case 'blockquote':
      return (
        <blockquote
          key={key}
          className="my-[var(--s-1)] border-l-2 border-border-subtle pl-[var(--s-3)] text-text-secondary"
        >
          {node.nodes.map((n, i) => renderBlockOrInline(n, `${key}-c${i}`, customEmojis))}
        </blockquote>
      );
    case 'code_block':
      return (
        <pre key={key} className="qf-codeblock">
          {node.lang ? <span className="qf-codeblock__lang">{node.lang}</span> : null}
          <code>{node.code}</code>
        </pre>
      );
    case 'list': {
      const items = node.items.map((it, i) => (
        <li key={`${key}-li${i}`}>
          {it.nodes.map((n, j) => renderBlockOrInline(n, `${key}-li${i}-c${j}`, customEmojis))}
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
      return renderInline(node, key, customEmojis);
  }
}

/** blockquote / list item children can be either block or inline nodes. */
function renderBlockOrInline(
  node: RichTextNode,
  key: string,
  customEmojis?: Map<string, CustomEmoji>,
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
  if (blockTypes.includes(node.type)) return renderBlock(node, key, customEmojis);
  return renderInline(node as InlineNode, key, customEmojis);
}

function renderInline(
  node: RichTextNode,
  key: string,
  customEmojis?: Map<string, CustomEmoji>,
): ReactNode {
  switch (node.type) {
    case 'text':
      return renderTextNode(node, key);
    case 'mention_user':
      return (
        <span key={key} className="qf-mention" data-user-id={node.userId}>
          @{node.userId}
        </span>
      );
    case 'mention_channel':
      return (
        <span key={key} className="qf-mention" data-channel-id={node.channelId}>
          #{node.channelId}
        </span>
      );
    case 'mention_role':
      return (
        <span key={key} className="qf-mention" data-role-id={node.roleId}>
          @{node.roleId}
        </span>
      );
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
          : 'qf-spoiler cursor-pointer rounded-[var(--r-sm)] bg-bg-strong text-transparent'
      }
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
