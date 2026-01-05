import prisma from '../infrastructure/prismaClient';
import { Prisma } from '@prisma/client';

/**
 * Soft-delete duplicate InvoiceFiles per (organisationId, locationId, sourceReference, fileName).
 * Rationale: a Xero bill can have multiple attachments; we only treat entries with the SAME fileName
 * (same attachment) as duplicates. Distinct attachments for the same invoice are preserved.
 * Keeps the newest OCR_COMPLETE/VERIFIED/REVIEWED if present; otherwise keeps the newest record.
 * Defaults to DRY_RUN unless DRY_RUN=false.
 */

type Row = {
  id: string;
  organisationId: string;
  locationId: string;
  sourceReference: string | null;
  fileName: string;
  processingStatus: string;
  updatedAt: Date;
  keep: boolean;
};

export async function runDedupe() {
  const dryRun = process.env.DRY_RUN !== 'false';
  const keepStatuses = ['OCR_COMPLETE', 'VERIFIED', 'REVIEWED'];

  // Use a window function to pick the record to keep
  const rows = await prisma.$queryRaw<Row[]>`
    with ranked as (
      select
        id,
        "organisationId",
        "locationId",
        "sourceReference",
        "fileName",
        "processingStatus",
        "updatedAt",
        row_number() over (
          partition by "organisationId", "locationId", coalesce("sourceReference", 'null'), coalesce("fileName", 'null')
          order by
            case when "processingStatus"::text in (${Prisma.join(keepStatuses)}) then 0 else 1 end,
            "updatedAt" desc
        ) as rn
      from "InvoiceFile"
      where "deletedAt" is null
        and "sourceType" = 'XERO'
        and "sourceReference" is not null
    )
    select
      id,
      "organisationId",
      "locationId",
      "sourceReference",
      "fileName",
      "processingStatus",
      "updatedAt",
      (rn = 1) as keep
    from ranked
    where rn > 1;
  `;

  const idsToDelete = rows.filter(r => !r.keep).map(r => r.id);

  console.log(`[Dedupe] Found ${rows.length} duplicate rows, will soft-delete ${idsToDelete.length} (dryRun=${dryRun})`);

  if (!dryRun && idsToDelete.length > 0) {
    const res = await prisma.invoiceFile.updateMany({
      where: { id: { in: idsToDelete } },
      data: { deletedAt: new Date(), failureReason: 'dedupe: removed duplicate in location for same fileName' },
    });
    console.log(`[Dedupe] Soft-deleted ${res.count} invoice files`);
  }
}

if (require.main === module) {
  runDedupe()
    .then(() => {
      console.log('[Dedupe] Completed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Dedupe] Failed', err);
      process.exit(1);
    });
}

