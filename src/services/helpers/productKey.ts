export function getProductKeyFromLineItem(itemCode: string | null | undefined, description: string | null | undefined): string {
    // Priority: ItemCode > Description
    // If neither, return "unknown"
    //
    // IMPORTANT: Do NOT fall back to accountCode here.
    // "Selected line items only" gating applies to file-backed/manual invoice line items,
    // and account codes are not stable/product-identifying for that purpose.
    
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

