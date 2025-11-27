export function getProductKeyFromLineItem(itemCode: string | null | undefined, description: string | null | undefined): string {
    // Priority: ItemCode > Description
    // If neither, return "unknown"
    
    let raw = '';
    if (itemCode && itemCode.trim().length > 0) {
        raw = itemCode;
    } else if (description && description.trim().length > 0) {
        raw = description;
    } else {
        return 'unknown';
    }

    // Normalize: lowercase, trim, collapse whitespace
    return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

