import { GmailSmtpProvider } from "./emailProviders/gmailSmtpProvider";
import { buildPriceIncreaseEmail, PriceIncreaseItem } from "./emailTemplates/priceIncreaseTemplates";

export class NotificationService {
  private emailProvider: GmailSmtpProvider;

  constructor() {
    this.emailProvider = new GmailSmtpProvider();
  }

  async sendPriceIncreaseAlert(params: {
    toEmail: string | string[];
    items: PriceIncreaseItem[];
    totalCount?: number;
  }): Promise<void> {
    const { subject, html, text } = buildPriceIncreaseEmail(params.items, params.totalCount);

    await this.emailProvider.sendEmail({
      to: params.toEmail,
      subject,
      text,
      html,
    });

    // Log the alert for traceability
    const recipientList = Array.isArray(params.toEmail) ? params.toEmail : [params.toEmail];
    console.log(`[PriceAlert] Sent alert to ${recipientList.join(", ")}: ${params.items.length} item(s)`, {
      recipientEmails: recipientList,
      itemCount: params.items.length,
      totalCount: params.totalCount || params.items.length,
      timestamp: new Date().toISOString(),
    });
  }
}

