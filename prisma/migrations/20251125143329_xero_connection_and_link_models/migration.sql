/*
  Warnings:

  - You are about to drop the column `accessTokenEncrypted` on the `XeroConnection` table. All the data in the column will be lost.
  - You are about to drop the column `accessTokenExpiresAt` on the `XeroConnection` table. All the data in the column will be lost.
  - You are about to drop the column `refreshTokenEncrypted` on the `XeroConnection` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `XeroConnection` table. All the data in the column will be lost.
  - Added the required column `accessToken` to the `XeroConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `expiresAt` to the `XeroConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `refreshToken` to the `XeroConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenantName` to the `XeroConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `XeroConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `organisationId` to the `XeroLocationLink` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "XeroLocationLink_xeroConnectionId_locationId_key";

-- AlterTable
ALTER TABLE "XeroConnection" DROP COLUMN "accessTokenEncrypted",
DROP COLUMN "accessTokenExpiresAt",
DROP COLUMN "refreshTokenEncrypted",
DROP COLUMN "status",
ADD COLUMN     "accessToken" TEXT NOT NULL,
ADD COLUMN     "expiresAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "refreshToken" TEXT NOT NULL,
ADD COLUMN     "tenantName" TEXT NOT NULL,
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "XeroLocationLink" ADD COLUMN     "organisationId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "XeroConnection" ADD CONSTRAINT "XeroConnection_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XeroConnection" ADD CONSTRAINT "XeroConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XeroLocationLink" ADD CONSTRAINT "XeroLocationLink_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XeroLocationLink" ADD CONSTRAINT "XeroLocationLink_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
