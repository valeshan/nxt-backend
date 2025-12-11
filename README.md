# NXT Backend Service

Backend service for Xero integration metadata.

## 🔥 Database Safety Rules

- **Local dev:**
  - Edit `schema.prisma`.
  - Run `npm run prisma:migrate:dev`.
  - Uses local `DATABASE_URL` and `SHADOW_DATABASE_URL`.

- **Production (Railway):**
  - Only `DATABASE_URL` is set.
  - `SHADOW_DATABASE_URL` is **never** set.
  - Never run `migrate dev` / `reset` / `db push`.
  - To apply migrations: `npm run prisma:migrate:deploy`.
