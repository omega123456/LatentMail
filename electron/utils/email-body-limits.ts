/**
 * Maximum HTML body length (UTF-16 code units) kept in the reading pane / display
 * pipeline after MIME parse. Larger HTML parts are truncated to avoid html-to-text
 * and UI limits; see mail-parser-worker truncation logic.
 */
export const EMAIL_BODY_HTML_MAX_DISPLAY_CHARS = 524_288;
