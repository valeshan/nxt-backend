-- AlterTable
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'Location' AND column_name = 'hasSeenAutoApprovePrompt') THEN
    ALTER TABLE "Location" ADD COLUMN "hasSeenAutoApprovePrompt" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;


