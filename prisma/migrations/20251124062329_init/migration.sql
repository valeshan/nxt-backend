-- CreateTable
CREATE TABLE "XeroConnection" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XeroLocationLink" (
    "id" TEXT NOT NULL,
    "xeroConnectionId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroLocationLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XeroLocationLink_xeroConnectionId_locationId_key" ON "XeroLocationLink"("xeroConnectionId", "locationId");

-- AddForeignKey
ALTER TABLE "XeroLocationLink" ADD CONSTRAINT "XeroLocationLink_xeroConnectionId_fkey" FOREIGN KEY ("xeroConnectionId") REFERENCES "XeroConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
