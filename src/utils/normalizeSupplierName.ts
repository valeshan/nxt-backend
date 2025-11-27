export function normalizeSupplierName(name: string): string {
  if (!name) return '';

  let normalized = name.toLowerCase();

  // Replace common punctuation with space or remove them
  // Remove commas, periods, apostrophes
  normalized = normalized.replace(/[.,']/g, '');
  
  // Replace multiple spaces with a single space
  normalized = normalized.replace(/\s+/g, ' ');

  // Trim leading/trailing whitespace
  normalized = normalized.trim();

  // Strip leading "the "
  if (normalized.startsWith('the ')) {
    normalized = normalized.slice(4).trim();
  }

  // List of legal suffixes to strip
  const legalSuffixes = [
    ' pty ltd',
    ' pty. ltd',
    ' limited',
    ' ltd',
    ' co',
    ' company',
    ' inc',
    ' incorporated',
    ' proprietary',
    ' group',
    ' holdings',
    ' enterprises',
  ];

  // Check for suffixes and remove them
  // We iterate and check specifically at the end of the string
  for (const suffix of legalSuffixes) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).trim();
      // Only strip one suffix (the longest match logic could be better but this list order matters)
      // Since we might have "Pty Ltd", normalized as "pty ltd", if we have "Company Ltd", it becomes "company ltd"
      // We might want to re-check if there are stacked suffixes, but usually it's just one block.
      break; 
    }
  }

  return normalized;
}

