-- CreateTable
CREATE TABLE "OrganisationLexiconEntry" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "supplierId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "timesSeen" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganisationLexiconEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganisationLexiconEntry_organisationId_idx" ON "OrganisationLexiconEntry"("organisationId");

-- CreateIndex
CREATE INDEX "OrganisationLexiconEntry_organisationId_supplierId_idx" ON "OrganisationLexiconEntry"("organisationId", "supplierId");

-- CreateIndex
CREATE INDEX "OrganisationLexiconEntry_organisationId_scopeKey_idx" ON "OrganisationLexiconEntry"("organisationId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrganisationLexiconEntry_organisationId_scopeKey_phrase_key" ON "OrganisationLexiconEntry"("organisationId", "scopeKey", "phrase");

-- AddForeignKey
ALTER TABLE "OrganisationLexiconEntry" ADD CONSTRAINT "OrganisationLexiconEntry_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganisationLexiconEntry" ADD CONSTRAINT "OrganisationLexiconEntry_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
