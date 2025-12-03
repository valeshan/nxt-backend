import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/env';
import { Readable } from 'stream';


console.log('AWS Config Check:', {
    region: config.AWS_REGION,
    hasAccessKey: !!config.AWS_ACCESS_KEY_ID,
    hasSecretKey: !!config.AWS_SECRET_ACCESS_KEY,
    accessKeyLength: config.AWS_ACCESS_KEY_ID ? config.AWS_ACCESS_KEY_ID.length : 0
  });
  
const s3Client = new S3Client({
  region: config.AWS_REGION,
  credentials: config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  } : undefined,
});

const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

export const s3Service = {
  async uploadFile(fileStream: Readable | Buffer, key: string, mimeType: string) {
    try {
      let fileBuffer: Buffer;
      if (Buffer.isBuffer(fileStream)) {
        fileBuffer = fileStream;
      } else {
        fileBuffer = await streamToBuffer(fileStream as Readable);
      }

      const command = new PutObjectCommand({
        Bucket: config.S3_INVOICE_BUCKET,
        Key: key,
        Body: fileBuffer,
        ContentLength: fileBuffer.length,
        ContentType: mimeType,
      });

      await s3Client.send(command);
      return key;
    } catch (error: any) {
      console.error(`[S3 Upload Failed] Bucket=${config.S3_INVOICE_BUCKET} Key=${key} Error=${error.name} Message=${error.message}`);
      const enhancedError = new Error(`S3 Upload Failed: ${error.message}`);
      (enhancedError as any).code = error.name;
      (enhancedError as any).originalError = error;
      throw enhancedError;
    }
  },

  async getSignedUrl(key: string) {
    try {
      const command = new GetObjectCommand({
        Bucket: config.S3_INVOICE_BUCKET,
        Key: key,
        ResponseContentDisposition: 'inline',
        ResponseContentType: 'application/pdf',
      });

      // Expires in 15 minutes
      const url = await getSignedUrl(s3Client, command, { expiresIn: 900 });
      return url;
    } catch (error: any) {
      console.error(`[S3 Presign Failed] Bucket=${config.S3_INVOICE_BUCKET} Key=${key} Error=${error.name} Message=${error.message}`);
      throw error;
    }
  },
};

