#!/bin/bash
# Safe Migration Deploy Script
# Runs prisma migrate deploy and provides better error handling
# Includes post-migration schema verification
#
# This script is designed to run ONCE per deploy in Railway's release phase.
# It should NEVER run on container startup (start command).
#
# Usage: npm run migrate:prod
#        or: NODE_ENV=production bash scripts/safe-migrate-deploy.sh

set -e

# Ensure production environment
if [ "$NODE_ENV" != "production" ]; then
  echo "⚠️  WARNING: NODE_ENV is not 'production' (current: ${NODE_ENV:-unset})"
  echo "   This script should only run in production."
  echo "   Setting NODE_ENV=production for this run..."
  export NODE_ENV=production
fi

echo "🚀 Running prisma migrate deploy..."
echo "   Environment: ${NODE_ENV}"
echo "   This should run in Railway's release phase, NOT on container startup."

# Attempt migration
if npx prisma migrate deploy; then
  echo "✅ Migrations completed successfully!"
  echo ""
  
  # Run post-migration verification
  echo "🔍 Running post-migration schema verification..."
  if npx tsx scripts/verify-schema.ts; then
    echo ""
    echo "✅ All checks passed!"
    exit 0
  else
    EXIT_CODE=$?
    echo ""
    echo "❌ Schema verification failed!"
    echo "   Migration may have partially applied."
    echo "   Review the verification output above."
    exit $EXIT_CODE
  fi
else
  EXIT_CODE=$?
  echo ""
  echo "❌ Migration failed with exit code: $EXIT_CODE"
  echo ""
  echo "💡 If this is a P3009 error (failed migration), you can fix it by:"
  echo "   1. Connect to Railway's web shell or use the public DATABASE_URL"
  echo "   2. Run: npx prisma migrate resolve --applied \"<migration_name>\""
  echo "   3. Or: npx prisma migrate resolve --rolled-back \"<migration_name>\""
  echo ""
  exit $EXIT_CODE
fi



