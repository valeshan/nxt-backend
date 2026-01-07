# Production Readiness Checklist

Use this checklist before deploying the hardened backend to production.

## Pre-Deployment

### Environment Variables

- [ ] `SENTRY_DSN` is set (if using Sentry)
- [ ] `SENTRY_SEND_DEFAULT_PII` is set to `'false'` (or explicitly `'true'` if needed)
- [ ] `NODE_ENV=production` is set
- [ ] `DATABASE_URL` points to production database
- [ ] `JWT_VERIFY_SECRET` and `JWT_REFRESH_SECRET` are set and strong
- [ ] `TOKEN_ENCRYPTION_KEY` is set (min 32 characters)
- [ ] `FRONTEND_URL` matches your frontend domain
- [ ] `REDIS_URL` is set (required for production)
- [ ] All other required environment variables are configured

### Secrets Rotation

- [ ] **Sentry DSN rotated**: Old hardcoded DSN revoked in Sentry dashboard
- [ ] New `SENTRY_DSN` tested and receiving events
- [ ] Old DSN no longer accepts events

### Code Quality

- [ ] CI pipeline passes (lint, typecheck, tests, security audit)
- [ ] No linter errors
- [ ] All tests pass
- [ ] Security audit shows no high-severity vulnerabilities

### Database

- [ ] Database migrations reviewed
- [ ] `SHADOW_DATABASE_URL` is **NOT** set in production
- [ ] `npm run check:db-safety` passes
- [ ] Migration plan documented (if any pending migrations)

## Deployment

### Deployment Steps

1. [ ] Deploy code to production environment
2. [ ] Verify environment variables are set correctly
3. [ ] Run `npm run check:db-safety` in production shell
4. [ ] Apply migrations if needed: `npm run prisma:migrate:deploy`
5. [ ] Verify application starts successfully
6. [ ] Check health endpoints: `GET /health` and `GET /ready`

### Verification

- [ ] Application responds to health checks
- [ ] Database connectivity verified
- [ ] Redis connectivity verified (if using)
- [ ] Sentry is receiving events (if configured)
- [ ] No stack traces in error responses (test with invalid request)
- [ ] Logs do not contain sensitive data (check invoice verification logs)

## Post-Deployment

### Monitoring

- [ ] Monitor error rates in Sentry (if configured)
- [ ] Check application logs for errors
- [ ] Verify rate limiting is working
- [ ] Monitor database connection pool usage
- [ ] Check Redis connection health

### Security Verification

- [ ] Test that stack traces are not returned to clients
- [ ] Verify CORS is configured correctly (test from frontend)
- [ ] Confirm sensitive data is not logged
- [ ] Verify Sentry PII settings are correct

### Rollback Plan

- [ ] Previous version tagged/accessible
- [ ] Database migration rollback plan documented (if needed)
- [ ] Environment variable rollback plan documented
- [ ] Rollback procedure tested in staging

## Ongoing Maintenance

### Regular Checks

- [ ] Review Sentry error reports weekly
- [ ] Run `npm audit` regularly
- [ ] Review logs for sensitive data leakage
- [ ] Monitor database connection pool usage
- [ ] Review CORS configuration if frontend changes

### Security Updates

- [ ] Keep dependencies updated
- [ ] Review security advisories
- [ ] Rotate secrets periodically (JWT secrets, encryption keys)
- [ ] Review and update Sentry DSN if compromised

## Critical Reminders

1. **Never** set `SHADOW_DATABASE_URL` in production
2. **Never** run `prisma migrate dev` or `prisma migrate reset` in production
3. **Always** use `npm run prisma:migrate:deploy` for production migrations
4. **Always** run `npm run check:db-safety` before database operations
5. **Never** commit secrets to version control
6. **Always** rotate secrets that were committed to version control

## Emergency Contacts

- **Database Issues**: [Add contact]
- **Security Incidents**: [Add contact]
- **Deployment Issues**: [Add contact]

## Notes

- This checklist should be reviewed and updated as the system evolves
- Each deployment should be documented with any deviations from this checklist
- Keep this checklist accessible to all team members involved in deployments


