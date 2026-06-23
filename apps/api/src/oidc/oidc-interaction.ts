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

function renderLogin(uid: string, clientId: string, error: string | null): string {
  const safeUid = escapeHtml(uid);
  const safeClient = escapeHtml(clientId ?? '');
  const errorHtml = error
    ? `<p role="alert" style="margin:0 0 16px;padding:10px 12px;background:#fde8e8;color:#9b1c1c;border-radius:8px;font-size:14px">${escapeHtml(error)}</p>`
    : '';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qufox SSO 로그인</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:#f3f4f6; margin:0; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { background:#fff; width:100%; max-width:360px; padding:32px 28px; border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,.08); }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#6b7280; font-size:13px; margin:0 0 20px; }
  label { display:block; font-size:13px; color:#374151; margin:0 0 6px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; margin:0 0 16px; border:1px solid #d1d5db; border-radius:8px; font-size:14px; }
  button { width:100%; padding:11px 12px; border:0; border-radius:8px; background:#4f46e5; color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  button:hover { background:#4338ca; }
</style>
</head>
<body>
  <main class="card">
    <h1>qufox 계정으로 로그인</h1>
    <p class="sub">${safeClient ? `${safeClient} 에 연결합니다.` : '패밀리 서비스에 연결합니다.'}</p>
    ${errorHtml}
    <form method="post" action="/interaction/${safeUid}/login" autocomplete="on">
      <label for="email">이메일</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus>
      <label for="password">비밀번호</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">로그인</button>
    </form>
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

export function buildInteractionRouter(provider: any, authService: AuthService): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

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

  router.post('/interaction/:uid/login', async (req: Request, res: Response) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const email = String((req.body as Record<string, unknown>)?.email ?? '').trim();
      const password = String((req.body as Record<string, unknown>)?.password ?? '');
      try {
        const user = await authService.verifyCredentials(
          { email, password },
          { ip: req.ip, userAgent: req.headers['user-agent'] },
        );
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
export function buildSsoApp(provider: any, authService: AuthService): express.Express {
  const app = express();
  // nginx 단일 홉 뒤 — req.ip(로그인 rate-limit용) 복원.
  app.set('trust proxy', 1);
  app.use(buildInteractionRouter(provider, authService));
  const callback = provider.callback();
  app.use((req: Request, res: Response) => callback(req, res));
  return app;
}
