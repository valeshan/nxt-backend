import z from 'zod';

export const FeedbackRequest = z.object({
  referenceType: z.enum([
    'Invoices',
    'Auto-approval',
    'Suppliers',
    'Analytics / Insights',
    'Integrations',
    'Performance / Bugs',
    'Feature request',
    'Other',
  ]),
  message: z.string().min(1, 'Message is required'),
  // Optional context fields (for debugging/cross-check)
  userId: z.string().optional(),
  userEmail: z.string().email().optional(),
  organisationId: z.string().optional(),
  locationId: z.string().optional(),
  pathname: z.string().optional(),
  fullUrl: z.string().url().optional(),
  environment: z.string().optional(),
  timestamp: z.string(),
  userAgent: z.string().optional(),
  screenWidth: z.number().optional(),
  screenHeight: z.number().optional(),
});

export type FeedbackRequestType = z.infer<typeof FeedbackRequest>;

export const FeedbackResponse = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

export type FeedbackResponseType = z.infer<typeof FeedbackResponse>;


