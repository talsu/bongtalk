import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';
const PW = 'Quanta-Beetle-Nebula-42!';

test.setTimeout(60_000);

test('mobile /discover shows qf-m-segment category tabs + row list for PUBLIC workspaces', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const viewerEmail = `md-v-${stamp}@qufox.dev`;
  const viewerUser = `mdv${stamp}`;
  const slug = `md-${stamp.toString(36)}`;

  const viewerToken = await signupToken(request, viewerEmail, viewerUser);
  await bootstrapWorkspace(request, viewerToken, { name: 'MDViewer', slug, channels: ['general'] });

  // Seed a PUBLIC workspace owned by another user so the viewer sees it.
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `md-o-${stamp}@qufox.dev`, username: `mdo${stamp}`, password: PW },
  });
  const ownerToken = ((await owner.json()) as { accessToken: string }).accessToken;
  const pubSlug = `pub-${stamp.toString(36)}`;
  await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: {
      name: 'MobilePub',
      slug: pubSlug,
      visibility: 'PUBLIC',
      category: 'TECH',
      description: 'Mobile discovery test',
    },
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, viewerEmail, slug);
  await page.goto('/discover');

  await expect(page.getByTestId('mobile-discover')).toBeVisible();
  await expect(page.getByTestId('mobile-discover-segment')).toBeVisible();
  await expect(page.getByTestId('mobile-discover-cat-all')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId(`mobile-discover-row-${pubSlug}`)).toBeVisible();

  await page.getByTestId('mobile-discover-cat-TECH').click();
  await expect(page.getByTestId('mobile-discover-cat-TECH')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId(`mobile-discover-row-${pubSlug}`)).toBeVisible();

  await context.close();
});
