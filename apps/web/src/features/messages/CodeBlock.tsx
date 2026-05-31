import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';

/**
 * S04 (FR-MSG-02 / FR-RC13) — 코드블록 syntax highlighting.
 *
 * 서버 파서는 코드블록의 `lang` 만 보존하고(highlight 미수행), 클라이언트가
 * highlight.js 로 토큰을 색칠합니다. 지원 언어를 지정하면 highlight 된 HTML 을,
 * 언어 생략/미지원이면 plain 고정폭 폰트로 폴백합니다(FR-MSG-02).
 *
 * 보안(XSS): highlight.js 의 `highlight()` 는 입력을 자체 escape 한 후 `<span
 * class="hljs-*">` 마크업만 생성하므로 안전하게 `dangerouslySetInnerHTML`
 * 로 주입합니다. 미지원/미지정 언어 경로는 React text child(자동 escape)로
 * 렌더하며 dangerouslySetInnerHTML 을 쓰지 않습니다. 즉 신뢰 경계는 highlight.js
 * 출력에 한정됩니다.
 *
 * 번들: 언어를 lazy 등록하지 않고 자주 쓰는 코어 언어만 정적 등록합니다.
 * highlight.js/lib/core 는 언어 무등록 시 ~수십 KB 로 작고, 등록 언어만
 * 트리쉐이킹됩니다. 미등록 언어가 lang 으로 와도 plain 폴백이라 안전합니다.
 */

// 자주 쓰이는 언어만 정적 등록(트리쉐이킹). 미등록 언어는 plain 폴백.
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('java', java);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('yaml', yaml);
}

// 흔한 별칭 → 등록 언어 매핑. 미등록이면 plain 폴백.
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  html: 'xml',
  htm: 'xml',
  yml: 'yaml',
  golang: 'go',
  rs: 'rust',
};

function resolveLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  const resolved = LANG_ALIAS[lower] ?? lower;
  return hljs.getLanguage(resolved) ? resolved : null;
}

export function CodeBlock({ code, lang }: { code: string; lang?: string | null }): JSX.Element {
  ensureRegistered();
  const resolved = resolveLang(lang);

  // highlighted HTML (지원 언어) 또는 null(plain 폴백). useMemo 로 동일 입력
  // 재하이라이트를 방지합니다.
  const highlighted = useMemo<string | null>(() => {
    if (!resolved) return null;
    try {
      return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [code, resolved]);

  return (
    <pre
      className="qf-codeblock"
      data-lang={lang ?? undefined}
      data-highlighted={highlighted ? 'true' : 'false'}
    >
      {lang ? <span className="qf-codeblock__lang">{lang}</span> : null}
      {highlighted ? (
        // highlight.js 출력만 주입 — 입력은 highlight.js 가 자체 escape 함.
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        // plain 폴백 — React text child 자동 escape (FR-MSG-02 / FR-MSG-20).
        <code>{code}</code>
      )}
    </pre>
  );
}
