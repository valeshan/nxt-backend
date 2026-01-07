# Sentry DSN Rotation Guide

## Why Rotate?

The Sentry DSN was previously hardcoded in the repository. Even if the repository is private, it's good security hygiene to rotate secrets that have been committed to version control.

## Steps to Rotate

1. **Create a new Sentry project** (or use an existing one):
   - Go to your Sentry organization
   - Create a new project or select an existing one
   - Copy the new DSN

2. **Update environment variables**:
   - Set `SENTRY_DSN` to the new DSN in all environments (development, staging, production)
   - Ensure `SENTRY_SEND_DEFAULT_PII` is set appropriately (default: `'false'`)

3. **Revoke the old DSN**:
   - In Sentry, go to Settings > Projects > [Old Project]
   - Navigate to Client Keys (DSN)
   - Revoke or delete the old DSN

4. **Verify**:
   - Deploy the updated code with the new DSN
   - Trigger a test error to confirm events are being sent to the new project
   - Verify the old DSN no longer accepts events

## Important Notes

- The old DSN (`https://67b023dc368d515487a8de5285e2c3d6@o4510427751448576.ingest.us.sentry.io/4510427755970560`) should be revoked immediately after updating environments
- If you need to keep historical data, you can keep the old project but revoke the DSN
- All environments should use the same new DSN or separate DSNs per environment (your choice)


