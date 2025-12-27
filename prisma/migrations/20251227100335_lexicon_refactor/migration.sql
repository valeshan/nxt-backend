-- Migration: Refactor OrganisationLexiconEntry to use single-row model with isOrgWide flag
-- Replaces scopeKey-based duplicate ORG rows with ownerSupplierId + isOrgWide pattern

-- Step 1: Add new columns (temporarily nullable for migration)
ALTER TABLE "OrganisationLexiconEntry" 
  ADD COLUMN "ownerSupplierId" TEXT,
  ADD COLUMN "isOrgWide" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "orgWideManuallyDisabledAt" TIMESTAMP(3);

-- Step 2: Create temporary table to store winner IDs
CREATE TEMP TABLE lexicon_winners AS
WITH RankedEntries AS (
    SELECT 
        id,
        "organisationId",
        "phrase",
        "timesSeen",
        "lastSeenAt",
        "scopeKey",
        "supplierId",
        ROW_NUMBER() OVER (
            PARTITION BY "organisationId", "phrase" 
            ORDER BY 
                CASE WHEN "scopeKey" != 'ORG' THEN 1 ELSE 2 END ASC, -- Prefer Supplier rows
                "timesSeen" DESC,                                     -- Prefer higher usage
                "lastSeenAt" DESC                                     -- Prefer most recent
        ) as rn
    FROM "OrganisationLexiconEntry"
)
SELECT * FROM RankedEntries WHERE rn = 1;

-- Step 3: Identify if an ORG row existed for each group (to set isOrgWide=true)
CREATE TEMP TABLE lexicon_has_org_wide AS
SELECT DISTINCT "organisationId", "phrase"
FROM "OrganisationLexiconEntry"
WHERE "scopeKey" = 'ORG';

-- Step 4: Aggregate timesSeen and lastSeenAt from all rows in each group
CREATE TEMP TABLE lexicon_grouped_stats AS
SELECT 
    "organisationId",
    "phrase",
    MAX("timesSeen") as "maxTimesSeen",
    MAX("lastSeenAt") as "maxLastSeenAt"
FROM "OrganisationLexiconEntry"
GROUP BY "organisationId", "phrase";

-- Step 5: Update the Winners with consolidated data
UPDATE "OrganisationLexiconEntry" ole
SET 
    "isOrgWide" = CASE 
        WHEN how."organisationId" IS NOT NULL THEN true 
        ELSE false 
    END,
    "ownerSupplierId" = CASE
        WHEN ole."scopeKey" = 'ORG' THEN '__ORG__' -- Legacy global-only rows
        WHEN ole."supplierId" IS NOT NULL THEN ole."supplierId"::TEXT
        ELSE '__ORG__' -- Fallback
    END,
    "timesSeen" = COALESCE(gs."maxTimesSeen", ole."timesSeen"),
    "lastSeenAt" = COALESCE(gs."maxLastSeenAt", ole."lastSeenAt")
FROM lexicon_winners w
LEFT JOIN lexicon_has_org_wide how ON how."organisationId" = w."organisationId" AND how."phrase" = w."phrase"
LEFT JOIN lexicon_grouped_stats gs ON gs."organisationId" = w."organisationId" AND gs."phrase" = w."phrase"
WHERE ole.id = w.id;

-- Step 6: Delete the Losers (everything else)
DELETE FROM "OrganisationLexiconEntry"
WHERE id NOT IN (SELECT id FROM lexicon_winners);

-- Clean up temp tables
DROP TABLE IF EXISTS lexicon_winners;
DROP TABLE IF EXISTS lexicon_has_org_wide;
DROP TABLE IF EXISTS lexicon_grouped_stats;

-- Step 7: Backfill any remaining null ownerSupplierId (shouldn't happen, but safety check)
UPDATE "OrganisationLexiconEntry"
SET "ownerSupplierId" = '__ORG__'
WHERE "ownerSupplierId" IS NULL;

-- Step 8: Make ownerSupplierId NOT NULL
ALTER TABLE "OrganisationLexiconEntry" 
  ALTER COLUMN "ownerSupplierId" SET NOT NULL;

-- Step 9: Drop old columns, constraints, and indexes
ALTER TABLE "OrganisationLexiconEntry" 
  DROP COLUMN "scopeKey",
  DROP COLUMN "supplierId";

-- Drop old unique constraint
DROP INDEX IF EXISTS "OrganisationLexiconEntry_organisationId_scopeKey_phrase_key";

-- Drop old indexes
DROP INDEX IF EXISTS "OrganisationLexiconEntry_organisationId_supplierId_idx";
DROP INDEX IF EXISTS "OrganisationLexiconEntry_organisationId_scopeKey_idx";

-- Step 10: Add new unique constraint and indexes
CREATE UNIQUE INDEX "OrganisationLexiconEntry_organisationId_ownerSupplierId_phrase_key" 
  ON "OrganisationLexiconEntry"("organisationId", "ownerSupplierId", "phrase");

CREATE INDEX "OrganisationLexiconEntry_organisationId_isOrgWide_idx" 
  ON "OrganisationLexiconEntry"("organisationId", "isOrgWide");

CREATE INDEX "OrganisationLexiconEntry_organisationId_ownerSupplierId_idx" 
  ON "OrganisationLexiconEntry"("organisationId", "ownerSupplierId");

