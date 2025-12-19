import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { invoicePipelineService } from '../../src/services/InvoicePipelineService';
import prisma from '../../src/infrastructure/prismaClient';
import { resetDb, teardown } from './testApp';
import { ProcessingStatus, OcrFailureCategory } from '@prisma/client';
import { pusherService } from '../../src/services/pusherService';
import { vi } from 'vitest';

// Mock Pusher service
vi.mock('../../src/services/pusherService', () => ({
  pusherService: {
    getOrgChannel: vi.fn(() => 'test-channel'),
    triggerEvent: vi.fn(),
  },
}));

describe('Invoice OCR Failure Handling', () => {
  const orgId = 'ocr-failure-org-id';
  const locationId = 'ocr-failure-loc-id';

  beforeAll(async () => {
    await resetDb();
    
    // Create test organisation and location
    await prisma.organisation.create({
      data: {
        id: orgId,
        name: 'Test Org',
      },
    });
    
    await prisma.location.create({
      data: {
        id: locationId,
        organisationId: orgId,
        name: 'Test Location',
      },
    });
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    // Clean up invoice files before each test
    await prisma.invoiceFile.deleteMany({
      where: { organisationId: orgId },
    });
    
    // Reset Pusher mocks
    vi.clearAllMocks();
  });

  describe('startOcrProcessing sends Pusher on early failure', () => {
    it('should send Pusher event when OCR fails before ocrJobId is set', async () => {
      // Create an invoice file in PENDING_OCR
      const invoiceFile = await prisma.invoiceFile.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          fileName: 'test-invoice.pdf',
          sourceType: 'UPLOAD',
          storageKey: 'test-key',
          mimeType: 'application/pdf',
          processingStatus: ProcessingStatus.PENDING_OCR,
          reviewStatus: 'NONE',
        },
      });

      // Mock ocrService to throw an error
      const originalStartAnalysis = (await import('../../src/services/OcrService')).ocrService.startAnalysis;
      vi.spyOn((await import('../../src/services/OcrService')).ocrService, 'startAnalysis').mockRejectedValue(
        new Error('Textract service unavailable')
      );

      try {
        await invoicePipelineService.startOcrProcessing(invoiceFile.id);
      } catch (e) {
        // Expected to fail
      }

      // Verify DB was updated to OCR_FAILED
      const updated = await prisma.invoiceFile.findUnique({
        where: { id: invoiceFile.id },
      });
      expect(updated?.processingStatus).toBe(ProcessingStatus.OCR_FAILED);

      // Verify Pusher event was sent
      expect(pusherService.triggerEvent).toHaveBeenCalledWith(
        'test-channel',
        'invoice-status-updated',
        expect.objectContaining({
          invoiceFileId: invoiceFile.id,
          status: ProcessingStatus.OCR_FAILED,
          locationId: locationId,
          ocrFailureCategory: expect.any(String),
        })
      );
    });
  });

  describe('cleanupOrphanedOcrJobs', () => {
    it('should retry stuck PENDING_OCR files', async () => {
      const staleDate = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
      
      const invoiceFile = await prisma.invoiceFile.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          fileName: 'stuck-invoice.pdf',
          sourceType: 'UPLOAD',
          storageKey: 'test-key',
          mimeType: 'application/pdf',
          processingStatus: ProcessingStatus.PENDING_OCR,
          reviewStatus: 'NONE',
          ocrAttemptCount: 1,
          updatedAt: staleDate,
        },
      });

      await invoicePipelineService.cleanupOrphanedOcrJobs();

      const updated = await prisma.invoiceFile.findUnique({
        where: { id: invoiceFile.id },
      });

      // Should be reset to PENDING_OCR with incremented attempt count
      expect(updated?.processingStatus).toBe(ProcessingStatus.PENDING_OCR);
      expect(updated?.ocrAttemptCount).toBe(2);
      expect(updated?.ocrFailureCategory).toBeNull();
    });

    it('should mark as failed when max attempts reached', async () => {
      const staleDate = new Date(Date.now() - 6 * 60 * 1000);
      
      const invoiceFile = await prisma.invoiceFile.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          fileName: 'max-attempts-invoice.pdf',
          sourceType: 'UPLOAD',
          storageKey: 'test-key',
          mimeType: 'application/pdf',
          processingStatus: ProcessingStatus.PENDING_OCR,
          reviewStatus: 'NONE',
          ocrAttemptCount: 3,
          updatedAt: staleDate,
        },
      });

      await invoicePipelineService.cleanupOrphanedOcrJobs();

      const updated = await prisma.invoiceFile.findUnique({
        where: { id: invoiceFile.id },
      });

      // Should be marked as OCR_FAILED
      expect(updated?.processingStatus).toBe(ProcessingStatus.OCR_FAILED);
      expect(updated?.ocrFailureCategory).toBe(OcrFailureCategory.PROVIDER_TIMEOUT);

      // Verify Pusher event was sent
      expect(pusherService.triggerEvent).toHaveBeenCalledWith(
        'test-channel',
        'invoice-status-updated',
        expect.objectContaining({
          invoiceFileId: invoiceFile.id,
          status: ProcessingStatus.OCR_FAILED,
          ocrFailureCategory: OcrFailureCategory.PROVIDER_TIMEOUT,
        })
      );
    });

    it('should handle OCR_PROCESSING files with null ocrJobId', async () => {
      const staleDate = new Date(Date.now() - 6 * 60 * 1000);
      
      const invoiceFile = await prisma.invoiceFile.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          fileName: 'orphaned-processing.pdf',
          sourceType: 'UPLOAD',
          storageKey: 'test-key',
          mimeType: 'application/pdf',
          processingStatus: ProcessingStatus.OCR_PROCESSING,
          reviewStatus: 'NONE',
          ocrJobId: null, // No job ID - orphaned
          ocrAttemptCount: 1,
          updatedAt: staleDate,
        },
      });

      await invoicePipelineService.cleanupOrphanedOcrJobs();

      const updated = await prisma.invoiceFile.findUnique({
        where: { id: invoiceFile.id },
      });

      // Should be reset to PENDING_OCR
      expect(updated?.processingStatus).toBe(ProcessingStatus.PENDING_OCR);
      expect(updated?.ocrAttemptCount).toBe(2);
    });

    it('should not touch OCR_PROCESSING files with ocrJobId set', async () => {
      const staleDate = new Date(Date.now() - 6 * 60 * 1000);
      
      const invoiceFile = await prisma.invoiceFile.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          fileName: 'normal-processing.pdf',
          sourceType: 'UPLOAD',
          storageKey: 'test-key',
          mimeType: 'application/pdf',
          processingStatus: ProcessingStatus.OCR_PROCESSING,
          reviewStatus: 'NONE',
          ocrJobId: 'test-job-id', // Has job ID - normal path
          ocrAttemptCount: 1,
          updatedAt: staleDate,
        },
      });

      await invoicePipelineService.cleanupOrphanedOcrJobs();

      const updated = await prisma.invoiceFile.findUnique({
        where: { id: invoiceFile.id },
      });

      // Should remain unchanged
      expect(updated?.processingStatus).toBe(ProcessingStatus.OCR_PROCESSING);
      expect(updated?.ocrJobId).toBe('test-job-id');
    });
  });
});
