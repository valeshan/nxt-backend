import { performance } from 'perf_hooks';
import {
  markHeartbeatFailure,
  markHeartbeatSuccess,
  upsertHeartbeatRunning,
} from '../repositories/jobHeartbeatRepository';

type Options = {
  jobName: string;
  expectedIntervalSeconds: number;
  staleAfterSeconds: number;
};

export async function withJobHeartbeat<T>(opts: Options, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  await upsertHeartbeatRunning({
    jobName: opts.jobName,
    expectedIntervalSeconds: opts.expectedIntervalSeconds,
    staleAfterSeconds: opts.staleAfterSeconds,
  });

  try {
    const result = await fn();
    const duration = Math.round(performance.now() - start);
    await markHeartbeatSuccess({
      jobName: opts.jobName,
      durationMs: duration,
      expectedIntervalSeconds: opts.expectedIntervalSeconds,
      staleAfterSeconds: opts.staleAfterSeconds,
    });
    return result;
  } catch (err: any) {
    const duration = Math.round(performance.now() - start);
    await markHeartbeatFailure({
      jobName: opts.jobName,
      durationMs: duration,
      error: err?.message || String(err),
      expectedIntervalSeconds: opts.expectedIntervalSeconds,
      staleAfterSeconds: opts.staleAfterSeconds,
    });
    throw err;
  }
}


