import prisma from '../infrastructure/prismaClient';
import { config } from '../config/env';

export type HeartbeatStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

type RecentRun = {
  status: HeartbeatStatus;
  at: string;
  durationMs?: number | null;
  error?: string | null;
};

const HISTORY_LIMIT = 20;

function trimHistory(runs: RecentRun[]): RecentRun[] {
  return runs.slice(-HISTORY_LIMIT);
}

export async function upsertHeartbeatRunning(params: {
  jobName: string;
  expectedIntervalSeconds: number;
  staleAfterSeconds: number;
}): Promise<void> {
  const env = config.APP_ENV || 'unknown';
  const now = new Date();
  const existing = await prisma.jobHeartbeat.findUnique({
    where: { env_jobName: { env, jobName: params.jobName } },
    select: { recentRuns: true },
  });
  const history = Array.isArray(existing?.recentRuns) ? (existing?.recentRuns as RecentRun[]) : [];
  const updatedHistory = trimHistory([...history, { status: 'RUNNING', at: now.toISOString() }]);
  await prisma.jobHeartbeat.upsert({
    where: { env_jobName: { env, jobName: params.jobName } },
    create: {
      env,
      jobName: params.jobName,
      expectedIntervalSeconds: params.expectedIntervalSeconds,
      staleAfterSeconds: params.staleAfterSeconds,
      status: 'RUNNING',
      lastRunAt: now,
      recentRuns: updatedHistory as any,
    },
    update: {
      expectedIntervalSeconds: params.expectedIntervalSeconds,
      staleAfterSeconds: params.staleAfterSeconds,
      status: 'RUNNING',
      lastRunAt: now,
      recentRuns: updatedHistory as any,
    },
  });
}

export async function markHeartbeatSuccess(params: {
  jobName: string;
  durationMs?: number;
  expectedIntervalSeconds: number;
  staleAfterSeconds: number;
}): Promise<void> {
  const env = config.APP_ENV || 'unknown';
  const now = new Date();
  const current = await prisma.jobHeartbeat.findUnique({
    where: { env_jobName: { env, jobName: params.jobName } },
    select: { recentRuns: true },
  });
  const history = Array.isArray(current?.recentRuns) ? (current?.recentRuns as RecentRun[]) : [];
  const updatedHistory = trimHistory([
    ...history,
    { status: 'SUCCESS', at: now.toISOString(), durationMs: params.durationMs },
  ]);
  await prisma.jobHeartbeat.upsert({
    where: { env_jobName: { env, jobName: params.jobName } },
    create: {
      env,
      jobName: params.jobName,
      expectedIntervalSeconds: params.expectedIntervalSeconds,
      staleAfterSeconds: params.staleAfterSeconds,
      status: 'SUCCESS',
      lastRunAt: now,
      lastSuccessAt: now,
      durationMs: params.durationMs,
      recentRuns: updatedHistory as any,
    },
    update: {
      expectedIntervalSeconds: params.expectedIntervalSeconds,
      staleAfterSeconds: params.staleAfterSeconds,
      status: 'SUCCESS',
      lastRunAt: now,
      lastSuccessAt: now,
      durationMs: params.durationMs,
      lastError: null,
      recentRuns: updatedHistory as any,
    },
  });
}

export async function markHeartbeatFailure(params: {
  jobName: string;
  error: string;
  durationMs?: number;
  expectedIntervalSeconds: number;
  staleAfterSeconds: number;
}): Promise<void> {
  const env = config.APP_ENV || 'unknown';
  const now = new Date();
  const current = await prisma.jobHeartbeat.findUnique({
    where: { env_jobName: { env, jobName: params.jobName } },
    select: { recentRuns: true },
  });
  const history = Array.isArray(current?.recentRuns) ? (current?.recentRuns as RecentRun[]) : [];
  const updatedHistory = trimHistory([
    ...history,
    { status: 'FAILED', at: now.toISOString(), durationMs: params.durationMs, error: params.error },
  ]);
  await prisma.jobHeartbeat.upsert({
    where: { env_jobName: { env, jobName: params.jobName } },
    create: {
      env,
      jobName: params.jobName,
      expectedIntervalSeconds: params.expectedIntervalSeconds,
      staleAfterSeconds: params.staleAfterSeconds,
      status: 'FAILED',
      lastRunAt: now,
      lastSuccessAt: null,
      durationMs: params.durationMs,
      lastError: params.error,
      recentRuns: updatedHistory as any,
    },
    update: {
      expectedIntervalSeconds: params.expectedIntervalSeconds,
      staleAfterSeconds: params.staleAfterSeconds,
      status: 'FAILED',
      lastRunAt: now,
      durationMs: params.durationMs,
      lastError: params.error,
      recentRuns: updatedHistory as any,
    },
  });
}

export async function listHeartbeats(env?: string) {
  const envFilter = env || config.APP_ENV || 'unknown';
  return prisma.jobHeartbeat.findMany({
    where: { env: envFilter },
  });
}

