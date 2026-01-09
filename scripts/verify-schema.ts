#!/usr/bin/env tsx
/**
 * Post-Migration Schema Verification
 * 
 * Verifies that critical columns exist after migrations.
 * Fails fast if schema is incomplete, preventing partial migration issues.
 * 
 * Usage: tsx scripts/verify-schema.ts
 *        npm run verify:schema
 */

// Load dotenv in non-production environments
if (process.env.NODE_ENV !== 'production') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
}

import prisma from '../src/infrastructure/prismaClient';

interface ColumnCheck {
  tableName: string;
  expectedColumns: string[];
  description: string;
}

const CRITICAL_CHECKS: ColumnCheck[] = [
  {
    tableName: 'InvoiceLineItem',
    expectedColumns: ['isIncludedInAnalytics', 'source', 'sourceKey'],
    description: 'InvoiceLineItem analytics and source tracking columns',
  },
  {
    tableName: 'Feedback',
    expectedColumns: ['id', 'referenceType', 'message', 'createdAt'],
    description: 'Feedback table core columns',
  },
  {
    tableName: 'Organisation',
    expectedColumns: [
      'seatLimit',
      'planKey',
      'billingState',
      'trialEndsAt',
      'currentPeriodEndsAt',
      'graceEndsAt',
      'entitlementOverrides',
      // Stripe billing fields
      'stripeCustomerId',
      'stripeSubscriptionId',
      'stripePriceId',
      'stripeSubscriptionStatus',
      'cancelAtPeriodEnd',
      'hasUsedIntroOffer',
    ],
    description: 'Organisation entitlements and Stripe billing columns',
  },
  {
    tableName: 'BillingWebhookEvent',
    expectedColumns: [
      'id',
      'eventType',
      'organisationId',
      'processedAt',
      'payload',
      'createdAt',
    ],
    description: 'Billing webhook idempotency table',
  },
  {
    tableName: 'OrganisationInvite',
    expectedColumns: [
      'id',
      'organisationId',
      'email',
      'tokenHash',
      'locationIds',
      'expiresAt',
      'acceptedAt',
      'revokedAt',
      'revokedReason',
      'replacedByInviteId',
    ],
    description: 'Organisation invite system columns',
  },
  {
    tableName: 'UserLocationAccess',
    expectedColumns: ['id', 'userId', 'organisationId', 'locationId', 'createdAt'],
    description: 'User-location scoped access control',
  },
];

async function verifySchema() {
  console.log('🔍 Verifying schema after migration...\n');

  let allPassed = true;

  for (const check of CRITICAL_CHECKS) {
    // Check each column individually for clarity and reliability
    const foundColumns: string[] = [];
    
    for (const expectedColumn of check.expectedColumns) {
      const result = await prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ${check.tableName}
            AND column_name = ${expectedColumn}
        ) as exists;
      `;
      
      if (result[0]?.exists) {
        foundColumns.push(expectedColumn);
      }
    }

    const missingColumns = check.expectedColumns.filter(
      (col) => !foundColumns.includes(col)
    );

    if (missingColumns.length === 0) {
      console.log(`✅ ${check.tableName}: All columns present`);
      console.log(`   Found: ${foundColumns.join(', ')}`);
    } else {
      console.error(`❌ ${check.tableName}: Missing columns!`);
      console.error(`   Expected: ${check.expectedColumns.join(', ')}`);
      console.error(`   Found: ${foundColumns.join(', ') || '(none)'}`);
      console.error(`   Missing: ${missingColumns.join(', ')}`);
      allPassed = false;
    }
    console.log('');
  }

  await prisma.$disconnect();

  if (!allPassed) {
    console.error('❌ Schema verification failed!');
    console.error('   Migration may have partially applied.');
    console.error('   Review migration logs and database state.');
    process.exit(1);
  }

  console.log('✅ Schema verification passed!');
  process.exit(0);
}

// Run verification
verifySchema().catch((error) => {
  console.error('❌ Verification script error:', error);
  process.exit(1);
});

