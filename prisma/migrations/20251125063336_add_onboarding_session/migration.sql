-- CreateEnum
CREATE TYPE "OnboardingMode" AS ENUM ('xero', 'manual');

-- CreateTable
CREATE TABLE "OnboardingSession" (
    "id" TEXT NOT NULL,
    "mode" "OnboardingMode" NOT NULL,
    "email" TEXT,
    "organisationId" TEXT,
    "locationId" TEXT,
    "xeroConnectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OnboardingSession_pkey" PRIMARY KEY ("id")
);
