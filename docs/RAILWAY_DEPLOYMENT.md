# Railway Deployment Configuration

This document describes the Railway deployment setup to ensure migrations run exactly once per deploy, never on container startup, and never concurrently.

## Critical Railway Configuration

### Deploy Command (Release Phase)
**This runs ONCE per deploy, before traffic switches.**

```bash
npm run migrate:prod
```

This command:
1. Runs `prisma migrate deploy` to apply pending migrations
2. Runs `verify-schema.ts` to verify critical columns exist
3. **Fails the deploy** if migrations or verification fail (traffic never switches)

### Start Command (App Runtime)
**This runs on EVERY container start. Must NOT run migrations.**

```bash
npm run start:prod
```

This command:
- Starts the Fastify server
- Does NOT run migrations
- Does NOT touch the database schema
- Starts fast and clean

## Railway Dashboard Settings

In your Railway project settings, configure:

### Service Settings

1. **Deploy Command** (Release Phase):
   ```
   npm run migrate:prod
   ```

2. **Start Command** (Runtime):
   ```
   npm run start:prod
   ```

### Important: What NOT to Do

❌ **DO NOT** run migrations in:
- Start Command
- Docker CMD / entrypoint (if using Docker)
- PM2 config
- `postinstall` scripts
- `prepare` scripts
- Any startup hooks

✅ **ONLY** run migrations in:
- Deploy Command (release phase)
- Manual Railway shell commands (for debugging)

## How It Works

### Railway Deployment Flow

```
1. Build Phase
   └─> npm run build
       └─> Generates Prisma Client
       └─> Compiles TypeScript

2. Release Phase (Deploy Command)
   └─> npm run migrate:prod
       └─> prisma migrate deploy
       └─> verify-schema.ts
       └─> ✅ Success → Continue
       └─> ❌ Failure → Deploy fails, traffic never switches

3. Runtime Phase (Start Command)
   └─> npm run start:prod
       └─> node dist/src/server.js
       └─> Server starts (no migrations)
```

### Safety Guarantees

1. **Single Execution**: Migrations run once per deploy in the release phase
2. **No Race Conditions**: Railway's release phase runs sequentially, not concurrently
3. **Fail-Fast**: If migrations fail, deploy fails before traffic switches
4. **Fast Startup**: App containers start immediately without migration overhead
5. **Idempotent**: Migrations use `IF NOT EXISTS` and transactions for safety

## Troubleshooting

### Migration Timeouts

If migrations take too long and Railway times out:

1. **Increase Deploy Timeout**:
   - Railway Dashboard → Service → Settings
   - Increase "Deploy Timeout" (default is often 5-10 minutes)

2. **Use Larger Plan**:
   - Railway Dashboard → Service → Settings
   - Upgrade to a plan with more CPU/memory for the deploy phase

3. **Optimize Migrations**:
   - Split large migrations into smaller chunks
   - Use `CREATE INDEX CONCURRENTLY` for large tables (outside transactions)

### Partial Migration Issues

If a migration partially applies:

1. **Check Migration Status**:
   ```bash
   # In Railway shell
   npx prisma migrate status
   ```

2. **Resolve Failed Migration**:
   ```bash
   # If migration failed but was partially applied
   npx prisma migrate resolve --applied <migration_name>
   
   # If migration should be rolled back
   npx prisma migrate resolve --rolled-back <migration_name>
   ```

3. **Re-run Verification**:
   ```bash
   npm run verify:schema
   ```

### Concurrent Deploy Prevention

**Operational Rule**: Avoid triggering multiple deploys simultaneously.

- Railway's release phase should prevent concurrent migrations
- If you need belt-and-suspenders, consider adding a DB advisory lock in the migration script (future enhancement)

## Manual Migration (Emergency)

If you need to run migrations manually (e.g., after a failed deploy):

1. **Open Railway Shell**:
   - Railway Dashboard → Service → Deployments → [Latest] → Shell

2. **Run Migration**:
   ```bash
   npm run migrate:prod
   ```

3. **Verify**:
   ```bash
   npm run verify:schema
   ```

## Verification

To verify your Railway configuration is correct:

1. **Check Deploy Command**:
   - Railway Dashboard → Service → Settings
   - Deploy Command should be: `npm run migrate:prod`

2. **Check Start Command**:
   - Railway Dashboard → Service → Settings
   - Start Command should be: `npm run start:prod`

3. **Check Logs**:
   - Railway Dashboard → Service → Deployments → [Latest] → Logs
   - Release phase should show: `🚀 Running prisma migrate deploy...`
   - Runtime phase should show: `Server listening on port...` (no migration messages)

## Script Reference

### `migrate:prod`
- **Location**: `package.json`
- **Command**: `NODE_ENV=production bash scripts/safe-migrate-deploy.sh`
- **Purpose**: Run migrations + verification in production
- **When**: Railway release phase (Deploy Command)

### `start:prod`
- **Location**: `package.json`
- **Command**: `node dist/src/server.js`
- **Purpose**: Start the application server
- **When**: Railway runtime phase (Start Command)

### `safe-migrate-deploy.sh`
- **Location**: `scripts/safe-migrate-deploy.sh`
- **Purpose**: Wrapper that runs migrations and verification
- **Features**:
  - Ensures `NODE_ENV=production`
  - Runs `prisma migrate deploy`
  - Runs `verify-schema.ts`
  - Exits with non-zero code on failure

### `verify-schema.ts`
- **Location**: `scripts/verify-schema.ts`
- **Purpose**: Post-migration schema verification
- **Checks**: Critical columns exist (e.g., `InvoiceLineItem.isIncludedInAnalytics`, `source`, `sourceKey`)
- **When**: After migrations in `safe-migrate-deploy.sh`

## Summary

✅ **Deploy Command**: `npm run migrate:prod` (runs once per deploy)  
✅ **Start Command**: `npm run start:prod` (runs on every container start)  
✅ **No migrations in startup**: Server starts clean and fast  
✅ **Fail-fast verification**: Deploy fails if schema is incomplete  
✅ **Idempotent migrations**: Safe to re-run if interrupted  

This configuration ensures migrations run exactly once per deploy, never on container startup, and never concurrently.


