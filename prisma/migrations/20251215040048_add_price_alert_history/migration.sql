-- CreateTable
CREATE TABLE "PriceAlertHistory" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "oldPrice" DECIMAL(19,4) NOT NULL,
    "newPrice" DECIMAL(19,4) NOT NULL,
    "percentChange" DECIMAL(19,4) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "recipientEmail" TEXT NOT NULL,

    CONSTRAINT "PriceAlertHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceAlertHistory_organisationId_supplierId_productId_sentA_idx" ON "PriceAlertHistory"("organisationId", "supplierId", "productId", "sentAt");
