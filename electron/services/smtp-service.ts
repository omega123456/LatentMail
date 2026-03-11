import * as nodemailer from 'nodemailer';
import { LoggerService } from './logger-service';
import { OAuthService } from './oauth-service';

const log = LoggerService.getInstance();
import { DatabaseService } from './database-service';

export interface SendMailOptions {
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    filename: string;
    content?: Buffer | string;
    path?: string;
    contentType?: string;
  }>;
}

export class SmtpService {
  private static instance: SmtpService;

  private constructor() {}

  static getInstance(): SmtpService {
    if (!SmtpService.instance) {
      SmtpService.instance = new SmtpService();
    }
    return SmtpService.instance;
  }

  /**
   * Send an email via Gmail SMTP with OAuth2 authentication.
   */
  async sendEmail(accountId: string, message: SendMailOptions): Promise<{ messageId: string }> {
    const oauthService = OAuthService.getInstance();
    const db = DatabaseService.getInstance();
    const account = db.getAccountById(Number(accountId));

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const accessToken = await oauthService.getAccessToken(accountId);

    // Allow env var overrides for test environments.
    // SMTP_HOST overrides the server hostname (e.g. pointing to a local fake SMTP server).
    // SMTP_PORT overrides the port number.
    // SMTP_SECURE overrides TLS explicitly; defaults to true (secure) regardless of host override.
    const smtpHostOverride = process.env['SMTP_HOST'];
    const smtpPortOverride = process.env['SMTP_PORT'];
    const smtpSecureOverride = process.env['SMTP_SECURE'];

    const smtpHost = smtpHostOverride || 'smtp.gmail.com';
    const smtpPort = smtpPortOverride ? Number(smtpPortOverride) : 465;
    const smtpSecure = smtpSecureOverride !== undefined
      ? smtpSecureOverride === 'true' || smtpSecureOverride === '1'
      : true;

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        type: 'OAuth2',
        user: account.email,
        accessToken: accessToken,
      },
    });

    try {
      const mailOptions: nodemailer.SendMailOptions = {
        from: message.from || `${account.displayName} <${account.email}>`,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        text: message.text,
        html: message.html,
        inReplyTo: message.inReplyTo,
        references: message.references,
        attachments: message.attachments,
      };

      const result = await transporter.sendMail(mailOptions);
      log.info(`Email sent from account ${accountId}: ${result.messageId}`);

      return { messageId: result.messageId };
    } finally {
      transporter.close();
    }
  }
}
