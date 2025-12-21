import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import prisma from '../../src/infrastructure/prismaClient';
import { signAccessToken } from '../../src/utils/jwt';
import { ocrService } from '../../src/services/OcrService';

describe('Invoice OCR fanout controls', () => {
  let app: any;

  const user = { id: 'user-a', email: 'a@test.com', name: 'User A' };
  const org = { id: 'org-a', name: 'Org A' };
  const loc = { id: 'loc-a', name: 'Loc A', organisationId: org.id };

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();

    await prisma.user.create({
      data: { id: user.id, email: user.email, passwordHash: 'hash', name: user.name },
    });
    await prisma.organisation.create({ data: org });
    await prisma.location.create({ data: loc });

    // Seed 10 processing invoice files
    await prisma.invoiceFile.createMany({
      data: Array.from({ length: 10 }).map((_, idx) => ({
        id: `file-${idx + 1}`,
        organisationId: org.id,
        locationId: loc.id,
        sourceType: 'UPLOAD',
        storageKey: `test/file-${idx + 1}.pdf`,
        fileName: `file-${idx + 1}.pdf`,
        mimeType: 'application/pdf',
        processingStatus: 'OCR_PROCESSING',
        ocrJobId: `job-${idx + 1}`,
        reviewStatus: 'NONE',
      })) as any,
    });
  });

  function makeLocationToken() {
    return signAccessToken({
      sub: user.id,
      orgId: org.id,
      locId: loc.id,
      tokenType: 'location',
      roles: ['owner'],
      tokenVersion: 0,
    });
  }

  it('default list does not trigger OCR polling (refreshProcessing=false)', async () => {
    const spy = vi.spyOn(ocrService, 'getAnalysisResults').mockResolvedValue({ JobStatus: 'IN_PROGRESS' } as any);

    const token = makeLocationToken();
    const res = await app.inject({
      method: 'GET',
      url: `/invoices/locations/${loc.id}?page=1&limit=20`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('refreshProcessing=true triggers OCR polling but is capped to 5', async () => {
    const spy = vi.spyOn(ocrService, 'getAnalysisResults').mockResolvedValue({ JobStatus: 'IN_PROGRESS' } as any);

    const token = makeLocationToken();
    const res = await app.inject({
      method: 'GET',
      url: `/invoices/locations/${loc.id}?page=1&limit=20&refreshProcessing=true`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('batch endpoint enforces cap and per-id action semantics', async () => {
    const spy = vi.spyOn(ocrService, 'getAnalysisResults').mockResolvedValue({ JobStatus: 'IN_PROGRESS' } as any);

    // Make one file non-processing
    await prisma.invoiceFile.update({
      where: { id: 'file-1' },
      data: { processingStatus: 'OCR_COMPLETE', ocrJobId: null },
    });

    const token = makeLocationToken();
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/ocr-status/batch`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { invoiceFileIds: ['file-1', 'file-2', 'missing-file'] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.results)).toBe(true);

    const r1 = body.results.find((r: any) => r.invoiceFileId === 'file-1');
    const r2 = body.results.find((r: any) => r.invoiceFileId === 'file-2');
    const r3 = body.results.find((r: any) => r.invoiceFileId === 'missing-file');

    expect(r1.action).toBe('skipped_not_processing');
    expect(r1.polled).toBe(false);

    expect(r2.action).toBe('checked');
    expect(r2.polled).toBe(true);

    expect(r3.action).toBe('skipped_not_found');
    expect(r3.polled).toBe(false);

    // Only one processing item was checked
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('batch endpoint rejects payloads > 20', async () => {
    const token = makeLocationToken();
    const ids = Array.from({ length: 21 }).map((_, i) => `file-${i + 1}`);

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/ocr-status/batch`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { invoiceFileIds: ids },
    });

    expect(res.statusCode).toBe(400);
  });
});

