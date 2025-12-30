-- Migration: Make Approved Terms Org-Wide Only
-- Consolidates duplicate rows per (organisationId, phrase) and removes supplier scope

-- Step 1: Data consolidation - Create temporary table with winner rows
-- Winner selection: prefer max(timesSeen) or most recent lastSeenAt
CREATE TEMP TABLE lexicon_winners AS
WITH RankedEntries AS (
    SELECT 
        id,
        "organisationId",
        "phrase",
        "timesSeen",
        "lastSeenAt",
        "createdAt",
        ROW_NUMBER() OVER (
            PARTITION BY "organisationId", "phrase" 
            ORDER BY 
                "timesSeen" DESC,      -- Prefer higher usage
                "lastSeenAt" DESC      -- Prefer most recent
        ) as rn
    FROM "OrganisationLexiconEntry"
),
GroupedStats AS (
    SELECT 
        "organisationId",
        "phrase",
        SUM("timesSeen") as "totalTimesSeen",
        MAX("lastSeenAt") as "maxLastSeenAt",
        MIN("createdAt") as "minCreatedAt"
    FROM "OrganisationLexiconEntry"
    GROUP BY "organisationId", "phrase"
)
SELECT 
    r.id,
    r."organisationId",
    r."phrase",
    gs."totalTimesSeen" as "timesSeen",
    gs."maxLastSeenAt" as "lastSeenAt",
    gs."minCreatedAt" as "createdAt"
FROM RankedEntries r
INNER JOIN GroupedStats gs ON gs."organisationId" = r."organisationId" AND gs."phrase" = r."phrase"
WHERE r.rn = 1;

-- Step 2: Update winner rows with aggregated data
UPDATE "OrganisationLexiconEntry" ole
SET 
    "timesSeen" = w."timesSeen",
    "lastSeenAt" = w."lastSeenAt",
    "createdAt" = w."createdAt"
FROM lexicon_winners w
WHERE ole.id = w.id;

-- Step 3: Delete duplicates (all non-winner rows)
DELETE FROM "OrganisationLexiconEntry"
WHERE id NOT IN (SELECT id FROM lexicon_winners);

-- Clean up temp table
DROP TABLE IF EXISTS lexicon_winners;

-- Step 4: Drop old columns
ALTER TABLE "OrganisationLexiconEntry" 
  DROP COLUMN "ownerSupplierId",
  DROP COLUMN "isOrgWide",
  DROP COLUMN "orgWideManuallyDisabledAt";

-- Step 5: Drop old unique constraint and indexes
DROP INDEX IF EXISTS "OrganisationLexiconEntry_organisationId_ownerSupplierId_phrase_key";
DROP INDEX IF EXISTS "OrganisationLexiconEntry_organisationId_isOrgWide_idx";
DROP INDEX IF EXISTS "OrganisationLexiconEntry_organisationId_ownerSupplierId_idx";

-- Step 6: Add new unique constraint
CREATE UNIQUE INDEX "OrganisationLexiconEntry_organisationId_phrase_key" 
  ON "OrganisationLexiconEntry"("organisationId", "phrase");

-- Step 7: Add new indexes
CREATE INDEX IF NOT EXISTS "OrganisationLexiconEntry_organisationId_phrase_idx" 
  ON "OrganisationLexiconEntry"("organisationId", "phrase");
CREATE INDEX IF NOT EXISTS "OrganisationLexiconEntry_lastSeenAt_idx" 
  ON "OrganisationLexiconEntry"("lastSeenAt");


