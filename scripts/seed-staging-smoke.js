/* eslint-disable @typescript-eslint/no-var-requires */
const { PrismaClient, SupplierSourceType, SupplierStatus, Prisma } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  const envName = process.env.ENVIRONMENT_NAME;
  const allow = process.env.ALLOW_STAGING_SMOKE_SEED === 'true';

  if (envName !== 'staging' && !allow) {
    throw new Error('Refusing to seed: ENVIRONMENT_NAME must be "staging" (or set ALLOW_STAGING_SMOKE_SEED=true for explicit override).');
  }

  const email = process.env.SMOKE_USER_EMAIL || 'smoke-staging@nxt.dev';
  const password = process.env.SMOKE_USER_PASSWORD || 'SmokeTest123!';
  const orgName = process.env.SMOKE_ORG_NAME || 'Smoke Test Org';
  const locationName = process.env.SMOKE_LOCATION_NAME || 'Smoke Test Location';
  const supplierName = process.env.SMOKE_SUPPLIER_NAME || 'Smoke Supplier';
  const productName = process.env.SMOKE_PRODUCT_NAME || 'Smoke Product';
  const productKey = (process.env.SMOKE_PRODUCT_KEY || 'smoke-product').toLowerCase();
  const accountCode = process.env.SMOKE_ACCOUNT_CODE || '500';

  const passwordHash = await bcrypt.hash(password, 10);
  const normalisedSupplier = supplierName.trim().toLowerCase();

  console.log('[seed] Starting staging smoke seed (JS fallback)...');

  // Organisation
  let organisation = await prisma.organisation.findFirst({ where: { name: orgName } });
  if (!organisation) {
    organisation = await prisma.organisation.create({ data: { name: orgName } });
    console.log('[seed] Created organisation', organisation.id);
  } else {
    console.log('[seed] Reusing organisation', organisation.id);
  }

  // Location
  let location = await prisma.location.findFirst({
    where: { name: locationName, organisationId: organisation.id },
  });
  if (!location) {
    location = await prisma.location.create({
      data: {
        name: locationName,
        organisationId: organisation.id,
      },
    });
    console.log('[seed] Created location', location.id);
  } else {
    console.log('[seed] Reusing location', location.id);
  }

  // User
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: 'Smoke',
        lastName: 'Tester',
        name: 'Smoke Tester',
      },
    });
    console.log('[seed] Created user', user.id);
  } else {
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    console.log('[seed] Reusing user', user.id);
  }

  // User Settings
  const userSettings = await prisma.userSettings.findUnique({ where: { userId: user.id } });
  if (!userSettings) {
    await prisma.userSettings.create({ data: { userId: user.id } });
    console.log('[seed] Created user settings');
  }

  // UserOrganisation (owner)
  const userOrg = await prisma.userOrganisation.findFirst({
    where: { userId: user.id, organisationId: organisation.id },
  });
  if (!userOrg) {
    await prisma.userOrganisation.create({
      data: {
        userId: user.id,
        organisationId: organisation.id,
        role: 'owner',
      },
    });
    console.log('[seed] Linked user to organisation as owner');
  }

  // Supplier
  let supplier = await prisma.supplier.findFirst({
    where: { organisationId: organisation.id, normalizedName: normalisedSupplier },
  });
  if (!supplier) {
    supplier = await prisma.supplier.create({
      data: {
        organisationId: organisation.id,
        name: supplierName,
        normalizedName: normalisedSupplier,
        sourceType: SupplierSourceType.MANUAL,
        status: SupplierStatus.ACTIVE,
      },
    });
    console.log('[seed] Created supplier', supplier.id);
  } else {
    console.log('[seed] Reusing supplier', supplier.id);
  }

  // Product
  let product = await prisma.product.findFirst({
    where: { organisationId: organisation.id, locationId: location.id, productKey },
  });
  if (!product) {
    product = await prisma.product.create({
      data: {
        organisationId: organisation.id,
        locationId: location.id,
        supplierId: supplier.id,
        productKey,
        name: productName,
      },
    });
    console.log('[seed] Created product', product.id);
  } else {
    console.log('[seed] Reusing product', product.id);
  }

  // Invoice + line item (Xero flavour, minimal)
  const xeroInvoiceId = 'smoke-xero-invoice-1';
  let invoice = await prisma.xeroInvoice.findFirst({ where: { xeroInvoiceId } });
  if (!invoice) {
    invoice = await prisma.xeroInvoice.create({
      data: {
        organisationId: organisation.id,
        locationId: location.id,
        supplierId: supplier.id,
        xeroInvoiceId,
        invoiceNumber: 'SMOKE-INV-001',
        status: 'AUTHORISED',
        date: new Date(),
        total: new Prisma.Decimal(100),
        subTotal: new Prisma.Decimal(100),
        amountDue: new Prisma.Decimal(0),
        amountPaid: new Prisma.Decimal(100),
        currencyCode: 'USD',
      },
    });
    console.log('[seed] Created xeroInvoice', invoice.id);
  } else {
    console.log('[seed] Reusing xeroInvoice', invoice.id);
  }

  const lineExisting = await prisma.xeroInvoiceLineItem.findFirst({
    where: { invoiceId: invoice.id, productId: product.id },
  });
  if (!lineExisting) {
    await prisma.xeroInvoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        productId: product.id,
        description: 'Smoke test line item',
        quantity: new Prisma.Decimal(5),
        unitAmount: new Prisma.Decimal(20),
        lineAmount: new Prisma.Decimal(100),
        accountCode,
        accountName: 'COGS',
        itemCode: 'SMOKE',
      },
    });
    console.log('[seed] Created line item');
  } else {
    console.log('[seed] Reusing line item');
  }

  console.log('--- Seed complete ---');
  console.log(JSON.stringify({
    userEmail: email,
    userPassword: password,
    organisationId: organisation.id,
    locationId: location.id,
    supplierId: supplier.id,
    productId: product.id,
    xeroInvoiceId: invoice.xeroInvoiceId,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


