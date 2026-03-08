/**
 * Text chunking utility for email body segmentation before embedding.
 *
 * Responsible for:
 * - Stripping HTML tags and decoding common entities
 * - Splitting text into overlapping word-window chunks suitable for embedding
 * - Prepending selected email metadata to the first chunk for contextual grounding
 */

import { stripVTControlCharacters } from 'util';

/** C0 control characters (excluding tab, newline, carriage return) to strip before chunking. */
const C0_CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Number of whitespace-delimited words per chunk. */
const CHUNK_SIZE_WORDS = 200;

/** Number of words of overlap between consecutive chunks. */
const CHUNK_OVERLAP_WORDS = 50;

/**
 * Strip HTML tags from text and decode common HTML entities.
 * Uses a lightweight regex approach — not a full HTML parser, but sufficient
 * for typical email bodies before embedding.
 */
export function stripHtml(html: string): string {
  // Remove script and style element content entirely
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');

  // Replace block-level and line-break tags with spaces for word boundary preservation
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, ' ');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]*>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const codePoint = parseInt(code, 10);
      // Only convert printable characters
      if (codePoint > 31 && codePoint < 65536) {
        return String.fromCharCode(codePoint);
      }
      return ' ';
    });

  // Collapse runs of whitespace (spaces, tabs, newlines) into a single space
  text = text.replace(/\s+/g, ' ').trim();

  text = text.split(/\s+/).map(word => word.length > 80 ? '[URL]' : word).join(' ');

  return text;
}

/**
 * Split a plain-text string into overlapping word-window chunks.
 * Each chunk is approximately CHUNK_SIZE_WORDS words long, with
 * CHUNK_OVERLAP_WORDS words of overlap between consecutive chunks.
 *
 * @param text - Plain text to chunk (HTML should already be stripped)
 * @param metadata - Email metadata to prepend to the first chunk
 * @returns Array of chunk strings; empty array if text is empty/null
 */
export function chunkText(text: string | null | undefined, metadata?: EmbeddingChunkMetadata): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  // Guard against misconfigured constants (would cause an infinite loop)
  if (CHUNK_OVERLAP_WORDS >= CHUNK_SIZE_WORDS) {
    throw new Error(
      `Invalid chunker configuration: CHUNK_OVERLAP_WORDS (${CHUNK_OVERLAP_WORDS}) ` +
      `must be less than CHUNK_SIZE_WORDS (${CHUNK_SIZE_WORDS})`
    );
  }

  const cleanText = stripVTControlCharacters(text).replace(C0_CONTROL_REGEX, '');
  let words = cleanText.trim().split(/\s+/);
  words = words.map(word => word.length > 80 ? '[URL]' : word);
  if (words.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let startIndex = 0;

  while (startIndex < words.length) {
    const endIndex = Math.min(startIndex + CHUNK_SIZE_WORDS, words.length);
    const chunkWords = words.slice(startIndex, endIndex);
    chunks.push(chunkWords.join(' '));

    // If this chunk reaches the end of the text, stop
    if (endIndex >= words.length) {
      break;
    }

    // Advance by (chunk size - overlap) for next chunk
    startIndex += CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS;
  }

  const metadataLines: string[] = [];
  const subject = metadata?.subject?.trim() ?? '';
  const fromAddress = metadata?.fromAddress?.trim() ?? '';
  const toAddresses = metadata?.toAddresses?.trim() ?? '';

  if (fromAddress.length > 0) {
    metadataLines.push(`From: ${fromAddress}`);
  }

  if (metadata?.includeToAddresses && toAddresses.length > 0) {
    metadataLines.push(`To: ${toAddresses}`);
  }

  if (subject.length > 0) {
    metadataLines.push(`Subject: ${subject}`);
  }

  if (chunks.length > 0 && metadataLines.length > 0) {
    chunks[0] = `${metadataLines.join('\n')}\n\n${chunks[0]}`;
  }

  return chunks;
}

/**
 * Process an email body (HTML or plain text) into embedding-ready chunks.
 * Handles both text_body and html_body, preferring text_body for cleaner output.
 *
 * @param textBody - Plain text body (preferred)
 * @param htmlBody - HTML body (used if textBody is absent)
 * @param metadata - Email metadata to prepend to the first chunk
 * @returns Array of chunk strings; empty array if both bodies are absent/empty
 */
export function chunkEmailBody(
  textBody: string | null | undefined,
  htmlBody: string | null | undefined,
  metadata?: EmbeddingChunkMetadata
): string[] {
  // Prefer text_body for cleaner embedding input; fall back to stripped HTML
  const rawText = (textBody && textBody.trim().length > 0)
    ? textBody
    : (htmlBody ? stripHtml(htmlBody) : null);

  return chunkText(rawText, metadata);
}
export interface EmbeddingChunkMetadata {
  subject?: string;
  fromAddress?: string;
  toAddresses?: string;
  includeToAddresses?: boolean;
}
