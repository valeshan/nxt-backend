import nodemailer from "nodemailer";
import { config } from "../../config/env";

type SendEmailParams = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
};

const requireEnv = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
};

export class GmailSmtpProvider {
  private transporter: nodemailer.Transporter;
  private fromEmail: string;
  private fromName: string;
  private defaultReplyTo?: string;

  constructor() {
    const user = requireEnv("GMAIL_ALERTS_USER");
    const pass = requireEnv("GMAIL_APP_PASSWORD");

    this.fromEmail = user;
    this.fromName = config.EMAIL_FROM_NAME || "the nxt alerts";
    this.defaultReplyTo = config.EMAIL_REPLY_TO;

    this.transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  }

  async sendEmail(params: SendEmailParams): Promise<void> {
    const toList = Array.isArray(params.to) ? params.to : [params.to];

    if (toList.length === 0) return;

    await this.transporter.sendMail({
      from: `${this.fromName} <${this.fromEmail}>`,
      to: toList.join(","),
      subject: params.subject,
      text: params.text,
      html: params.html,
      replyTo: params.replyTo || this.defaultReplyTo || this.fromEmail,
      headers: params.headers,
    });
  }
}

