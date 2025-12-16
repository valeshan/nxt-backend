import sharp from 'sharp';
import { s3Service } from './S3Service';
import { config } from '../config/env';

export interface PreprocessingOptions {
  autoRotate?: boolean;
  contrastBoost?: boolean;
  upscale?: boolean;
  noiseReduction?: boolean;
  maxWidth?: number;
  maxHeight?: number;
}

export interface PreprocessingResult {
  processedS3Key: string;
  flags: {
    autoRotate: boolean;
    contrastBoost: boolean;
    upscale: boolean;
    noiseReduction: boolean;
    providerDeskewUsed: boolean;
  };
  originalDimensions?: { width: number; height: number };
  processedDimensions?: { width: number; height: number };
}

/**
 * Image preprocessing service using sharp (libvips)
 * Enforces safety limits to prevent memory issues
 */
export const imagePreprocessingService = {
  // Maximum dimensions to prevent memory issues
  MAX_WIDTH: 4000,
  MAX_HEIGHT: 4000,
  MAX_UPSCALE_FACTOR: 2,

  /**
   * Preprocess an image from S3 with safety constraints
   */
  async preprocessImage(
    s3Key: string,
    options: PreprocessingOptions = {}
  ): Promise<PreprocessingResult> {
    const {
      autoRotate = false,
      contrastBoost = false,
      upscale = false,
      noiseReduction = false,
      maxWidth = this.MAX_WIDTH,
      maxHeight = this.MAX_HEIGHT,
    } = options;

    // Download image from S3
    const imageBuffer = await s3Service.getObject(s3Key);

    // Get original metadata
    const metadata = await sharp(imageBuffer).metadata();
    const originalWidth = metadata.width || 0;
    const originalHeight = metadata.height || 0;

    console.log(`[ImagePreprocessing] Processing ${s3Key}: ${originalWidth}x${originalHeight}`);

    // Safety check: reject extremely large images early
    if (originalWidth > this.MAX_WIDTH * 2 || originalHeight > this.MAX_HEIGHT * 2) {
      throw new Error(
        `Image dimensions (${originalWidth}x${originalHeight}) exceed safety limits. Maximum allowed: ${this.MAX_WIDTH * 2}x${this.MAX_HEIGHT * 2}`
      );
    }

    // Start with sharp pipeline
    let pipeline = sharp(imageBuffer);

    // Auto-rotate based on EXIF
    if (autoRotate) {
      pipeline = pipeline.rotate(); // Auto-rotates based on EXIF orientation
    }

    // Calculate target dimensions
    let targetWidth = originalWidth;
    let targetHeight = originalHeight;

    // Apply upscale if requested (with limits)
    if (upscale && originalWidth < maxWidth && originalHeight < maxHeight) {
      const widthScale = maxWidth / originalWidth;
      const heightScale = maxHeight / originalHeight;
      const scale = Math.min(widthScale, heightScale, this.MAX_UPSCALE_FACTOR);

      targetWidth = Math.round(originalWidth * scale);
      targetHeight = Math.round(originalHeight * scale);

      pipeline = pipeline.resize(targetWidth, targetHeight, {
        kernel: sharp.kernel.lanczos3, // High-quality upscaling
      });
    } else {
      // Downscale if too large
      if (originalWidth > maxWidth || originalHeight > maxHeight) {
        pipeline = pipeline.resize(maxWidth, maxHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        });
        const resizedMetadata = await sharp(imageBuffer)
          .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
          .toBuffer({ resolveWithObject: true });
        targetWidth = resizedMetadata.info.width;
        targetHeight = resizedMetadata.info.height;
      }
    }

    // Contrast enhancement
    if (contrastBoost) {
      pipeline = pipeline.modulate({
        brightness: 1.1, // Slight brightness boost
        saturation: 1.0,
      });
      // Apply contrast adjustment
      pipeline = pipeline.linear(1.2, -(128 * 0.2)); // Increase contrast by 20%
    }

    // Noise reduction (light denoising)
    if (noiseReduction) {
      pipeline = pipeline.sharpen({
        sigma: 0.5,
        m1: 1, // 'flat' is m1 in newer sharp versions
        m2: 2, // 'jagged' is m2 in newer sharp versions
      });
    }

    // Ensure output format is PNG or JPEG
    const outputFormat = metadata.format === 'png' ? 'png' : 'jpeg';
    if (outputFormat === 'jpeg') {
      pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
    } else {
      pipeline = pipeline.png({ quality: 90, compressionLevel: 9 });
    }

    // Process the image
    const processedBuffer = await pipeline.toBuffer();

    // Get final dimensions
    const finalMetadata = await sharp(processedBuffer).metadata();
    const processedWidth = finalMetadata.width || targetWidth;
    const processedHeight = finalMetadata.height || targetHeight;

    // Generate new S3 key for processed image
    const pathParts = s3Key.split('/');
    const fileName = pathParts[pathParts.length - 1];
    const baseName = fileName.split('.')[0];
    const extension = outputFormat === 'png' ? 'png' : 'jpg';
    const processedS3Key = `${pathParts.slice(0, -1).join('/')}/${baseName}_processed.${extension}`;

    // Upload processed image to S3
    await s3Service.putObject(processedS3Key, processedBuffer, {
      ContentType: outputFormat === 'png' ? 'image/png' : 'image/jpeg',
    });

    console.log(
      `[ImagePreprocessing] Processed ${s3Key}: ${originalWidth}x${originalHeight} -> ${processedWidth}x${processedHeight}`
    );

    return {
      processedS3Key,
      flags: {
        autoRotate,
        contrastBoost,
        upscale,
        noiseReduction,
        providerDeskewUsed: false, // Textract handles deskew internally
      },
      originalDimensions: { width: originalWidth, height: originalHeight },
      processedDimensions: { width: processedWidth, height: processedHeight },
    };
  },

  /**
   * Check if a file is an image that needs preprocessing
   */
  isImageFile(mimeType: string): boolean {
    return ['image/jpeg', 'image/jpg', 'image/png', 'image/tiff', 'image/bmp'].includes(
      mimeType.toLowerCase()
    );
  },
};

