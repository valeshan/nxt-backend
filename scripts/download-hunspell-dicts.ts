/**
 * Script to download Hunspell dictionaries for spellcheck functionality.
 * 
 * Downloads en_AU and en_US dictionaries from reliable sources.
 * Run this script before deploying to ensure dictionaries are available.
 * 
 * Usage: tsx scripts/download-hunspell-dicts.ts
 */

import { mkdir, writeFile, rename, stat, access } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const RESOURCES_DIR = join(__dirname, '../src/resources/hunspell');

// Dictionary sources (using LibreOffice dictionaries via GitHub)
// URLs are pinned to a specific commit SHA for stability
// To get the latest commit SHA:
//   1. Visit: https://github.com/LibreOffice/dictionaries/commits/master
//   2. Copy the full SHA of the latest commit
//   3. Replace DICTIONARY_COMMIT below
// 
// IMPORTANT: Test downloads after updating to ensure files are valid
// Production guard: DICTIONARY_COMMIT must be a real commit SHA, not 'master'
// Current SHA: Latest commit from master branch (fetched 26/12/2025)
// To update: Get latest SHA from https://github.com/LibreOffice/dictionaries/commits/master
const DICTIONARY_COMMIT = '74b6ae2a2df22fd9d6e253f0391ac3a67cb7b3f8';

// Production safety guard: fail fast if not pinned
if (process.env.NODE_ENV === 'production' && DICTIONARY_COMMIT === 'master') {
  throw new Error(
    'DICTIONARY_COMMIT must be pinned to a commit SHA in production. ' +
    'Get the latest commit SHA from https://github.com/LibreOffice/dictionaries/commits/master ' +
    'and replace DICTIONARY_COMMIT in scripts/download-hunspell-dicts.ts'
  );
}

const DICTIONARIES = {
  en_AU: {
    aff: `https://raw.githubusercontent.com/LibreOffice/dictionaries/${DICTIONARY_COMMIT}/en/en_AU.aff`,
    dic: `https://raw.githubusercontent.com/LibreOffice/dictionaries/${DICTIONARY_COMMIT}/en/en_AU.dic`,
  },
  en_US: {
    aff: `https://raw.githubusercontent.com/LibreOffice/dictionaries/${DICTIONARY_COMMIT}/en/en_US.aff`,
    dic: `https://raw.githubusercontent.com/LibreOffice/dictionaries/${DICTIONARY_COMMIT}/en/en_US.dic`,
  },
};

// Minimum file size requirements
const MIN_AFF_SIZE = 1024; // 1KB
const MIN_DIC_SIZE = 10240; // 10KB

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  
  if (buffer.byteLength === 0) {
    throw new Error(`Downloaded file is empty: ${url}`);
  }
  
  // Atomic write: write to temp file, then rename
  const tempPath = `${destPath}.tmp`;
  await writeFile(tempPath, Buffer.from(buffer));
  await rename(tempPath, destPath);
  
  // Verify file exists and is non-empty
  try {
    await access(destPath);
    const stats = await stat(destPath);
    if (stats.size === 0) {
      throw new Error(`File verification failed: ${destPath} is empty`);
    }
  } catch (err: any) {
    throw new Error(`File verification failed: ${destPath} - ${err.message}`);
  }
}

async function downloadDictionaries(): Promise<void> {
  console.log('Downloading Hunspell dictionaries...');

  for (const [locale, urls] of Object.entries(DICTIONARIES)) {
    const localeDir = join(RESOURCES_DIR, locale);
    
    // Create directory if it doesn't exist
    if (!existsSync(localeDir)) {
      await mkdir(localeDir, { recursive: true });
    }

    const affPath = join(localeDir, `${locale}.aff`);
    const dicPath = join(localeDir, `${locale}.dic`);

    // Check if files exist and meet minimum size requirements
    let shouldDownload = false;
    try {
      if (existsSync(affPath) && existsSync(dicPath)) {
        const affStats = await stat(affPath);
        const dicStats = await stat(dicPath);
        
        if (affStats.size >= MIN_AFF_SIZE && dicStats.size >= MIN_DIC_SIZE) {
          console.log(`✓ ${locale} dictionaries already exist and are valid, skipping...`);
          continue;
        } else {
          console.log(`⚠ ${locale} dictionaries exist but are too small, re-downloading...`);
          shouldDownload = true;
        }
      } else {
        shouldDownload = true;
      }
    } catch (err: any) {
      // Files don't exist or can't be accessed, need to download
      shouldDownload = true;
    }

    if (shouldDownload) {
      try {
        console.log(`Downloading ${locale}.aff...`);
        await downloadFile(urls.aff, affPath);
        
        console.log(`Downloading ${locale}.dic...`);
        await downloadFile(urls.dic, dicPath);
        
        // Verify downloaded files meet size requirements
        const affStats = await stat(affPath);
        const dicStats = await stat(dicPath);
        
        if (affStats.size < MIN_AFF_SIZE) {
          throw new Error(`${locale}.aff is too small (${affStats.size} bytes, minimum ${MIN_AFF_SIZE})`);
        }
        if (dicStats.size < MIN_DIC_SIZE) {
          throw new Error(`${locale}.dic is too small (${dicStats.size} bytes, minimum ${MIN_DIC_SIZE})`);
        }
        
        console.log(`✓ ${locale} dictionaries downloaded and validated successfully`);
      } catch (err: any) {
        console.error(`✗ Failed to download ${locale} dictionaries: ${err.message}`);
        // Clean up partial files if they exist
        try {
          if (existsSync(affPath)) {
            await access(affPath);
          }
        } catch {
          // File doesn't exist or already cleaned up
        }
        try {
          if (existsSync(dicPath)) {
            await access(dicPath);
          }
        } catch {
          // File doesn't exist or already cleaned up
        }
        throw err;
      }
    }
  }

  console.log('\nAll dictionaries downloaded successfully!');
}

// Run if executed directly
if (require.main === module) {
  downloadDictionaries().catch((err) => {
    console.error('Error downloading dictionaries:', err);
    process.exit(1);
  });
}

export { downloadDictionaries };

