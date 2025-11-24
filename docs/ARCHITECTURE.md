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

## Security
- **Authentication**: All API endpoints require a valid JWT signed by BE1.
- **Token Storage**: Xero tokens (access and refresh) are encrypted at rest using AES-256-GCM with a unique random IV for every write.
- **Validation**: Strict input validation using Zod schemas prevents malformed data or injection attempts.

## Data Flow
1. **Auth**: Incoming requests must bear a JWT. The service verifies the signature and extracts `sub` (User ID) and `orgId`.
2. **Write**: When creating a connection, tokens are encrypted and stored in Postgres.
3. **Read**: When listing connections, data is retrieved from Postgres. Tokens are NOT returned in the API response by default (unless explicitly needed, but currently only metadata is exposed).

