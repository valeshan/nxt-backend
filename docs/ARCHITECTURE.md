# Architecture

## Overview
The Xero Integration Service is a lightweight backend service designed to manage Xero integration metadata. It acts as a specialized microservice that:
- Stores Xero connection tokens (access/refresh) securely.
- Maps external Organisation IDs (from the main backend BE1) to Xero connections.
- Maps external Location IDs to Xero connections.
- Provides a REST API for these operations.

## Tech Stack
- **Runtime**: Node.js (>=20)
- **Language**: TypeScript
- **Framework**: Fastify (optimized for performance and low overhead)
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Validation**: Zod (integrated via `fastify-type-provider-zod`)
- **Authentication**: JWT (Stateless verification of tokens issued by BE1)

## Infrastructure Notes (DB/Prisma)

### Connection Pooling (Railway Postgres)

We configure **Prisma's internal connection pool** via `DATABASE_URL` query params (this is **not** PgBouncer).

Recommended production default:

- `?connection_limit=5&pool_timeout=10`

Scaling math (keep under Railway’s connection cap, ~97):

\[
Total\_connections \approx (app\_instances + workers/job\_processes) \times connection\_limit
\]

### Prisma Schemas (Dev vs Prod)

We intentionally keep two Prisma schemas:

- `prisma/schema.prisma` (default / production-safe): does **not** require `SHADOW_DATABASE_URL`.
- `prisma/schema.dev.prisma` (development-only): includes `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")` and is used for `migrate dev/reset`.

### Prisma Slow Query Logging (Production-Safe)

Prisma query logging is configured in `src/infrastructure/prismaClient.ts`.

- Dev logs: query timing + truncated SQL text (never logs params).
- Prod logs: **duration + query hash only** (no SQL text, no params).

Env toggles (defaults):

- `PRISMA_SLOW_QUERY_LOGGING=true`
- `PRISMA_SLOW_MS=800`

### Production Deployment Checklist (Railway)

**Environment variables**

- **Required**:
  - `NODE_ENV=production`
  - `DATABASE_URL` (Railway Postgres)
    - Recommended: append `?connection_limit=5&pool_timeout=10`
    - Remember scaling: \((instances + workers/job\_processes) \times connection\_limit\) < ~97
  - `JWT_VERIFY_SECRET`, `JWT_REFRESH_SECRET`, `TOKEN_ENCRYPTION_KEY`
- **Strongly recommended**:
  - `REDIS_URL` (enables shared rate-limit storage across instances; also used by BullMQ for inbound processing)
  - `FRONTEND_URL` (locks down CORS allowlist in production)
- **Optional**:
  - `PRISMA_SLOW_QUERY_LOGGING` (default `true`)
  - `PRISMA_SLOW_MS` (default `800`)
- **Must NOT be set in production**:
  - `SHADOW_DATABASE_URL`

**Migrations**

- Apply schema/index migrations in production using:
  - `npm run prisma:migrate:deploy`
- Note on index locking:
  - `CREATE INDEX` may briefly block writes (impact depends on table size).
  - If tables grow large, prefer manual `CREATE INDEX CONCURRENTLY` outside a transaction.

## Operational Guardrails (Prod Readiness)

### Health vs Readiness

We expose two endpoints with intentionally different semantics:

- **`GET /health` (liveness)**:
  - Always returns **200** quickly (no dependency checks)
  - Includes a `version` field (commit SHA when available)
  - Intended for Railway / load balancer liveness checks (avoid restart loops if DB/Redis restarts)

- **`GET /ready` (readiness)**:
  - Checks **DB** (`SELECT 1`) and **Redis** (`PING`) with strict timeouts
  - Returns **200** when dependencies are healthy
  - Returns **503** when degraded
    - `Cache-Control: no-store`
    - `Retry-After: 5`
  - Timeouts:
    - Overall deadline ~2s
    - Per-dependency deadline ~1.2s

**Note:** In production, Redis is required (`REDIS_URL`), so `/ready` should be used to ensure the instance is actually ready to serve (rate limiting, cron locks, queues).

### Cron Jobs: Single-Instance + Redis Locks

Cron tasks are scheduled in-process (Fastify server) and are protected with **Redis distributed locks** so accidental multi-instance cron enablement does not double-process jobs.

- Each job acquires a lock key like `cron:<jobName>` with a TTL sized to the job’s expected runtime.
- If lock acquisition fails, **skip means skip** (no retries inside the tick).
- Lock release uses compare-and-delete semantics to avoid releasing another instance’s lock.
- Runtime logs include `instanceId` for operational visibility.

### DB-Level Idempotency for Pipelines

We guard state transitions for async pipelines (OCR + Xero sync runs) using DB-level “expected status” semantics:

- Use `updateMany({ where: { id, status: expected }, data: { ... } })`
- If `count === 0`, treat it as **lost race / already handled** and return early.

This prevents stale workers/retries from overwriting newer status or emitting duplicate completion events.

### Pagination + Date Window Guards

To protect the database from deep scans and oversized responses, list endpoints enforce:

- **Pagination caps**:
  - `limit <= 100`
  - `offset (skip) <= 5000`
- **Date window guards** (where applicable):
  - `startDate <= endDate`
  - window length `<= 366 days`
  - for deep pagination, a date window is required (to avoid “all-time + deep offset” scans)

Implementation lives in `src/utils/paginationGuards.ts`.

## Security
- **Authentication**: All API endpoints require a valid JWT signed by BE1.
- **Token Storage**: Xero tokens (access and refresh) are encrypted at rest using AES-256-GCM with a unique random IV for every write.
- **Validation**: Strict input validation using Zod schemas prevents malformed data or injection attempts.

## Data Flow
1. **Auth**: Incoming requests must bear a JWT. The service verifies the signature and extracts `sub` (User ID) and `orgId`.
2. **Write**: When creating a connection, tokens are encrypted and stored in Postgres.
3. **Read**: When listing connections, data is retrieved from Postgres. Tokens are NOT returned in the API response by default (unless explicitly needed, but currently only metadata is exposed).

