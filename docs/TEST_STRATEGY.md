# Test Strategy

## Overview
We use **Vitest** for both unit and integration testing, ensuring fast feedback and reliable coverage.

## Levels of Testing

### 1. Unit Tests
Located in `tests/unit/`.
- **Focus**: Isolated logic, helper functions, and plugins.
- **Key Areas**:
  - **Crypto**: verifying encryption round-trips and IV randomness.
  - **Config**: ensuring env vars are validated correctly.
  - **Auth Plugin**: verifying JWT extraction and request decoration without needing a real server.

### 2. Integration Tests
Located in `tests/integration/`.
- **Focus**: End-to-end flow via the HTTP API.
- **Tools**: `supertest` (via `app.inject` in Fastify) and a real (or Dockerized) PostgreSQL database.
- **Strategy**:
  - **Setup**: The `testApp.ts` helper builds the app and connects to the DB.
  - **Reset**: `resetDb()` truncates tables between tests to ensure isolation.
  - **Scenarios**:
    - **Happy Path**: Creating connections and linking locations with valid data.
    - **Error Handling**: Invalid payloads (400), Auth failures (401), Business rule violations (403 Org Mismatch).

## Running Tests
- `npm test`: Runs all tests using Vitest.
- `npm run test:ui` (optional): Opens Vitest UI if configured.

## Database for Tests
Tests expect a running PostgreSQL instance reachable via `DATABASE_URL`. For local development, this is typically the same as dev or a dedicated test DB.

## Quick Smoke Checks (Local)

These are helpful when validating infra hardening changes:

- **Liveness**:
  - `GET /health` should respond quickly with `{ status: "ok", version }`
- **Readiness**:
  - `GET /ready` should return **200** when DB/Redis are healthy
  - `GET /ready` should return **503** with `Retry-After` when dependencies are degraded or time out


