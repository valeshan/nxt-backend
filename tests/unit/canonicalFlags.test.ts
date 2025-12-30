import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('canonicalFlags', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('parses csv allowlist with trimming and drops empties', async () => {
    const mod = await import('../../src/utils/canonicalFlags');
    expect(mod.__test_parseCsvSet('  a, b,,c  ')).toEqual(['a', 'b', 'c']);
  });

  it('returns false when USE_CANONICAL_LINES is not enabled', async () => {
    process.env.USE_CANONICAL_LINES = 'false';
    process.env.CANONICAL_LINES_ORG_ALLOWLIST = 'e7fc';
    const mod = await import('../../src/utils/canonicalFlags');
    expect(mod.isCanonicalLinesEnabledForOrg('e7fc')).toBe(false);
  });

  it('returns true globally when allowlist is empty and USE_CANONICAL_LINES=true', async () => {
    process.env.USE_CANONICAL_LINES = 'true';
    process.env.CANONICAL_LINES_ORG_ALLOWLIST = '';
    const mod = await import('../../src/utils/canonicalFlags');
    expect(mod.isCanonicalLinesEnabledForOrg('org-1')).toBe(true);
    expect(mod.isCanonicalLinesEnabledForOrg('org-2')).toBe(true);
  });

  it('scopes to allowlisted orgs when allowlist is non-empty', async () => {
    process.env.USE_CANONICAL_LINES = 'true';
    process.env.CANONICAL_LINES_ORG_ALLOWLIST = 'org-a,org-b';
    const mod = await import('../../src/utils/canonicalFlags');
    expect(mod.isCanonicalLinesEnabledForOrg('org-a')).toBe(true);
    expect(mod.isCanonicalLinesEnabledForOrg('org-b')).toBe(true);
    expect(mod.isCanonicalLinesEnabledForOrg('org-c')).toBe(false);
  });
});



