/**
 * S47 (D06 / FR-MN-14): favicon + document.title 배지 — DOM 부수효과 단일 출처.
 *
 * favicon 규칙(PRD FR-MN-14 정본):
 *   - mentionCount > 0  → 숫자 배지(우상단 원 + 숫자, 99+ cap)
 *   - mentionCount == 0 && unreadCount > 0 → dot(우상단 점)
 *   - 둘 다 0 → 기본 favicon 으로 원복
 *
 * Canvas 로 기본 favicon 위에 오버레이를 그려 동적 favicon data URL 을 만든다.
 * 기본 favicon 이미지 로드 실패(테스트 jsdom 등)나 canvas 미지원 환경에서는
 * 오버레이를 건너뛰고 title 배지만 적용한다(우아한 강등).
 *
 * 순수 계산부(faviconBadgeMode / documentTitleText)는 React/DOM 없이 단위 검증한다.
 */

export type FaviconBadgeMode = 'none' | 'dot' | 'count';

/** favicon 표시 모드 결정(PRD 규칙). */
export function faviconBadgeMode(mentionCount: number, unreadCount: number): FaviconBadgeMode {
  if (mentionCount > 0) return 'count';
  if (unreadCount > 0) return 'dot';
  return 'none';
}

/** 99+ cap 의 배지 숫자 텍스트. */
export function badgeCountText(count: number): string {
  if (count <= 0) return '';
  if (count > 99) return '99+';
  return String(count);
}

/**
 * document.title 배지 텍스트. total > 0 이면 `(N) qufox`, 0 이면 `qufox`.
 * 99+ cap 적용.
 */
export function documentTitleText(total: number, base = 'qufox'): string {
  if (total <= 0) return base;
  const n = total > 99 ? '99+' : String(total);
  return `(${n}) ${base}`;
}

const DEFAULT_FAVICON = '/brand-assets/png/favicon-32.png';
const FAVICON_ID = 'qf-dynamic-favicon';

/** 현재 문서의 동적 favicon <link> 를 찾거나 만든다. */
function ensureFaviconLink(): HTMLLinkElement | null {
  if (typeof document === 'undefined') return null;
  let link = document.getElementById(FAVICON_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = FAVICON_ID;
    link.rel = 'icon';
    link.type = 'image/png';
    document.head.appendChild(link);
  }
  return link;
}

/**
 * DS 토큰값을 런타임에 읽어 canvas fillStyle 로 쓴다. canvas 는 CSS var 를 직접
 * 받지 못하므로 getComputedStyle 로 해석한다(raw hex 소스 금지 — DS 단일 출처 정합).
 * 해석 실패(테스트/SSR)시 fallback CSS var 토큰 문자열을 그대로 반환한다(브라우저는
 * 이를 currentColor 로 강등하지만, jsdom 단위 테스트는 canvas 미지원이라 미도달).
 */
function resolveToken(name: string, fallbackVar: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return `var(${fallbackVar})`;
  }
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || `var(${fallbackVar})`;
}

let baseImage: HTMLImageElement | null = null;

/** 기본 favicon 이미지를 1회 로드(캐시). 실패해도 reject 하지 않고 null 유지. */
function loadBaseImage(): Promise<HTMLImageElement | null> {
  if (baseImage) return Promise.resolve(baseImage);
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      baseImage = img;
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = DEFAULT_FAVICON;
  });
}

/**
 * favicon 을 모드에 맞게 그린다. mode='none' 이면 기본 favicon 경로로 원복한다.
 * canvas 미지원/이미지 로드 실패 시 조용히 통과(title 배지로 충분).
 */
export async function renderFavicon(mode: FaviconBadgeMode, mentionCount: number): Promise<void> {
  const link = ensureFaviconLink();
  if (!link) return;

  if (mode === 'none') {
    link.href = DEFAULT_FAVICON;
    return;
  }

  const canvas =
    typeof document !== 'undefined' && typeof document.createElement === 'function'
      ? document.createElement('canvas')
      : null;
  const ctx = canvas?.getContext?.('2d') ?? null;
  if (!canvas || !ctx) {
    // canvas 미지원(jsdom 등) → 기본 favicon 유지, title 배지로 강등.
    link.href = DEFAULT_FAVICON;
    return;
  }
  canvas.width = 32;
  canvas.height = 32;

  const img = await loadBaseImage();
  if (img) {
    ctx.drawImage(img, 0, 0, 32, 32);
  }

  // DS 토큰에서 배지 배경(danger)/텍스트 색을 해석(raw hex 소스 금지).
  const badgeBg = resolveToken('--danger-600', '--danger-600');
  const badgeFg = resolveToken('--text-onAccent', '--text-onAccent');

  if (mode === 'dot') {
    ctx.beginPath();
    ctx.arc(24, 8, 6, 0, Math.PI * 2);
    ctx.fillStyle = badgeBg;
    ctx.fill();
  } else if (mode === 'count') {
    const text = badgeCountText(mentionCount);
    ctx.beginPath();
    ctx.arc(22, 10, 10, 0, Math.PI * 2);
    ctx.fillStyle = badgeBg;
    ctx.fill();
    ctx.fillStyle = badgeFg;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 22, 11);
  }

  try {
    link.href = canvas.toDataURL('image/png');
  } catch {
    link.href = DEFAULT_FAVICON;
  }
}
