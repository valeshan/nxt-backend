-- AlterTable
ALTER TABLE "Location" 
    ADD COLUMN IF NOT EXISTS "hasSeenAutoApprovePrompt" BOOLEAN NOT NULL DEFAULT false;


