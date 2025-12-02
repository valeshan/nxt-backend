import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/env';
import { Readable } from 'stream';

const s3Client = new S3Client({
  region: config.AWS_REGION,
  credentials: config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  } : undefined,
});

export const s3Service = {
  async uploadFile(fileStream: Readable | Buffer, key: string, mimeType: string) {
    const command = new PutObjectCommand({
      Bucket: config.S3_INVOICE_BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: mimeType,
    });

    await s3Client.send(command);
    return key;
  },

  async getSignedUrl(key: string) {
    const command = new GetObjectCommand({
      Bucket: config.S3_INVOICE_BUCKET,
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseContentType: 'application/pdf',
    });

    // Expires in 15 minutes
    return getSignedUrl(s3Client, command, { expiresIn: 900 });
  },
};

