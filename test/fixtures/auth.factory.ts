/**
 * Deterministic-ish auth fixtures for tests.
 * - Emails/usernames are timestamp-salted so repeated signup never collides.
 * - Default password is above zxcvbn score 3 and >= 10 chars with 4 char classes.
 */
export const STRONG_PASSWORD = 'Quanta-Beetle-Nebula-42!';

export function makeSignupDto(overrides: Partial<{ email: string; username: string; password: string }> = {}) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 9999)}`;
  return {
    email: overrides.email ?? `user-${stamp}@qufox.dev`,
    username: overrides.username ?? `user${stamp}`,
    password: overrides.password ?? STRONG_PASSWORD,
  };
}

export function makeLoginDto(email: string, password = STRONG_PASSWORD) {
  return { email, password };
}

/** Parses a Set-Cookie list for the first cookie matching `name`. */
export function pickCookie(setCookieHeader: string | string[] | undefined, name: string): string | null {
  if (!setCookieHeader) return null;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const entry of list) {
    const first = entry.split(';')[0];
    if (first.startsWith(`${name}=`)) return first.substring(name.length + 1);
  }
  return null;
}
