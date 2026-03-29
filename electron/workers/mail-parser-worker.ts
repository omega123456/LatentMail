/**
 * Mail Parser Worker Thread
 *
 * Runs off the main Electron process thread to handle the CPU-intensive
 * simpleParser calls for email MIME parsing. Supports three parse modes:
 * body (CID-resolved HTML + attachment metadata), text-only (raw text/html),
 * and full (all attachment content buffers included).
 *
 * Body and text-only modes use skipHtmlToText so mailparser never runs html-to-text
 * on multi-megabyte HTML; the worker truncates display HTML and derives text safely.
 *
 * Communication protocol (via parentPort messages):
 *
 * Main → Worker:
 *   { type: 'parse', requestId: number, sourceBuffer: Buffer, mode: 'body' | 'text-only' | 'full' }
 *
 * Worker → Main:
 *   { type: 'result', requestId: number, textBody, htmlBody, bodyTruncated, attachments? | fullAttachments? }
 *   { type: 'error', requestId: number, error: string }
 *   { type: 'log', level: 'info' | 'warn' | 'error' | 'debug', message: string }
 *
 * IMPORTANT: Only one simpleParser call runs at a time. Node.js parentPort.on('message', async ...)
 * does NOT serialize async handlers — without explicit serialization, overlapping concurrent calls
 * to simpleParser would occur. A promise-chain pattern ensures strict FIFO sequential processing.
 */

import { parentPort } from 'worker_threads';
import { simpleParser } from 'mailparser';
import { htmlToText } from 'html-to-text';
import {
  resolveInlineImages,
  type ParseRequest,
  type ParseBodyResult,
  type ParseTextOnlyResult,
  type ParseFullResult,
  type ParseError,
  type FullAttachment,
  type SimpleParserAttachment,
} from '../utils/resolve-inline-images';
import { coerceToBuffer } from '../utils/coerce-buffer';
import { EMAIL_BODY_HTML_MAX_DISPLAY_CHARS } from '../utils/email-body-limits';

// ---- Assert parentPort at module level ----
// This file is only valid as a worker thread entrypoint; parentPort must exist.

if (!parentPort) {
  throw new Error('mail-parser-worker must be run as a worker thread');
}
const port = parentPort;

// ---- Helpers ----

function postLog(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
  port.postMessage({ type: 'log', level, message });
}

interface ParsedMailShape {
  text?: string;
  html?: string;
  attachments?: unknown[];
}

/**
 * After skipHtmlToText parse: cap HTML length and build plain text for display.
 */
function truncateHtmlAndDeriveText(parsed: ParsedMailShape): {
  textBody: string | null;
  htmlForDisplay: string | null;
  bodyTruncated: boolean;
} {
  const trimmedPlain = parsed.text ? parsed.text.trim() : '';
  const rawHtmlTrimmed = parsed.html ? parsed.html.trim() : null;

  let bodyTruncated = false;
  let htmlForDisplay: string | null = rawHtmlTrimmed;
  if (rawHtmlTrimmed && rawHtmlTrimmed.length > EMAIL_BODY_HTML_MAX_DISPLAY_CHARS) {
    bodyTruncated = true;
    htmlForDisplay = rawHtmlTrimmed.slice(0, EMAIL_BODY_HTML_MAX_DISPLAY_CHARS);
  }

  let textBody: string | null = null;
  if (trimmedPlain.length > 0) {
    textBody = trimmedPlain;
  } else if (htmlForDisplay && htmlForDisplay.length > 0) {
    const asText = htmlToText(htmlForDisplay, {
      limits: { maxInputLength: EMAIL_BODY_HTML_MAX_DISPLAY_CHARS },
    }).trim();
    textBody = asText.length > 0 ? asText : null;
  }

  return { textBody, htmlForDisplay, bodyTruncated };
}

// ---- Promise-chain serialization ----
// Each incoming request is chained onto processingTail, guaranteeing strict FIFO
// single-concurrency without an explicit queue array or isProcessing flag.

let processingTail = Promise.resolve();

// ---- Parse handler ----

async function handleParse(messageData: ParseRequest): Promise<void> {
  const { requestId, mode } = messageData;

  // Re-wrap sourceBuffer: structured clone converts Buffer to Uint8Array on the receiving side
  const sourceBuffer = coerceToBuffer(messageData.sourceBuffer);

  if (mode === 'full') {
    const parsed = await simpleParser(sourceBuffer);
    const textBody = parsed.text ? parsed.text.trim() : null;
    const rawHtml = parsed.html ? parsed.html.trim() : null;
    const parsedAttachments = (parsed.attachments || []) as unknown as SimpleParserAttachment[];
    const fullAttachments: FullAttachment[] = parsedAttachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      contentId: attachment.contentId,
      content: attachment.content,
      contentDisposition: attachment.contentDisposition,
    }));

    const result: ParseFullResult = {
      type: 'result',
      requestId,
      textBody,
      htmlBody: rawHtml,
      fullAttachments,
    };
    port.postMessage(result);
    return;
  }

  const parsed = await simpleParser(sourceBuffer, { skipHtmlToText: true });
  const { textBody, htmlForDisplay, bodyTruncated } = truncateHtmlAndDeriveText(
    parsed as ParsedMailShape,
  );

  if (mode === 'text-only') {
    const result: ParseTextOnlyResult = {
      type: 'result',
      requestId,
      textBody,
      htmlBody: htmlForDisplay,
      bodyTruncated,
    };
    port.postMessage(result);
    return;
  }

  if (mode === 'body') {
    const parsedAttachments = (parsed.attachments || []) as unknown as SimpleParserAttachment[];

    const resolved = resolveInlineImages(htmlForDisplay ?? '', parsedAttachments);
    const htmlBody = htmlForDisplay ? resolved.htmlBody.trim() || null : null;
    const attachments = resolved.attachments;

    const result: ParseBodyResult = {
      type: 'result',
      requestId,
      textBody,
      htmlBody,
      attachments,
      bodyTruncated,
    };
    port.postMessage(result);
    return;
  }

  const errorResponse: ParseError = {
    type: 'error',
    requestId,
    error: `Unknown parse mode: ${mode}`,
  };
  port.postMessage(errorResponse);
}

// ---- Message handler ----

port.on('message', (message: ParseRequest) => {
  if (message.type === 'parse') {
    processingTail = processingTail.then(async () => {
      try {
        await handleParse(message);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        postLog('error', `[MailParserWorker] Unexpected error processing requestId=${message.requestId}: ${errorMessage}`);
        const errorResponse: ParseError = {
          type: 'error',
          requestId: message.requestId,
          error: errorMessage,
        };
        port.postMessage(errorResponse);
      }
    });
  }
});

postLog('info', '[MailParserWorker] Started');
