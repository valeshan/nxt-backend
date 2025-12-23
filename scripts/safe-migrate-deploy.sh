#!/bin/bash
# Safe Migration Deploy Script
# Runs prisma migrate deploy and provides better error handling

set -e

echo "🚀 Running prisma migrate deploy..."

# Attempt migration
if npx prisma migrate deploy; then
  echo "✅ Migrations completed successfully!"
  exit 0
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

