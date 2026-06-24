// task-078 (Family SSO / OIDC IdP): OIDC interaction(로그인/동의) 브리지.
//
// oidc-provider 는 interaction UI 를 직접 제공하지 않는다 — /authorize 가 로그인/동의가
// 필요하면 interactions.url(=/interaction/:uid)로 브라우저를 보내고, 우리가 그 화면을
// 처리한 뒤 interactionFinished 로 /authorize 를 재개시킨다.
//
// 로그인은 qufox 의 AuthService.verifyCredentials 를 그대로 호출한다 — IP/email rate-limit,
// 계정 잠금, argon2, deactivation 차단을 전부 재사용하되 *qufox refresh 세션은 만들지 않는다*
// (RP 가 자체 세션을 가짐). 동의는 first-party 신뢰 클라이언트라 자동 grant 한다.
//
// CSRF 는 oidc-provider 의 interaction 쿠키(sso_interaction)로 보호된다 — interactionDetails
// 가 그 쿠키로 POST 를 해당 interaction 에 묶는다.
import express from 'express';
import type { Router, Request, Response } from 'express';
import type { AuthService } from '../auth/auth.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { logger } from '../common/logging/logger';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function authErrorMessage(err: unknown): string {
  if (err instanceof DomainError) {
    switch (err.code) {
      case ErrorCode.AUTH_ACCOUNT_LOCKED:
        return '반복된 로그인 실패로 계정이 잠시 잠겼습니다. 잠시 후 다시 시도해 주세요.';
      case ErrorCode.ACCOUNT_DEACTIVATED:
        return '비활성화된 계정입니다. qufox.com 에서 계정을 먼저 복구해 주세요.';
      case ErrorCode.RATE_LIMITED:
        return '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
      default:
        return '이메일 또는 비밀번호가 올바르지 않습니다.';
    }
  }
  return '로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.';
}

// design.qufox.com(DS) "Auth — Login" 패턴에 충실한 SSO 로그인 화면. DS CSS(tokens/components/
// icons)를 직접 link 하고 정규 심볼(brand-assets/svg/fox-symbol-dark.svg)을 쓴다 — 패밀리 전
// 사이트가 보는 공용 로그인 얼굴이라 DS 단일 소스로 통일한다. helmet 우회 host 라 인라인 자동
// 스타일 없음(클래스 + var(--token)만).
function renderLogin(uid: string, clientId: string, error: string | null): string {
  const safeUid = escapeHtml(uid);
  const safeClient = escapeHtml(clientId ?? '');
  const sub = safeClient
    ? `<strong>${safeClient}</strong> 에 연결할 계정으로 로그인하세요.`
    : '패밀리 서비스에 연결할 계정으로 로그인하세요.';
  const errorHtml = error
    ? `<div class="qf-notice qf-notice--danger" role="alert" style="margin-bottom:var(--s-5);"><span class="qf-notice__icon" aria-hidden="true">⚠</span><div class="qf-notice__body">${escapeHtml(error)}</div></div>`
    : '';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qufox 패밀리 로그인</title>
<link rel="icon" href="https://design.qufox.com/brand-assets/svg/fox-symbol-dark.svg" type="image/svg+xml">
<link rel="preconnect" href="https://design.qufox.com">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://design.qufox.com/tokens.css">
<link rel="stylesheet" href="https://design.qufox.com/components.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>
  body { margin:0; min-height:100vh; background:var(--bg-app); display:flex; align-items:center; justify-content:center; padding:var(--s-6); }
</style>
</head>
<body>
  <main class="qf-card" style="width:100%;max-width:380px;box-shadow:var(--elev-2);">
    <div class="qf-card__body" style="padding:var(--s-8);">
      <div style="display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:var(--s-7);">
        <img src="https://design.qufox.com/brand-assets/svg/fox-symbol-dark.svg" alt="" width="48" height="48" style="margin-bottom:var(--s-4);">
        <span class="qf-eyebrow" style="margin-bottom:var(--s-2);">qufox 패밀리 로그인</span>
        <h1 style="margin:0;font-size:var(--fs-24);font-weight:600;letter-spacing:var(--tracking-tight);color:var(--text-strong);">다시 만나 반가워요</h1>
        <p style="margin:var(--s-2) 0 0;font-size:var(--fs-13);color:var(--text-muted);">${sub}</p>
      </div>
      ${errorHtml}
      <form method="post" action="/interaction/${safeUid}/login" autocomplete="on" style="display:flex;flex-direction:column;gap:var(--s-5);">
        <label class="qf-field">
          <span class="qf-field__label">이메일</span>
          <input class="qf-input" name="email" type="email" autocomplete="username" placeholder="you@example.com" required autofocus>
        </label>
        <label class="qf-field">
          <span class="qf-field__label">비밀번호</span>
          <input class="qf-input" name="password" type="password" autocomplete="current-password" required>
        </label>
        <button class="qf-btn qf-btn--primary qf-btn--lg" type="submit" style="width:100%;">로그인</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

// ★P2-acl: 인증은 됐지만 이 RP 에 승인되지 않은 사용자에게 보여주는 DS 스타일 안내. 코드/세션을
// 발급하지 않고 "승인 필요"를 알린다. "다른 계정으로 로그인"은 IdP 세션을 끝낸다(/session/end).
function renderNotApproved(clientId: string): string {
  const safeClient = escapeHtml(clientId ?? '');
  const appLabel = safeClient ? `<strong>${safeClient}</strong>` : '이 서비스';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>접근 권한 없음 — qufox 패밀리</title>
<link rel="icon" href="https://design.qufox.com/brand-assets/svg/fox-symbol-dark.svg" type="image/svg+xml">
<link rel="preconnect" href="https://design.qufox.com">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://design.qufox.com/tokens.css">
<link rel="stylesheet" href="https://design.qufox.com/components.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>
  body { margin:0; min-height:100vh; background:var(--bg-app); display:flex; align-items:center; justify-content:center; padding:var(--s-6); }
</style>
</head>
<body>
  <main class="qf-card" style="width:100%;max-width:380px;box-shadow:var(--elev-2);">
    <div class="qf-card__body" style="padding:var(--s-8);">
      <div style="display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:var(--s-7);">
        <img src="https://design.qufox.com/brand-assets/svg/fox-symbol-dark.svg" alt="" width="48" height="48" style="margin-bottom:var(--s-4);">
        <span class="qf-eyebrow" style="margin-bottom:var(--s-2);">qufox 패밀리</span>
        <h1 style="margin:0;font-size:var(--fs-24);font-weight:600;letter-spacing:var(--tracking-tight);color:var(--text-strong);">접근 권한이 없어요</h1>
        <p style="margin:var(--s-2) 0 0;font-size:var(--fs-13);color:var(--text-muted);">로그인은 되었지만 이 계정은 ${appLabel} 사용이 승인되지 않았습니다. 관리자에게 접근 승인을 요청해 주세요.</p>
      </div>
      <a class="qf-btn qf-btn--secondary qf-btn--lg" href="/session/end?client_id=${safeClient}" style="width:100%;display:block;box-sizing:border-box;text-align:center;text-decoration:none;">다른 계정으로 로그인</a>
    </div>
  </main>
</body>
</html>`;
}

async function autoGrantConsent(
  provider: any,
  req: Request,
  res: Response,
  details: any,
): Promise<void> {
  const { prompt, params, session, grantId } = details;
  // first-party 신뢰 클라이언트 — 요청 scope/claim 을 자동 허용한다(동의 화면 생략).
  let grant: any = grantId ? await provider.Grant.find(grantId) : undefined;
  if (!grant) {
    grant = new provider.Grant({ accountId: session?.accountId, clientId: params.client_id });
  }
  const d = prompt.details ?? {};
  if (d.missingOIDCScope) {
    grant.addOIDCScope((d.missingOIDCScope as string[]).join(' '));
  }
  if (d.missingOIDCClaims) {
    grant.addOIDCClaims(d.missingOIDCClaims as string[]);
  }
  if (d.missingResourceScopes) {
    for (const [indicator, scopes] of Object.entries(
      d.missingResourceScopes as Record<string, string[]>,
    )) {
      grant.addResourceScope(indicator, scopes.join(' '));
    }
  }
  const newGrantId = await grant.save();
  await provider.interactionFinished(
    req,
    res,
    { consent: { grantId: newGrantId } },
    { mergeWithLastSubmission: true },
  );
}

export function buildInteractionRouter(
  provider: any,
  authService: AuthService,
  isApproved: (clientId: string, userId: string) => Promise<boolean>,
): Router {
  const router = express.Router();
  // ★(reviewer M1): 폼 파서를 라우터 전역(router.use)이 아닌 로그인 POST 에만 건다 — /token
  // 등 oidc-provider 자체 엔드포인트의 body 를 우리가 먼저 파싱해 "discouraged upstream
  // parser" 경로로 떨어지는 것을 막는다.
  const parseForm = express.urlencoded({ extended: false });

  router.get('/interaction/:uid', async (req: Request, res: Response) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const { prompt, params } = details;
      if (prompt.name === 'login') {
        res.set('content-type', 'text/html; charset=utf-8');
        res.set('cache-control', 'no-store');
        res.end(renderLogin(details.uid, params.client_id, null));
        return;
      }
      if (prompt.name === 'consent') {
        // ★P2-acl: 로그인 프롬프트가 생략된(이미 IdP 세션 보유) 사용자도 여기서 인가 확인.
        const sub = details.session?.accountId;
        if (sub && !(await isApproved(params.client_id, sub))) {
          res.status(403);
          res.set('content-type', 'text/html; charset=utf-8');
          res.set('cache-control', 'no-store');
          res.end(renderNotApproved(params.client_id));
          return;
        }
        await autoGrantConsent(provider, req, res, details);
        return;
      }
      res.status(400).end(`unsupported interaction prompt: ${escapeHtml(String(prompt.name))}`);
    } catch (err) {
      logger.error({ err }, 'oidc interaction GET failed');
      if (!res.headersSent) {
        res.status(500).end('interaction error');
      }
    }
  });

  router.post('/interaction/:uid/login', parseForm, async (req: Request, res: Response) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const email = String((req.body as Record<string, unknown>)?.email ?? '').trim();
      const password = String((req.body as Record<string, unknown>)?.password ?? '');
      try {
        const user = await authService.verifyCredentials(
          { email, password },
          { ip: req.ip, userAgent: req.headers['user-agent'] },
        );
        // ★P2-acl: 자격증명은 맞아도 이 RP 에 승인되지 않았으면 로그인 완료시키지 않는다.
        if (!(await isApproved(details.params.client_id, user.id))) {
          res.status(403);
          res.set('content-type', 'text/html; charset=utf-8');
          res.set('cache-control', 'no-store');
          res.end(renderNotApproved(details.params.client_id));
          return;
        }
        await provider.interactionFinished(
          req,
          res,
          { login: { accountId: user.id } },
          { mergeWithLastSubmission: false },
        );
      } catch (authErr) {
        // 자격검증 실패(잘못된 비번/잠금/비활성/rate-limit) → 폼 재표시.
        res.status(400);
        res.set('content-type', 'text/html; charset=utf-8');
        res.set('cache-control', 'no-store');
        res.end(renderLogin(details.uid, details.params.client_id, authErrorMessage(authErr)));
      }
    } catch (err) {
      logger.error({ err }, 'oidc interaction login failed');
      if (!res.headersSent) {
        res.status(500).end('login error');
      }
    }
  });

  return router;
}

// sso.* host 전용 핸들러: interaction 라우트 → 없으면 oidc-provider 콜백으로 위임.
export function buildSsoApp(
  provider: any,
  authService: AuthService,
  isApproved: (clientId: string, userId: string) => Promise<boolean>,
): express.Express {
  const app = express();
  // nginx 단일 홉 뒤 — req.ip(로그인 rate-limit용) 복원.
  app.set('trust proxy', 1);
  // ★보안(reviewer/scanner H1): 이 핸들러는 helmet *앞* 에 마운트돼 helmet 헤더가 빠지고,
  // oidc-provider 도 authorize/interaction 페이지에 보안 헤더를 세우지 않는다. 비밀번호
  // 폼 클릭재킹/스니핑/referer 유출을 막는 최소 헤더를 모든 sso 응답에 직접 건다. (CSP 는
  // oidc-provider 의 logout 인라인 스크립트와 충돌할 수 있어 후속 정밀화 — 우선 frame/sniff/
  // referrer 만.)
  app.use((_req: Request, res: Response, next: () => void) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(buildInteractionRouter(provider, authService, isApproved));
  const callback = provider.callback();
  app.use((req: Request, res: Response) => callback(req, res));
  return app;
}
