-- Add phraseKey column for aggressive normalization matching
-- This allows changing matching logic without breaking existing data

-- Step 1: Add phraseKey column (nullable initially for backfill)
ALTER TABLE "OrganisationLexiconEntry"
  ADD COLUMN "phraseKey" TEXT;

-- Step 2: Backfill phraseKey from phrase using aggressive normalization
-- IMPORTANT: PostgreSQL doesn't have NFKC normalization, so this is an approximation.
-- The exact normalization (NFKC + NBSP + whitespace collapse) will be handled by application code.
-- For existing data, we use a best-effort SQL normalization that's close enough.
-- New entries will use exact normalizePhraseKey() from application code.
UPDATE "OrganisationLexiconEntry"
SET "phraseKey" = LOWER(
  REGEXP_REPLACE(
    REGEXP_REPLACE(
      TRIM("phrase"),
      E'\\u00A0', ' ', 'g'  -- Replace NBSP (U+00A0) with space
    ),
    E'\\s+', ' ', 'g'  -- Collapse whitespace to single spaces
  )
);

-- Step 3: Consolidate duplicate rows per (organisationId, phraseKey)
-- Similar to previous migration, but using phraseKey instead of phrase
CREATE TEMP TABLE lexicon_winners_key AS
WITH RankedEntries AS (
    SELECT
        id,
        "organisationId",
        "phraseKey",
        "phrase",
        "timesSeen",
        "lastSeenAt",
        ROW_NUMBER() OVER (
            PARTITION BY "organisationId", "phraseKey"
            ORDER BY "timesSeen" DESC, "lastSeenAt" DESC
        ) as rn
    FROM "OrganisationLexiconEntry"
    WHERE "phraseKey" IS NOT NULL
)
SELECT id, "organisationId", "phraseKey", "phrase", "timesSeen", "lastSeenAt" 
FROM RankedEntries 
WHERE rn = 1;

CREATE TEMP TABLE lexicon_grouped_stats_key AS
SELECT
    "organisationId",
    "phraseKey",
    SUM("timesSeen") as "sumTimesSeen",
    MAX("lastSeenAt") as "maxLastSeenAt",
    MIN("createdAt") as "minCreatedAt",
    -- Keep the phrase from the winner (most seen/recent)
    (SELECT "phrase" FROM lexicon_winners_key w2 
     WHERE w2."organisationId" = ole."organisationId" 
     AND w2."phraseKey" = ole."phraseKey" 
     LIMIT 1) as "winnerPhrase"
FROM "OrganisationLexiconEntry" ole
WHERE "phraseKey" IS NOT NULL
GROUP BY "organisationId", "phraseKey";

-- Update winner rows with consolidated data
UPDATE "OrganisationLexiconEntry" ole
SET
    "timesSeen" = gs."sumTimesSeen",
    "lastSeenAt" = gs."maxLastSeenAt",
    "createdAt" = gs."minCreatedAt",
    "phrase" = gs."winnerPhrase"
FROM lexicon_winners_key w
JOIN lexicon_grouped_stats_key gs ON gs."organisationId" = w."organisationId" AND gs."phraseKey" = w."phraseKey"
WHERE ole.id = w.id;

-- Delete all non-winner duplicate rows
DELETE FROM "OrganisationLexiconEntry"
WHERE id NOT IN (SELECT id FROM lexicon_winners_key WHERE "phraseKey" IS NOT NULL)
AND "phraseKey" IS NOT NULL;

DROP TABLE IF EXISTS lexicon_winners_key;
DROP TABLE IF EXISTS lexicon_grouped_stats_key;

-- Step 4: Make phraseKey NOT NULL and drop old unique constraint
ALTER TABLE "OrganisationLexiconEntry"
  ALTER COLUMN "phraseKey" SET NOT NULL;

-- Drop old unique constraint on (organisationId, phrase)
DROP INDEX IF EXISTS "OrganisationLexiconEntry_organisationId_phrase_key";

-- Step 5: Add new unique constraint and indexes on phraseKey
ALTER TABLE "OrganisationLexiconEntry" 
  ADD CONSTRAINT "OrganisationLexiconEntry_organisationId_phraseKey_key" 
  UNIQUE ("organisationId", "phraseKey");

-- Drop old index on (organisationId, phrase) if it exists
DROP INDEX IF EXISTS "OrganisationLexiconEntry_organisationId_phrase_idx";

-- Add new indexes
CREATE INDEX IF NOT EXISTS "OrganisationLexiconEntry_organisationId_phraseKey_idx" 
  ON "OrganisationLexiconEntry"("organisationId", "phraseKey");
CREATE INDEX IF NOT EXISTS "OrganisationLexiconEntry_phraseKey_idx" 
  ON "OrganisationLexiconEntry"("phraseKey");

