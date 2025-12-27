import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const orgId = process.argv[2];
  
  if (!orgId) {
    console.log('No ORG_ID provided. Listing all organisations:\n');
    const orgs = await prisma.organisation.findMany({
      select: {
        id: true,
        name: true,
        createdAt: true
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 20
    });
    
    if (orgs.length === 0) {
      console.log('No organisations found.');
      process.exit(1);
    }
    
    console.table(orgs);
    console.log('\nUsage: tsx scripts/query-lexicon.ts <ORG_ID>');
    process.exit(0);
  }

  // Try new schema first, fall back to old schema if migration hasn't been run
  let entries;
  try {
    entries = await prisma.organisationLexiconEntry.findMany({
      where: {
        organisationId: orgId
      },
      select: {
        id: true,
        phrase: true,
        ownerSupplierId: true,
        isOrgWide: true,
        timesSeen: true,
        lastSeenAt: true,
        createdAt: true,
        orgWideManuallyDisabledAt: true
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 30
    });
  } catch (error: any) {
    if (error.code === 'P2022') {
      // Migration not run yet - use old schema
      console.log('Note: Migration not run yet, using old schema fields\n');
      entries = await (prisma as any).organisationLexiconEntry.findMany({
        where: {
          organisationId: orgId
        },
        select: {
          id: true,
          phrase: true,
          supplierId: true,
          scopeKey: true,
          timesSeen: true,
          lastSeenAt: true,
          createdAt: true
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: 30
      });
    } else {
      throw error;
    }
  }

  console.log(`\nFound ${entries.length} lexicon entries for organisation ${orgId}:\n`);
  if (entries.length > 0) {
    console.table(entries);
  } else {
    console.log('No lexicon entries found for this organisation.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

