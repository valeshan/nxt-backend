import { AdjustmentStatus, CanonicalSource, QualityStatus, UnitCategory } from '@prisma/client';

export type CanonicalizedLineInput = {
  source: CanonicalSource;
  rawDescription: string;
  productCode?: string | null;
  quantity?: number | null;
  unitLabel?: string | null;
  unitPrice?: number | null;
  lineTotal?: number | null;
  taxAmount?: number | null;
  currencyCode?: string | null;
  adjustmentStatus?: AdjustmentStatus;
  confidenceScore?: number | null;
};

export type CanonicalizedLineOutput = {
  rawDescription: string;
  normalizedDescription: string;
  unitLabel: string | null;
  unitCategory: UnitCategory;
  currencyCode: string | null;
  adjustmentStatus: AdjustmentStatus;
  qualityStatus: QualityStatus;
  qualityWarnReasons: string[];
};

