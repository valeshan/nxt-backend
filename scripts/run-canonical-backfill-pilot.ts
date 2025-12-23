/**
 * Sprint B helper: enqueue canonical backfill for a single org+location, poll job status, then run parity.
 *
 * Usage:
 *   tsx scripts/run-canonical-backfill-pilot.ts --org <orgId> --loc <locationId> [--source ALL|OCR|XERO] [--limit 200] [--baseUrl http://localhost:3001]
 *
 * Env:
 *   INTERNAL_API_KEY (required)
 */
const DEFAULT_BASE_URL = 'http://localhost:3001';

type Args = {
  org: string;
  loc: string;
  source: 'ALL' | 'OCR' | 'XERO';
  limit: number;
  baseUrl: string;
};

function parseArgs(argv: string[]): Args {
  const get = (key: string) => {
    const idx = argv.indexOf(key);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const org = get('--org') || '';
  const loc = get('--loc') || '';
  const source = (get('--source') || 'ALL').toUpperCase() as Args['source'];
  const limit = Number(get('--limit') || 200);
  const baseUrl = get('--baseUrl') || DEFAULT_BASE_URL;

  if (!org || !loc) {
    throw new Error('Missing required args: --org and --loc are required');
  }
  if (!['ALL', 'OCR', 'XERO'].includes(source)) {
    throw new Error('--source must be one of ALL|OCR|XERO');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('--limit must be a positive number');
  }

  return { org, loc, source, limit, baseUrl };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.INTERNAL_API_KEY;
  if (!apiKey) {
    throw new Error('Missing INTERNAL_API_KEY env var');
  }

  const headers = {
    'content-type': 'application/json',
    'x-internal-api-key': apiKey,
  };

  const backfillRes = await fetch(`${args.baseUrl}/admin/canonical/backfill`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      organisationId: args.org,
      locationId: args.loc,
      source: args.source,
      limit: args.limit,
    }),
  });

  if (!backfillRes.ok) {
    const text = await backfillRes.text();
    throw new Error(`Backfill enqueue failed (${backfillRes.status}): ${text}`);
  }

  const { jobId } = (await backfillRes.json()) as { jobId: string };
  // eslint-disable-next-line no-console
  console.log(`[canonical-backfill] enqueued jobId=${jobId}`);

  // Poll status (query-param endpoint is more robust for job IDs containing special chars)
  const startedAt = Date.now();
  while (true) {
    const statusRes = await fetch(`${args.baseUrl}/admin/jobs?jobId=${encodeURIComponent(jobId)}`, {
      headers,
    });
    if (!statusRes.ok) {
      const text = await statusRes.text();
      throw new Error(`Job status failed (${statusRes.status}): ${text}`);
    }

    const status = (await statusRes.json()) as any;
    const s = status?.state || status?.status || 'unknown';
    const progress = status?.progress;

    // eslint-disable-next-line no-console
    console.log(`[canonical-backfill] state=${s} progress=${progress ? JSON.stringify(progress) : '—'}`);

    if (s === 'completed' || s === 'failed') {
      if (s === 'failed') {
        throw new Error(`Backfill job failed: ${status?.failedReason || status?.error || 'unknown error'}`);
      }
      break;
    }

    // 2s polling interval
    await sleep(2000);

    // Safety timeout (10 minutes)
    if (Date.now() - startedAt > 10 * 60_000) {
      throw new Error('Timed out waiting for backfill job to complete (10m)');
    }
  }

  const parityRes = await fetch(`${args.baseUrl}/admin/canonical/parity`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ organisationId: args.org, locationId: args.loc }),
  });

  if (!parityRes.ok) {
    const text = await parityRes.text();
    throw new Error(`Parity failed (${parityRes.status}): ${text}`);
  }

  const parity = await parityRes.json();
  // eslint-disable-next-line no-console
  console.log(`[canonical-parity] ${JSON.stringify(parity, null, 2)}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});


