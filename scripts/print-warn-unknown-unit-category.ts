import prisma from '../src/infrastructure/prismaClient';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

async function main() {
  const organisationId = process.env.ORG_ID || requireEnv('ORGANISATION_ID');
  const locationId = process.env.LOC_ID || requireEnv('LOCATION_ID');

  const rows = await prisma.$queryRaw<any[]>`
    WITH parsed AS (
      SELECT
        li.*,
        CASE
          WHEN li."sourceLineRef" LIKE 'invoiceId:%' THEN split_part(li."sourceLineRef", ':', 2)
          ELSE NULL
        END AS legacy_invoice_id_from_ref,
        CASE
          WHEN li."sourceLineRef" LIKE 'invoiceId:%' THEN split_part(li."sourceLineRef", ':', 4)
          ELSE NULL
        END AS legacy_invoice_line_item_id_from_ref
      FROM "CanonicalInvoiceLineItem" li
      WHERE li."organisationId" = ${organisationId}
        AND li."locationId" = ${locationId}
        AND li."qualityStatus" = 'WARN'
        AND 'UNKNOWN_UNIT_CATEGORY' = ANY(li."warnReasons")
    )
    SELECT
      li.id AS "canonicalLineId",
      li."supplierId" AS "supplierId",
      s.name AS "supplierName",
      li."rawDescription" AS "description",
      li."rawQuantityText" AS "rawQuantityText",
      li."rawUnitText" AS "rawUnitText",
      li.quantity::text AS "quantity",
      li."unitCategory"::text AS "unitCategory",
      li."warnReasons" AS "warnReasons",
      ci."legacyInvoiceId" AS "legacyInvoiceId",
      li."sourceLineRef" AS "sourceLineRef",
      ili.id AS "legacyLineItemId",
      ili.description AS "legacyLineDescription",
      ili.quantity::text AS "legacyLineQuantity",
      ili."unitPrice"::text AS "legacyLineUnitPrice",
      ili."lineTotal"::text AS "legacyLineTotal",
      ili."productCode" AS "legacyLineProductCode",
      i."invoiceFileId" AS "legacyInvoiceFileId",
      i."isVerified" AS "legacyInvoiceIsVerified",
      i.date AS "legacyInvoiceDate"
    FROM parsed li
    JOIN "CanonicalInvoice" ci ON ci.id = li."canonicalInvoiceId"
    LEFT JOIN "Supplier" s ON s.id = li."supplierId"
    LEFT JOIN "Invoice" i ON i.id = li.legacy_invoice_id_from_ref
    LEFT JOIN "InvoiceLineItem" ili ON ili.id = li.legacy_invoice_line_item_id_from_ref
    WHERE ci."deletedAt" IS NULL
    ORDER BY ci.date DESC NULLS LAST, li.id ASC
  `;

  // Print as stable JSON array so it can be copy/pasted into analysis / tooling.
  console.log(JSON.stringify({ organisationId, locationId, count: rows.length, rows }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


