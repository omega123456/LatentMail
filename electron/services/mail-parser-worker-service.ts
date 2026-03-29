/**
 * MailParserWorkerService — main-thread singleton that manages the mail-parser worker thread.
 *
 * Lazily spawns a single worker on first parse request, routes parse requests to it,
 * and handles lifecycle (timeout, shutdown, testing reset). The worker thread runs
 * simpleParser off the main thread to avoid blocking Electron IPC and UI rendering.
 *
 * Three parse modes:
 * - body:      CID-resolved HTML, text body, non-inline attachment metadata
 * - text-only: raw text/html (no CID resolution, no attachment processing)
 * - full:      text, raw HTML, all attachment content buffers (for draft/send flows)
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import { LoggerService } from './logger-service';
import { coerceToBuffer } from '../utils/coerce-buffer';
import type {
  ParseRequest,
  ParseBodyResult,
  ParseTextOnlyResult,
  ParseFullResult,
  ParseError,
  LogMessage,
  ParsedAttachmentMeta,
  FullAttachment,
} from '../utils/resolve-inline-images';

const log = LoggerService.getInstance();

/** Per-request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Union of all successful result types the worker can send back. */
type ParseResult = ParseBodyResult | ParseTextOnlyResult | ParseFullResult;

interface PendingRequest {
  resolve: (value: ParseResult) => void;
  reject: (reason: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

export class MailParserWorkerService {
  private static instance: MailParserWorkerService | null = null;

  private worker: Worker | null = null;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private requestCounter: number = 0;
  private isShuttingDown: boolean = false;

  private constructor() {}

  static getInstance(): MailParserWorkerService {
    if (!MailParserWorkerService.instance) {
      MailParserWorkerService.instance = new MailParserWorkerService();
    }
    return MailParserWorkerService.instance;
  }

  // ---- Public API ----

  /**
   * Parse email in body mode: returns text body, CID-resolved HTML body,
   * and non-inline attachment metadata.
   */
  async parseBodyMode(sourceBuffer: Buffer): Promise<{
    textBody: string | null;
    htmlBody: string | null;
    attachments: ParsedAttachmentMeta[];
    bodyTruncated: boolean;
  }> {
    const result = await this.sendRequest(sourceBuffer, 'body') as ParseBodyResult;
    return {
      textBody: result.textBody,
      htmlBody: result.htmlBody,
      attachments: result.attachments,
      bodyTruncated: result.bodyTruncated,
    };
  }

  /**
   * Parse email in text-only mode: returns text body and raw HTML body
   * (no CID resolution, no attachment processing).
   */
  async parseTextOnlyMode(sourceBuffer: Buffer): Promise<{
    textBody: string | null;
    htmlBody: string | null;
    bodyTruncated: boolean;
  }> {
    const result = await this.sendRequest(sourceBuffer, 'text-only') as ParseTextOnlyResult;
    return {
      textBody: result.textBody,
      htmlBody: result.htmlBody,
      bodyTruncated: result.bodyTruncated,
    };
  }

  /**
   * Parse email in full mode: returns text body, raw HTML body,
   * and all attachment payloads (with content buffers).
   */
  async parseFullMode(sourceBuffer: Buffer): Promise<{
    textBody: string | null;
    htmlBody: string | null;
    fullAttachments: FullAttachment[];
  }> {
    const result = await this.sendRequest(sourceBuffer, 'full') as ParseFullResult;

    // Re-wrap attachment content: structured clone converts Buffer to Uint8Array
    const fullAttachments = result.fullAttachments.map((attachment) => ({
      ...attachment,
      content: coerceToBuffer(attachment.content),
    }));

    return {
      textBody: result.textBody,
      htmlBody: result.htmlBody,
      fullAttachments,
    };
  }

  /**
   * Gracefully shut down the worker thread (fire-and-forget).
   * Sets isShuttingDown to prevent new requests from spawning a new worker.
   * Does NOT null this.worker — the exit handler is the single cleanup path.
   */
  shutdown(): void {
    this.isShuttingDown = true;
    if (this.worker) {
      this.worker.terminate().catch(() => {});
    }
  }

  /**
   * Terminate the worker and wait for full exit. Clears all pending state.
   * Used in tests to ensure clean state between suites.
   * Does NOT null this.worker directly — waits for the exit handler to do cleanup.
   */
  async resetForTesting(): Promise<void> {
    const currentWorker = this.worker;

    if (currentWorker) {
      // Listen for the exit event BEFORE calling terminate so we don't miss it
      const exitPromise = new Promise<void>((resolve) => {
        currentWorker.once('exit', () => resolve());
      });

      try {
        await currentWorker.terminate();
      } catch {
        // Ignore termination errors
      }

      // Wait for the exit handler to fire and perform cleanup (nulls this.worker, rejects pending)
      await exitPromise;
    }

    // Clear any remaining pending requests defensively (exit handler should have handled these,
    // but clear in case terminate resolved before exit fired)
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('Worker reset for testing'));
      this.pendingRequests.delete(requestId);
    }
    this.pendingRequests.clear();
    this.requestCounter = 0;
    this.isShuttingDown = false;
  }

  // ---- Internal ----

  /**
   * Lazily spawn the worker thread on first use.
   * Throws if the service is shutting down (prevents spawning after shutdown).
   */
  private ensureWorker(): Worker {
    if (this.isShuttingDown) {
      throw new Error('MailParserWorkerService is shutting down');
    }

    if (this.worker) {
      return this.worker;
    }

    const workerPath = path.join(__dirname, '..', 'workers', 'mail-parser-worker.js');

    const worker = new Worker(workerPath);

    // Permanent message listener: handles log forwarding, result/error dispatch.
    // Uses discriminated-union narrowing on message.type instead of type casts.
    worker.on('message', (message: ParseResult | ParseError | LogMessage) => {
      switch (message.type) {
        case 'log': {
          const level = (message.level ?? 'info') as 'info' | 'warn' | 'error' | 'debug';
          const logFunction = (log[level] as ((msg: unknown, ...args: unknown[]) => void) | undefined) ?? log.info.bind(log);
          logFunction(message.message);
          return;
        }

        case 'error': {
          const pending = this.pendingRequests.get(message.requestId);
          if (!pending) {
            return; // Already timed out or cleaned up
          }
          clearTimeout(pending.timeoutHandle);
          this.pendingRequests.delete(message.requestId);
          pending.reject(new Error(message.error));
          return;
        }

        case 'result': {
          const pending = this.pendingRequests.get(message.requestId);
          if (!pending) {
            return; // Already timed out or cleaned up
          }
          clearTimeout(pending.timeoutHandle);
          this.pendingRequests.delete(message.requestId);
          pending.resolve(message);
          return;
        }
      }
    });

    // Error listener: log and let exit handler do cleanup
    worker.on('error', (err: Error) => {
      log.error('[MailParserWorkerService] Worker thread error:', err);
    });

    // Exit listener: SINGLE unified cleanup path — rejects ALL pending promises
    worker.on('exit', (exitCode: number) => {
      log.debug(`[MailParserWorkerService] Worker exited with code ${exitCode}`);

      // Reject all pending requests
      for (const [requestId, pending] of this.pendingRequests) {
        clearTimeout(pending.timeoutHandle);
        pending.reject(new Error(`Mail parser worker exited unexpectedly (code ${exitCode})`));
        this.pendingRequests.delete(requestId);
      }
      this.pendingRequests.clear();

      // Clear worker reference so next request spawns a fresh one
      if (this.worker === worker) {
        this.worker = null;
      }
    });

    this.worker = worker;
    return worker;
  }

  /**
   * Send a parse request to the worker and return a promise that resolves with
   * the result or rejects on error/timeout.
   */
  private sendRequest(
    sourceBuffer: Buffer,
    mode: 'body' | 'text-only' | 'full'
  ): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
      const worker = this.ensureWorker();
      const requestId = ++this.requestCounter;

      // Capture the worker instance at request time for the timeout callback.
      // Using this.worker in the timeout could terminate a NEWER worker spawned after reset.
      const capturedWorker = worker;
      const timeoutHandle = setTimeout(() => {
        log.warn(`[MailParserWorkerService] Request ${requestId} timed out after ${REQUEST_TIMEOUT_MS}ms`);
        capturedWorker.terminate().catch(() => {});
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutHandle,
      });

      const request: ParseRequest = {
        type: 'parse',
        requestId,
        sourceBuffer,
        mode,
      };

      // Send via structured clone (NO transferList) to avoid buffer pool slab corruption.
      // Wrap in try/catch to clean up stale state if postMessage throws.
      try {
        worker.postMessage(request);
      } catch (postError) {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(requestId);
        reject(postError instanceof Error ? postError : new Error(String(postError)));
      }
    });
  }
}
