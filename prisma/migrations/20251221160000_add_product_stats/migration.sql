-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ProductStatsSource" AS ENUM ('XERO', 'MANUAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductStats" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "accountCodesHash" TEXT NOT NULL,
    "source" "ProductStatsSource" NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "spend12m" DECIMAL(19,4) NOT NULL,
    "statsAsOf" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductStats_org_loc_hash_source_productId_key"
ON "ProductStats"("organisationId", "locationId", "accountCodesHash", "source", "productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductStats_organisationId_locationId_accountCodesHash_idx"
ON "ProductStats"("organisationId", "locationId", "accountCodesHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductStats_org_loc_hash_source_spend_idx"
ON "ProductStats"("organisationId", "locationId", "accountCodesHash", "source", "spend12m");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductStats"
  ADD CONSTRAINT "ProductStats_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductStats"
  ADD CONSTRAINT "ProductStats_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;



