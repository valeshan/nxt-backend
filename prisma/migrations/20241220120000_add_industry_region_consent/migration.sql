-- CreateEnum
CREATE TYPE "VenueIndustry" AS ENUM ('CAFE', 'RESTAURANT', 'BAR', 'BAKERY', 'RETAIL', 'HOTEL', 'CATERING', 'OTHER');

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN "dataContributionEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Organisation" ADD COLUMN "dataContributionUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Location" ADD COLUMN "industry" "VenueIndustry";
ALTER TABLE "Location" ADD COLUMN "region" TEXT;
