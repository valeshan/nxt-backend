export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_OFFSET = 5000; // skip = (page-1)*limit
export const MAX_DATE_RANGE_DAYS = 366;
export const DEEP_PAGINATION_REQUIRES_WINDOW_OFFSET = 1000;

type ApiErrorCode =
  | 'PAGINATION_LIMIT_EXCEEDED'
  | 'PAGINATION_OFFSET_EXCEEDED'
  | 'INVALID_DATE'
  | 'INVALID_DATE_RANGE'
  | 'DATE_WINDOW_TOO_LARGE'
  | 'DATE_WINDOW_REQUIRED';

function badRequest(code: ApiErrorCode, message: string) {
  const err: any = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

export function getOffsetPaginationOrThrow(input: {
  page?: number;
  limit?: number;
  maxLimit?: number;
  maxOffset?: number;
}): { page: number; limit: number; skip: number } {
  const page = input.page ?? 1;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const maxLimit = input.maxLimit ?? MAX_LIMIT;
  const maxOffset = input.maxOffset ?? MAX_OFFSET;

  if (!Number.isFinite(page) || page < 1) {
    throw badRequest('PAGINATION_LIMIT_EXCEEDED', 'page must be >= 1');
  }
  if (!Number.isFinite(limit) || limit < 1) {
    throw badRequest('PAGINATION_LIMIT_EXCEEDED', 'limit must be >= 1');
  }
  if (limit > maxLimit) {
    throw badRequest('PAGINATION_LIMIT_EXCEEDED', `limit must be <= ${maxLimit}`);
  }

  const skip = (page - 1) * limit;
  if (skip > maxOffset) {
    throw badRequest(
      'PAGINATION_OFFSET_EXCEEDED',
      `Pagination offset too large. Please narrow your query (max offset ${maxOffset}).`
    );
  }

  return { page, limit, skip };
}

export function parseDateOrThrow(input: string | undefined, label: string): Date | undefined {
  if (!input) return undefined;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw badRequest('INVALID_DATE', `${label} must be a valid date`);
  }
  return d;
}

export function assertDateRangeOrThrow(input: {
  start?: Date;
  end?: Date;
  maxDays?: number;
}): void {
  const { start, end } = input;
  if (!start && !end) return;

  const maxDays = input.maxDays ?? MAX_DATE_RANGE_DAYS;
  const s = start ?? end!;
  const e = end ?? start!;

  if (s.getTime() > e.getTime()) {
    throw badRequest('INVALID_DATE_RANGE', 'startDate must be <= endDate');
  }

  const ms = e.getTime() - s.getTime();
  const days = ms / (1000 * 60 * 60 * 24);
  if (days > maxDays) {
    throw badRequest(
      'DATE_WINDOW_TOO_LARGE',
      `Date window too large. Please request <= ${maxDays} days.`
    );
  }
}

export function assertWindowIfDeepPagination(input: {
  skip: number;
  hasWindow: boolean;
  threshold?: number;
}): void {
  const threshold = input.threshold ?? DEEP_PAGINATION_REQUIRES_WINDOW_OFFSET;
  if (input.skip > threshold && !input.hasWindow) {
    throw badRequest(
      'DATE_WINDOW_REQUIRED',
      'Please provide a startDate/endDate when paginating deep into results.'
    );
  }
}

