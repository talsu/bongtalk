import { parse, type HTMLElement } from 'node-html-parser';

/**
 * task-045 iter2: OpenGraph + fallback 메타데이터 추출.
 *
 * 우선순위:
 *  - title: og:title > <title>
 *  - description: og:description > <meta name="description">
 *  - image: og:image > <meta name="twitter:image">
 *  - siteName: og:site_name > location.host (호출자 설정)
 *  - canonical: og:url > <link rel="canonical">
 *
 * 입력은 raw HTML 문자열. 256KB 까지만 (호출자가 자릅니다).
 * 출력은 모두 string | null — 비어있으면 null.
 */

export type OgMetadata = {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  canonical: string | null;
};

function pickMeta(root: HTMLElement, predicate: (el: HTMLElement) => boolean): string | null {
  const all = root.querySelectorAll('meta');
  for (const el of all) {
    if (predicate(el)) {
      const content = el.getAttribute('content');
      if (content) return content.trim();
    }
  }
  return null;
}

function attrEq(el: HTMLElement, attr: string, value: string): boolean {
  const v = el.getAttribute(attr);
  if (!v) return false;
  return v.trim().toLowerCase() === value.toLowerCase();
}

export function parseOgMetadata(html: string): OgMetadata {
  let root: HTMLElement;
  try {
    root = parse(html, { lowerCaseTagName: false, comment: false });
  } catch {
    return { title: null, description: null, image: null, siteName: null, canonical: null };
  }

  const ogTitle = pickMeta(root, (el) => attrEq(el, 'property', 'og:title'));
  const ogDescription = pickMeta(root, (el) => attrEq(el, 'property', 'og:description'));
  const ogImage = pickMeta(root, (el) => attrEq(el, 'property', 'og:image'));
  const ogSiteName = pickMeta(root, (el) => attrEq(el, 'property', 'og:site_name'));
  const ogUrl = pickMeta(root, (el) => attrEq(el, 'property', 'og:url'));

  // Fallbacks
  const titleEl = root.querySelector('title');
  const titleText = titleEl?.text?.trim() || null;
  const metaDesc = pickMeta(root, (el) => attrEq(el, 'name', 'description'));
  const twitterImage = pickMeta(root, (el) => attrEq(el, 'name', 'twitter:image'));
  const canonicalLink = root.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;

  return {
    title: ogTitle ?? titleText,
    description: ogDescription ?? metaDesc,
    image: ogImage ?? twitterImage,
    siteName: ogSiteName,
    canonical: ogUrl ?? (canonicalLink ? canonicalLink.trim() : null),
  };
}
