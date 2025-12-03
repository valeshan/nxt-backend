import { TextractClient, StartExpenseAnalysisCommand, GetExpenseAnalysisCommand, JobStatus } from '@aws-sdk/client-textract';
import { config } from '../config/env';

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
    quantity?: number;
    unitPrice?: number;
    lineTotal?: number;
    productCode?: string;
  }>;
  confidenceScore: number;
};

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

    const parseMoney = (str?: string) => {
        if (!str) return undefined;
        // Remove currency symbols and normalize
        const clean = str.replace(/[^0-9.-]/g, '');
        const val = parseFloat(clean);
        return isNaN(val) ? undefined : val;
    };

    const total = parseMoney(totalStr);
    const tax = parseMoney(taxStr);
    const subtotal = parseMoney(subtotalStr);

    // Average confidence of summary fields
    const confidences = summaryFields.map((f: any) => f.ValueDetection?.Confidence || 0);
    const confidenceScore = confidences.length > 0 
        ? confidences.reduce((a: number, b: number) => a + b, 0) / confidences.length 
        : 0;

    const lineItems: ParsedInvoice['lineItems'] = [];

    for (const group of lineItemGroups) {
      for (const item of group.LineItems || []) {
        const fields = item.LineItemExpenseFields || [];
        const getLineField = (type: string) => fields.find((f: any) => f.Type?.Text === type)?.ValueDetection?.Text;

        const description = getLineField('ITEM') || getLineField('EXPENSE_ROW') || '';
        if (!description) continue;

        lineItems.push({
          description,
          quantity: parseMoney(getLineField('QUANTITY')),
          unitPrice: parseMoney(getLineField('UNIT_PRICE')),
          lineTotal: parseMoney(getLineField('PRICE')), // Usually 'PRICE' in Textract Expense
          productCode: getLineField('PRODUCT_CODE'),
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




