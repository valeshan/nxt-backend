-- Safe, idempotent migration to add sharedReportEmails to Location table
-- This fixes production where the column was incorrectly added to Organisation instead of Location

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Location' AND column_name = 'sharedReportEmails'
    ) THEN
        ALTER TABLE "Location" ADD COLUMN "sharedReportEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];
    END IF;
END $$;
