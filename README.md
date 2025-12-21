# NXT Backend Service

Backend service for Xero integration metadata.

## 🔥 Database Safety Rules

- **Local dev:**
  - Edit `prisma/schema.prisma`.
  - Migrations use `prisma/schema.dev.prisma` (dev-only) so `SHADOW_DATABASE_URL` is available to `prisma migrate dev/reset`.
  - Uses local `DATABASE_URL` and `SHADOW_DATABASE_URL`.

- **Production (hosted env, e.g. Railway):**
  - Only `DATABASE_URL` is set.
  - `SHADOW_DATABASE_URL` is **never** set.
  - Never run `migrate dev` / `reset` / `db push`.
  - To apply migrations: `npm run prisma:migrate:deploy`.

## Prisma Schemas (Dev vs Prod)

We intentionally keep two Prisma schemas:

- **`prisma/schema.prisma` (default / production-safe)**:
  - Does **not** reference `SHADOW_DATABASE_URL`, so production environments don’t need it.
  - Used by `npm run prisma:migrate:deploy` (production).

- **`prisma/schema.dev.prisma` (development-only)**:
  - Same models as `schema.prisma`, but includes:
    - `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")`
  - Used by:
    - `npm run prisma:migrate:dev`
    - `npm run prisma:migrate:reset`

### Using the Safety Script

Before doing anything risky with the DB (production or staging), run:

```bash
npm run check:db-safety
```

This validates your environment configuration and will fail fast if dangerous combinations are detected (e.g., shadow DB in production, local DB in production, or production DB in development).

You can also add this to CI/CD as a pre-deploy step to catch misconfigurations before they reach production.

## ✅ DB Migration Test Plan

Follow this step-by-step process to safely develop and deploy database migrations.

### A. Local Rehearsal (safe sandbox)

This is your safe testing ground. Always test migrations locally before deploying.

1. **Edit the schema:**
   - Open `prisma/schema.prisma` (this is the source of truth)
   - Make your changes (e.g., add a nullable field to an existing model)

2. **Create the migration:**
   ```bash
   npm run prisma:migrate:dev
   ```
   - This uses `prisma/schema.dev.prisma` under the hood (dev-only shadow DB enabled).
   - Note: The `--name <descriptive_name>` flag is optional; Prisma will prompt you for a name if omitted.

3. **Verify the migration:**
   - Confirm a new folder appears under `prisma/migrations/` with your migration SQL
   - (Optional) Check the database schema directly:
     ```bash
     psql -d nxt_dev -c '\d "Supplier"'
     ```
     Replace `Supplier` with your model name to see the new column/field

4. **Test the application:**
   - Run the backend: `npm run dev`
   - Hit any route that touches the changed model to ensure no runtime errors
   - Verify the application works correctly with the schema changes

5. **Commit your changes:**
   ```bash
   git add prisma/schema.prisma prisma/migrations
   git commit -m "feat: add [description] to [model]"
   ```

### B. Production Migration (hosted env, e.g. Railway)

Once local testing is complete, deploy to production following these steps.

1. **Verify production environment:**
   - Check that `NODE_ENV=production` is set
   - Verify `DATABASE_URL` points to your hosted database
   - Confirm **NO** `SHADOW_DATABASE_URL` is configured in production

2. **Run safety check:**
   ```bash
   npm run check:db-safety
   ```
   - If it fails, fix your environment configuration before proceeding
   - This catches misconfigurations that could lead to data loss

3. **Deploy updated code:**
   - Push your committed changes and deploy to your production environment

4. **Apply migrations:**
   - In your production shell/terminal:
     ```bash
     NODE_ENV=production npx prisma migrate deploy
     ```
   - Or use the npm script:
     ```bash
     npm run prisma:migrate:deploy
     ```

5. **Confirm success:**
   - Prisma should report migrations applied successfully or "nothing to migrate"
   - (Optional) Inspect the database via your hosting provider's UI or `psql` to confirm the new column/field exists

### C. Foot-Gun Check (one-time confidence test)

**Important:** This is a **one-time manual exercise** to build confidence in the safety guardrails. It is **NOT** part of the normal workflow and should **NOT** be run routinely in real production.

**Purpose:** Verify that the safety mechanisms work as designed.

**How to test:**

1. In a local or staging-like environment, intentionally try:
   ```bash
   NODE_ENV=production npm run prisma:migrate:dev
   ```

2. **Expected result:** It should fail with an error about `SHADOW_DATABASE_URL` not being set.

3. **Why this is good:** This confirms the safety net is working. In production, `SHADOW_DATABASE_URL` is never set, so dangerous commands like `migrate dev` or `migrate reset` cannot run against production.

**Remember:** Do **not** routinely run this in real production. This is just a one-time exercise to verify the guardrails work correctly.




