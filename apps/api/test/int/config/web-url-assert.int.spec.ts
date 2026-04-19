import { describe, expect, it } from 'vitest';
import { assertProductionEnv, RequiredEnvError } from '../../../src/config/required-env';

/**
 * Lives under test/int/ so it runs in the test:int pipeline (the task
 * contract that added it expects it there), but it doesn't actually need
 * containers — pure env-validation logic.
 */
describe('assertProductionEnv — WEB_URL', () => {
  it('is a no-op in non-production environments', () => {
    expect(() => assertProductionEnv({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertProductionEnv({ NODE_ENV: 'test' })).not.toThrow();
    // Even an obviously bad WEB_URL is tolerated outside production.
    expect(() =>
      assertProductionEnv({ NODE_ENV: 'development', WEB_URL: 'http://localhost:45173' }),
    ).not.toThrow();
  });

  it('throws when WEB_URL is missing in production', () => {
    expect(() => assertProductionEnv({ NODE_ENV: 'production' })).toThrow(RequiredEnvError);
    expect(() => assertProductionEnv({ NODE_ENV: 'production', WEB_URL: '' })).toThrow(
      /WEB_URL must be set/,
    );
    expect(() => assertProductionEnv({ NODE_ENV: 'production', WEB_URL: '   ' })).toThrow(
      /WEB_URL must be set/,
    );
  });

  it('throws when WEB_URL is a known dev-default in production', () => {
    expect(() =>
      assertProductionEnv({ NODE_ENV: 'production', WEB_URL: 'http://localhost:45173' }),
    ).toThrow(/development default/);
    expect(() =>
      assertProductionEnv({ NODE_ENV: 'production', WEB_URL: 'http://localhost:5173' }),
    ).toThrow(/development default/);
  });

  it('accepts a real public URL in production', () => {
    expect(() =>
      assertProductionEnv({ NODE_ENV: 'production', WEB_URL: 'https://qufox.com' }),
    ).not.toThrow();
  });
});
