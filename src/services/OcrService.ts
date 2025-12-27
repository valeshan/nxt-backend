import { TextractClient, StartExpenseAnalysisCommand, GetExpenseAnalysisCommand, JobStatus } from '@aws-sdk/client-textract';
import { config } from '../config/env';
import { parseMoneyLike } from '../utils/numberParsing';
import { computeDescriptionWarnings } from '../utils/descriptionQuality';

const textractClient = new TextractClient({
  region: config.AWS_REGION,
  credentials: config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  } : undefined,
});

export type ParsedInvoice = {
  supplierName?: string;
  invoiceNumber?: string;
  date?: Date;
  total?: number;
  tax?: number;
  subtotal?: number;
  currency?: string;
  lineItems: Array<{
    description: string;
    /**
     * Original QUANTITY cell text from Textract (if present). Useful for audit/debug and
     * for extracting unit tokens like "8.42 KILO" / "2.00 UNIT".
     */
    rawQuantityText?: string;
    /**
     * Optional line fields that sometimes contain unit-bearing tokens even when QUANTITY is numeric-only.
     * These are preserved for audit/debug and used as additional unit extraction sources.
     */
    rawDeliveredText?: string;
    rawSizeText?: string;
    /**
     * Normalized unit token extracted from QUANTITY cell (or other line fields where available).
     * Examples: "KG", "KILO", "UNIT", "CRTN", "L", "LT", "ML"
     */
    unitLabel?: string;
    quantity?: number;
    unitPrice?: number;
    lineTotal?: number;
    productCode?: string;
    numericParseWarnReasons?: string[];
    /**
     * Per-line OCR confidence score (0-100), computed from individual field confidences.
     * Null if insufficient fields available for reliable calculation.
     */
    confidenceScore?: number | null;
    /**
     * Text quality warnings indicating the description may be misread by OCR.
     * Examples: DESCRIPTION_GIBBERISH, DESCRIPTION_LOW_ALPHA_RATIO, DESCRIPTION_NO_VOWELS_LONG_TOKEN
     */
    textWarnReasons?: string[];
  }>;
  confidenceScore: number;
};

const UNIT_TOKEN_RE = /^\s*\d+(?:\.\d+)?\s*([A-Za-z]{1,10})\s*$/;
const UNIT_ALLOW = new Set([
  // Weight
  'KG',
  'KILO',
  'KILOS',
  'KILOGRAM',
  'KILOGRAMS',
  'G',
  'GM',
  'GRAM',
  'GRAMS',
  'GR',
  // Volume
  'L',
  'LT',
  'LITRE',
  'LITRES',
  'LITER',
  'LITERS',
  'ML',
  'MILLILITRE',
  'MILLILITRES',
  'MILLILITER',
  'MILLILITERS',
  // Unit-ish
  'UNIT',
  'UNITS',
  'EA',
  'EACH',
  'BOX',
  'CARTON',
  'CRTN',
  'CTN',
  'PACK',
  'PK',
  'BAG',
  'TRAY',
  'TUB',
  'ROLL',
  'BOTTLE',
]);

function extractUnitLabelFromText(text?: string): string | undefined {
  if (!text) return undefined;
  const m = String(text).match(UNIT_TOKEN_RE);
  if (!m) return undefined;
  const token = String(m[1]).toUpperCase();
  return UNIT_ALLOW.has(token) ? token : undefined;
}

export const ocrService = {
  async startAnalysis(s3Key: string) {
    const command = new StartExpenseAnalysisCommand({
      DocumentLocation: {
        S3Object: {
          Bucket: config.S3_INVOICE_BUCKET,
          Name: s3Key,
        },
      },
    });

    const response = await textractClient.send(command);
    return response.JobId;
  },

  async getAnalysisResults(jobId: string) {
    const command = new GetExpenseAnalysisCommand({
      JobId: jobId,
    });

    const response = await textractClient.send(command);
    return response;
  },

  parseTextractOutput(rawOutput: any): ParsedInvoice {
    const doc = rawOutput.ExpenseDocuments?.[0];
    if (!doc) {
      return { lineItems: [], confidenceScore: 0 };
    }

    const summaryFields = doc.SummaryFields || [];
    const lineItemGroups = doc.LineItemGroups || [];

    const getField = (type: string) => summaryFields.find((f: any) => f.Type?.Text === type);
    const getValue = (type: string) => getField(type)?.ValueDetection?.Text;

    const supplierName = getValue('VENDOR_NAME');
    const invoiceNumber = getValue('INVOICE_RECEIPT_ID');
    const dateStr = getValue('INVOICE_RECEIPT_DATE');
    const totalStr = getValue('TOTAL');
    const taxStr = getValue('TAX');
    const subtotalStr = getValue('SUBTOTAL');
    
    // Attempt to parse date
    let date: Date | undefined;
    if (dateStr) {
        date = new Date(dateStr);
        if (isNaN(date.getTime())) date = undefined;
    }

    // Money parsing (locale-aware) - do NOT use for quantity parsing.
    const parseMoneyField = (str: string | undefined, kind: Parameters<typeof parseMoneyLike>[1]['kind']) => {
        if (!str) return { value: undefined as number | undefined, warnReasons: [] as string[] };
        const r = parseMoneyLike(str, { kind });
        if (r.value === null) {
            const mapped = r.reason === 'INVALID_FORMAT' ? 'INVALID_MONEY_FORMAT' : r.reason;
            return { value: undefined, warnReasons: mapped ? [mapped] : [] };
        }
        return { value: r.value, warnReasons: [] };
    };

    // Quantity parsing remains loose (can handle "8.42 KILO", "2 UNIT")
    const parseQuantityLoose = (str?: string) => {
        if (!str) return undefined;
        const clean = str.replace(/[^0-9.-]/g, '');
        const val = parseFloat(clean);
        return isNaN(val) ? undefined : val;
    };

    const total = parseMoneyField(totalStr, 'OTHER').value;
    const tax = parseMoneyField(taxStr, 'TAX').value;
    const subtotal = parseMoneyField(subtotalStr, 'OTHER').value;

    // Average confidence of summary fields
    const confidences = summaryFields.map((f: any) => f.ValueDetection?.Confidence || 0);
    const confidenceScore = confidences.length > 0 
        ? confidences.reduce((a: number, b: number) => a + b, 0) / confidences.length 
        : 0;

    const lineItems: ParsedInvoice['lineItems'] = [];

    // Helper to extract field with confidence
    const getLineFieldWithConfidence = (fields: any[], type: string) => {
      const field = fields.find((f: any) => f.Type?.Text === type);
      const valueDetection = field?.ValueDetection;
      return {
        text: valueDetection?.Text ?? '',
        confidence: typeof valueDetection?.Confidence === 'number'
          ? valueDetection.Confidence
          : null
      };
    };

    for (const group of lineItemGroups) {
      for (const item of group.LineItems || []) {
        const fields = item.LineItemExpenseFields || [];
        
        // Extract description with confidence
        const descItem = getLineFieldWithConfidence(fields, 'ITEM');
        const descExpenseRow = getLineFieldWithConfidence(fields, 'EXPENSE_ROW');
        const description = descItem.text || descExpenseRow.text;
        if (!description) continue;

        // Extract other fields with confidence
        const qty = getLineFieldWithConfidence(fields, 'QUANTITY');
        const rawDelivered = getLineFieldWithConfidence(fields, 'DELIVERED') || getLineFieldWithConfidence(fields, 'DELIVERY');
        const rawSize = getLineFieldWithConfidence(fields, 'SIZE') || getLineFieldWithConfidence(fields, 'PACK_SIZE');
        const unitPrice = getLineFieldWithConfidence(fields, 'UNIT_PRICE');
        const lineTotal = getLineFieldWithConfidence(fields, 'PRICE');
        const productCode = getLineFieldWithConfidence(fields, 'PRODUCT_CODE');

        const extractedUnit =
          extractUnitLabelFromText(qty.text) ??
          extractUnitLabelFromText(rawDelivered.text) ??
          extractUnitLabelFromText(rawSize.text);

        const unitPriceParsed = parseMoneyField(unitPrice.text, 'UNIT_PRICE');
        const lineTotalParsed = parseMoneyField(lineTotal.text, 'LINE_TOTAL');

        // Compute per-line confidence (weight description 2x, require ≥2 fields)
        const lineConfidenceInputs = [
          descItem.confidence,
          descItem.confidence, // Weight description 2x
          qty.confidence,
          unitPrice.confidence,
          lineTotal.confidence,
          productCode.confidence
        ].filter((c): c is number => typeof c === 'number' && c > 0);

        const lineConfidenceScore =
          lineConfidenceInputs.length >= 2 // Require at least 2 fields
            ? lineConfidenceInputs.reduce((a, b) => a + b, 0) / lineConfidenceInputs.length
            : null;

        // Compute text quality warnings
        // Note: OCR confidence is passed, but lexicon is not available at this stage
        // Lexicon suppression happens later in InvoicePipelineService during OCR completion
        const textWarnReasons = computeDescriptionWarnings(description, { 
            ocrConfidence: lineConfidenceScore 
        });

        lineItems.push({
          description,
          rawQuantityText: qty.text || undefined,
          rawDeliveredText: rawDelivered.text || undefined,
          rawSizeText: rawSize.text || undefined,
          unitLabel: extractedUnit,
          quantity: parseQuantityLoose(qty.text ?? rawDelivered.text),
          unitPrice: unitPriceParsed.value,
          lineTotal: lineTotalParsed.value, // Usually 'PRICE' in Textract Expense
          productCode: productCode.text || undefined,
          numericParseWarnReasons: [...unitPriceParsed.warnReasons, ...lineTotalParsed.warnReasons],
          confidenceScore: lineConfidenceScore ?? null,
          textWarnReasons: textWarnReasons.length > 0 ? textWarnReasons : undefined,
        });
      }
    }

    return {
      supplierName,
      invoiceNumber,
      date,
      total,
      tax,
      subtotal,
      lineItems,
      confidenceScore,
    };
  }
};









