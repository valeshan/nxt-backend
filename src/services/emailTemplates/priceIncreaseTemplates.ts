export type PriceIncreaseItem = {
  productName: string;
  supplierName: string;
  locationName?: string;
  oldPrice: number; // dollars
  newPrice: number; // dollars
  absoluteChange: number; // dollars
  percentChange: number; // percent, e.g. 50 for 50%
};

const formatMoney = (n: number) => n.toFixed(2);

const formatPercent = (n: number) => Math.round(n);

const formatDate = (date: Date) => {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const generatePriceAlertHtml = (items: PriceIncreaseItem[], totalCount: number, organisationName: string, generatedDate: Date = new Date()): string => {
  if (!items || items.length === 0) {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The NXT Alert</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f2f2f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f2f2f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <p style="color: #666;">No price alerts to display for ${escapeHtml(organisationName)}.</p>
      </td>
    </tr>
  </table>
</body>
</html>
    `;
  }

  // Sort by percent change descending
  const sortedItems = items.slice().sort((a, b) => b.percentChange - a.percentChange);
  
  // Take top 10 for display
  const displayItems = sortedItems.slice(0, 10);
  const remainingCount = totalCount - displayItems.length;

  const dateStr = formatDate(generatedDate);

  // Generate item rows
  const itemRows = displayItems.map(item => `
                  <tr>
                    <td style="padding: 18px 0; border-bottom: 1px dashed #eee; vertical-align: middle;">
                      <div style="font-size: 15px; font-weight: 600; color: #111;">${escapeHtml(item.productName)}</div>
                      <div style="font-size: 12px; color: #888; margin-top: 4px;">
                        ${escapeHtml(item.supplierName)}${item.locationName ? ` • <span style="color:#555;">${escapeHtml(item.locationName)}</span>` : ''}
                      </div>
                    </td>
                    <td style="padding: 18px 0; border-bottom: 1px dashed #eee; text-align: right; vertical-align: middle;">
                      <div style="font-family: 'Menlo', 'Consolas', monospace; font-size: 15px; color: #111; font-weight: 600;">$${formatMoney(item.newPrice)}</div>
                      <div style="font-family: 'Menlo', 'Consolas', monospace; font-size: 11px; color: #999; text-decoration: line-through;">was $${formatMoney(item.oldPrice)}</div>
                    </td>
                    <td style="padding: 18px 0; border-bottom: 1px dashed #eee; text-align: right; vertical-align: middle;">
                      <span style="background-color: #FFF0ED; color: #FF4B1F; font-size: 11px; font-weight: 700; padding: 6px 10px; border-radius: 20px; font-family: 'Menlo', monospace;">
                        +${formatPercent(item.percentChange)}%
                      </span>
                    </td>
                  </tr>
  `).join('');

  // Add truncation row if needed
  const truncationRow = remainingCount > 0 ? `
                  <tr>
                    <td colspan="3" style="padding: 18px 0; text-align: center; color: #888; font-size: 13px;">
                      + ${remainingCount} more change${remainingCount > 1 ? 's' : ''} detected
                    </td>
                  </tr>
  ` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The NXT Alert</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f2f2f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  
  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f2f2f5; padding: 40px 0;">
    <tr>
      <td align="center">
        
        <table width="600" border="0" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.06); max-width: 600px; width: 100%;">
          
          <tr>
            <td style="height: 6px; background: linear-gradient(90deg, #FF4B1F 0%, #FF9068 100%);"></td>
          </tr>

          <tr>
            <td style="padding: 40px 40px 10px 40px;">
              <table width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-weight: 800; font-size: 18px; letter-spacing: -1px; color: #000;">the nxt</span>
                  </td>
                  <td style="text-align: right;">
                    <span style="font-family: 'Menlo', 'Consolas', monospace; font-size: 11px; color: #999; letter-spacing: 0.5px;">${dateStr}</span>
                  </td>
                </tr>
              </table>

              <!-- Organisation Badge -->
              <div style="margin-top: 20px;">
                <span style="background: #f4f4f5; color: #555; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
                  ${escapeHtml(organisationName)}
                </span>
              </div>

              <div style="margin-top: 20px;">
                <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #111; letter-spacing: -0.5px; line-height: 1.2;">
                  Price Spike <span style="color: #FF4B1F;">Detected.</span>
                </h1>
                <p style="margin: 10px 0 0; color: #666; font-size: 16px; line-height: 1.5;">
                  We detected <strong>${displayItems.length} product${displayItems.length > 1 ? 's' : ''}</strong> moving against your margin targets.
                </p>
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding: 20px 40px 40px 40px;">
              
              <div style="height: 1px; background-color: #eee; margin-bottom: 20px;"></div>

              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border-collapse: separate; border-spacing: 0;">
                
                <thead>
                  <tr>
                    <th style="text-align: left; padding-bottom: 15px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #aaa;">Product</th>
                    <th style="text-align: right; padding-bottom: 15px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #aaa;">New Price</th>
                    <th style="text-align: right; padding-bottom: 15px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #aaa;">Surge</th>
                  </tr>
                </thead>

                <tbody>
                  ${itemRows}
                  ${truncationRow}
                </tbody>
              </table>

              <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
                <p style="font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px;">
                  RECOMMENDED ACTIONS
                </p>
                
                <table width="100%" border="0" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="33%" style="vertical-align: top; padding-right: 10px;">
                      <div style="font-size: 16px; margin-bottom: 5px;">🧐</div>
                      <div style="font-size: 13px; font-weight: 700; color: #111; margin-bottom: 3px;">Audit It</div>
                      <div style="font-size: 11px; color: #666; line-height: 1.4;">
                        Ask your rep if this is an error. 40% of sudden hikes are "system mistakes" that get reversed if challenged.
                      </div>
                    </td>

                    <td width="33%" style="vertical-align: top; padding-right: 10px;">
                      <div style="font-size: 16px; margin-bottom: 5px;">⚖️</div>
                      <div style="font-size: 13px; font-weight: 700; color: #111; margin-bottom: 3px;">Bench It</div>
                      <div style="font-size: 11px; color: #666; line-height: 1.4;">
                        Is this inflation or margin creep? Check The NXT dashboard to see if other suppliers raised rates too.
                      </div>
                    </td>

                    <td width="33%" style="vertical-align: top;">
                      <div style="font-size: 16px; margin-bottom: 5px;">🔒</div>
                      <div style="font-size: 13px; font-weight: 700; color: #111; margin-bottom: 3px;">Lock It</div>
                      <div style="font-size: 11px; color: #666; line-height: 1.4;">
                        If the price must stay, use it as leverage. Ask for a 6-month fixed price lock in exchange.
                      </div>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>

          <tr>
            <td style="background-color: #111111; padding: 30px; text-align: center;">
              <p style="color: #666; font-size: 13px; margin: 0 0 20px 0;">Take action before your next order.</p>
              <a href="https://dashboard.thenxt.ai" style="background-color: #ffffff; color: #000000; padding: 14px 40px; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 50px; display: inline-block; box-shadow: 0 4px 15px rgba(255, 255, 255, 0.2);">
                Open Dashboard &rarr;
              </a>
            </td>
          </tr>

        </table>
        
        <p style="margin-top: 30px; font-size: 11px; color: #aaa; text-align: center; font-family: 'Menlo', monospace;">
          POWERED BY THE NXT
        </p>

      </td>
    </tr>
  </table>

</body>
</html>
  `;
};

export const generatePriceAlertText = (items: PriceIncreaseItem[], totalCount: number, organisationName: string, generatedDate: Date = new Date()): string => {
  if (!items || items.length === 0) {
    return "Price increase detected\n\nNo items provided.";
  }

  // Sort by percent change descending
  const sortedItems = items.slice().sort((a, b) => b.percentChange - a.percentChange);
  
  // Take top 10 for display
  const displayItems = sortedItems.slice(0, 10);
  const remainingCount = totalCount - displayItems.length;

  const dateStr = formatDate(generatedDate);

  let text = `Price Spike Detected\n\n`;
  text += `Organisation: ${organisationName}\n`;
  text += `Date: ${dateStr}\n\n`;
  text += `We detected ${displayItems.length} product${displayItems.length > 1 ? 's' : ''} moving against your margin targets.\n\n`;

  text += `Price Changes:\n`;
  text += `${'='.repeat(50)}\n\n`;

  for (const item of displayItems) {
    const locationText = item.locationName ? ` (${item.supplierName} • ${item.locationName})` : ` (${item.supplierName})`;
    text += `${item.productName}${locationText}\n`;
    text += `Price: $${formatMoney(item.oldPrice)} → $${formatMoney(item.newPrice)} (+${formatPercent(item.percentChange)}%)\n\n`;
  }

  if (remainingCount > 0) {
    text += `+ ${remainingCount} more change${remainingCount > 1 ? 's' : ''} detected\n\n`;
  }

  text += `\nRecommended Actions:\n`;
  text += `${'='.repeat(50)}\n\n`;
  text += `🧐 Audit It: Ask your rep if this is an error. 40% of sudden hikes are "system mistakes" that get reversed if challenged.\n\n`;
  text += `⚖️ Bench It: Is this inflation or margin creep? Check The NXT dashboard to see if other suppliers raised rates too.\n\n`;
  text += `🔒 Lock It: If the price must stay, use it as leverage. Ask for a 6-month fixed price lock in exchange.\n\n`;

  text += `\nTake action before your next order.\n`;
  text += `View in dashboard: https://dashboard.thenxt.ai\n\n`;

  text += `POWERED BY THE NXT\n`;

  return text;
};

const escapeHtml = (text: string): string => {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
};

export const buildPriceIncreaseEmail = (items: PriceIncreaseItem[], totalCount: number, organisationName: string) => {
  if (!items || items.length === 0) {
    return {
      subject: "Price increase detected",
      html: generatePriceAlertHtml([], 0, organisationName),
      text: generatePriceAlertText([], 0, organisationName),
    };
  }

  // Sort by percent change descending
  const sortedItems = items.slice().sort((a, b) => b.percentChange - a.percentChange);
  
  // Take top 10 for display
  const displayItems = sortedItems.slice(0, 10);
  const actualTotalCount = totalCount || items.length;

  const generatedDate = new Date();

  if (displayItems.length === 1) {
    const i = displayItems[0];
    const subject = `Price increase detected – ${i.productName} (+${formatPercent(i.percentChange)}%)`;

    return {
      subject,
      html: generatePriceAlertHtml(displayItems, actualTotalCount, organisationName, generatedDate),
      text: generatePriceAlertText(displayItems, actualTotalCount, organisationName, generatedDate),
    };
  }

  const subject = `Price increase detected – ${displayItems.length} item${displayItems.length > 1 ? 's' : ''} found`;

  return {
    subject,
    html: generatePriceAlertHtml(displayItems, actualTotalCount, organisationName, generatedDate),
    text: generatePriceAlertText(displayItems, actualTotalCount, organisationName, generatedDate),
  };
};
