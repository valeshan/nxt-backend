# Railway Quick Reference

## ⚡ Critical Configuration

### Railway Dashboard → Service → Settings

**Deploy Command (Release Phase):**
```
npm run migrate:prod
```

**Start Command (Runtime):**
```
npm run start:prod
```

## ✅ Verification Checklist

- [ ] Deploy Command is `npm run migrate:prod` (NOT `npm start` or anything with migrations)
- [ ] Start Command is `npm run start:prod` (NOT `npm run migrate:prod`)
- [ ] No migrations in `postinstall`, `prepare`, or `prestart` scripts
- [ ] No migrations in Docker CMD/entrypoint (if using Docker)
- [ ] No migrations in PM2 config (if using PM2)

## 🚨 What Happens

### On Deploy (Release Phase)
1. `npm run migrate:prod` runs
2. Migrations apply
3. Schema verification runs
4. ✅ Success → Deploy continues
5. ❌ Failure → Deploy fails, traffic never switches

### On Container Start (Runtime)
1. `npm run start:prod` runs
2. Server starts (no migrations)
3. Fast startup, ready to serve traffic

## 📋 Scripts

| Script | Command | When | Purpose |
|--------|---------|------|---------|
| `migrate:prod` | `bash scripts/safe-migrate-deploy.sh` | Deploy (release) | Run migrations + verify |
| `start:prod` | `node dist/src/server.js` | Container start | Start server only |

## 🔍 Troubleshooting

**Migration timeout?**
- Increase Railway deploy timeout in settings
- Use larger plan for deploy phase

**Partial migration?**
- Check: `npx prisma migrate status` (in Railway shell)
- Resolve: `npx prisma migrate resolve --applied <name>`

**Migrations running on startup?**
- Check Start Command is `npm run start:prod`
- Check no `postinstall`/`prepare` scripts run migrations

## 📚 Full Documentation

See `docs/RAILWAY_DEPLOYMENT.md` for complete details.


