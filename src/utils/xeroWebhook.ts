import crypto from 'crypto';

/**
 * Verifies the Xero webhook signature using HMAC-SHA256.
 * 
 * @param rawBody - The raw request body string (not parsed JSON).
 * @param signature - The x-xero-signature header value (Base64 encoded).
 * @param secret - The Xero Webhook Secret from environment variables.
 * @returns boolean - True if signature is valid, false otherwise.
 */
export function verifyXeroWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!rawBody || !signature || !secret) {
    return false;
  }

  // Compute HMAC-SHA256 hash
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const digest = hmac.digest('base64');

  // Compare using timing-safe equality to prevent timing attacks
  const signatureBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);

  // Ensure buffers are same length before compare (timingSafeEqual requires equal length)
  if (signatureBuffer.length !== digestBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, digestBuffer);
}

