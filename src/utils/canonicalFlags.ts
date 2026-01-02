import { config } from '../config/env';

function parseCsvSet(raw: string | null | undefined): Set<string> {
  const s = String(raw ?? '').trim();
  if (!s) return new Set();
  return new Set(
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  );
}

/**
 * Canonical analytics enablement.
 *
 * Global gate: USE_CANONICAL_LINES must be true.
 * Optional scope gate: if CANONICAL_LINES_ORG_ALLOWLIST is non-empty, org must be included.
 */
export function isCanonicalLinesEnabledForOrg(organisationId: string): boolean {
  if ((config.USE_CANONICAL_LINES || 'false') !== 'true') return false;
  const allow = parseCsvSet(config.CANONICAL_LINES_ORG_ALLOWLIST);
  if (allow.size === 0) return true;
  return allow.has(organisationId);
}

export function __test_parseCsvSet(raw: string | null | undefined): string[] {
  return Array.from(parseCsvSet(raw)).sort();
}




