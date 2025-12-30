import { AsyncLocalStorage } from 'async_hooks';

export type RequestContext = {
  requestId: string;
  method: string;
  route: string;
  startAtMs: number;
  organisationId?: string | null;
  locationId?: string | null;
};

const als = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}


