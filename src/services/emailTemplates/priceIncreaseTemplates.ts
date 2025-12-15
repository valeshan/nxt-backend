export type PriceIncreaseItem = {
  productName: string;
  supplierName: string;
  oldPrice: number; // dollars
  newPrice: number; // dollars
  absoluteChange: number; // dollars
  percentChange: number; // percent, e.g. 50 for 50%
};

const formatMoney = (n: number) => n.toFixed(2);

const formatPercent = (n: number) => Math.round(n);

export const buildPriceIncreaseEmail = (items: PriceIncreaseItem[], totalCount?: number) => {
  if (!items || items.length === 0) {
    return {
      subject: "Price increase detected",
      body: "Price increase detected\n\nNo items provided.",
    };
  }

  // Sort by percent change descending
  const sortedItems = items.slice().sort((a, b) => b.percentChange - a.percentChange);
  
  // Take top 10 for display
  const displayItems = sortedItems.slice(0, 10);
  const remainingCount = totalCount ? totalCount - displayItems.length : sortedItems.length - displayItems.length;

  if (displayItems.length === 1) {
    const i = displayItems[0];
    const subject = `Price increase detected – ${i.productName} (+${formatPercent(i.percentChange)}%)`;

    const body =
      `Price increase detected\n\n` +
      `Product: ${i.productName}\n` +
      `Supplier: ${i.supplierName}\n\n` +
      `Previous unit price: $${formatMoney(i.oldPrice)}\n` +
      `Current unit price: $${formatMoney(i.newPrice)}\n` +
      `Change: +$${formatMoney(i.absoluteChange)} (+${formatPercent(i.percentChange)}%)\n\n` +
      `This change was detected from your most recent invoices.\n` +
      `We will continue monitoring supplier pricing automatically.\n\n` +
      `No action is required if you are already aware of this change.\n`;

    return { subject, body };
  }

  const subject = `Price increase detected – ${displayItems.length} item${displayItems.length > 1 ? 's' : ''} found`;

  const lines = displayItems
    .map(
      (i) =>
        `- ${i.productName} (Supplier: ${i.supplierName})\n  $${formatMoney(i.oldPrice)} → $${formatMoney(i.newPrice)} (+${formatPercent(i.percentChange)}%)`
    )
    .join("\n\n");

  let body =
    `Price increases detected\n\n` +
    `We detected price increases for the following items:\n\n` +
    `${lines}\n\n`;

  if (remainingCount > 0) {
    body += `+ ${remainingCount} more change${remainingCount > 1 ? 's' : ''} detected\n\n`;
  }

  body +=
    `These changes were detected from your most recent invoices.\n` +
    `We will continue monitoring supplier pricing automatically.\n`;

  return { subject, body };
};

