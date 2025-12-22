const WHITESPACE_RE = /\s+/g;
const PUNCT_LIGHT_RE = /[.,;:(){}\[\]<>|]/g;

export function normalizeDescription(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(WHITESPACE_RE, ' ')
    .replace(PUNCT_LIGHT_RE, '')
    .trim();
}

export function normalizeUnitLabel(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  return v.toUpperCase().replace(WHITESPACE_RE, ' ').trim();
}

