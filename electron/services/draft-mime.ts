import * as nodemailer from 'nodemailer';
import log from 'electron-log/main';

interface DraftMimeOptions {
  from: string;        // e.g. "Display Name <user@gmail.com>"
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html?: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

/**
 * Build a raw RFC822 MIME message Buffer from a draft, suitable for IMAP APPEND.
 * Uses nodemailer's streamTransport (no network, no new dependency).
 */
export async function buildDraftMime(options: DraftMimeOptions): Promise<Buffer> {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });

  const mailOptions: nodemailer.SendMailOptions = {
    from: options.from,
    to: options.to || undefined,
    cc: options.cc || undefined,
    bcc: options.bcc || undefined,
    subject: options.subject,
    html: options.html || undefined,
    text: options.text || undefined,
    inReplyTo: options.inReplyTo || undefined,
    references: options.references || undefined,
    attachments: options.attachments,
    // Mark as draft in headers
    headers: {
      'X-Mozilla-Draft-Info': '1',
    },
  };

  try {
    const info = await transport.sendMail(mailOptions);
    // With buffer: true, info.message is a Buffer
    const buffer = info.message as unknown as Buffer;
    return buffer;
  } catch (err) {
    log.error('Failed to build draft MIME:', err);
    throw err;
  } finally {
    transport.close();
  }
}
