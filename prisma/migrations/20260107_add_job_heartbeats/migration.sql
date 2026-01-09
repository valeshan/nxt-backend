BEGIN;

CREATE TABLE "JobHeartbeat" (
    "id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "expectedIntervalSeconds" INTEGER NOT NULL,
    "staleAfterSeconds" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "durationMs" INTEGER,
    "recentRuns" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobHeartbeat_env_jobName_key" ON "JobHeartbeat"("env", "jobName");

COMMIT;


