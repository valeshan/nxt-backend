/**
 * Post-build script to copy resources from src/resources to dist/resources.
 * 
 * Production behavior: Fails if src/resources is missing or copy fails.
 * Development behavior: Warns but continues (resilient for dev).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const srcResources = path.join(process.cwd(), 'src', 'resources');
const distResources = path.join(process.cwd(), 'dist', 'resources');
const isProduction = process.env.NODE_ENV === 'production';

// Check if src/resources exists
if (!fs.existsSync(srcResources)) {
  const message = isProduction
    ? `ERROR: src/resources missing in production build. Resources must be included in build artifact.`
    : `WARN: src/resources not found, skipping copy (dev mode)`;
  
  if (isProduction) {
    console.error(message);
    process.exit(1);
  } else {
    console.warn(message);
    process.exit(0);
  }
}

// Create dist/resources directory
try {
  fs.mkdirSync(distResources, { recursive: true });
} catch (err) {
  if (isProduction) {
    console.error(`ERROR: Failed to create dist/resources directory: ${err.message}`);
    console.error('Resources must be included in production build artifact.');
    process.exit(1);
  } else {
    console.warn(`WARN: Failed to create dist/resources (dev mode): ${err.message}`);
    process.exit(0);
  }
}

// Copy resources
try {
  // Use cp -r for recursive copy (works on Unix/Mac, use xcopy on Windows if needed)
  execSync(`cp -r "${srcResources}"/* "${distResources}"/`, { stdio: 'inherit' });
  console.log('✓ Resources copied to dist/resources');
} catch (err) {
  if (isProduction) {
    console.error(`ERROR: Failed to copy resources to dist/resources: ${err.message}`);
    console.error('Resources must be included in production build artifact.');
    process.exit(1);
  } else {
    console.warn(`WARN: Resource copy failed (dev mode): ${err.message}`);
    // In dev, continue even if copy fails (resilient)
  }
}



