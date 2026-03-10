/**
 * fake-ollama-server.ts — HTTP fake Ollama server for backend tests.
 *
 * Implements the subset of Ollama API endpoints that OllamaService uses:
 *   GET  /              — health probe (returns "Ollama is running")
 *   GET  /api/tags      — list available models
 *   POST /api/chat      — chat completion (streaming NDJSON or non-streaming JSON)
 *   POST /api/generate  — text generation (streaming NDJSON or non-streaming JSON)
 *   POST /api/embed     — generate text embeddings
 *
 * In tests, override the OLLAMA_URL environment variable (or point OllamaService's
 * baseUrl directly) to `server.getBaseUrl()` before running any AI operations.
 *
 * Usage:
 *   const server = new FakeOllamaServer();
 *   const port = await server.start();
 *   // Override OllamaService's base URL to point at the fake:
 *   ollamaService['baseUrl'] = server.getBaseUrl();
 *   // ... run test ...
 *   await server.stop();
 */

import * as http from 'http';

// ---- Types ----

/**
 * Shape of a single model entry as returned by GET /api/tags.
 */
export interface FakeOllamaModel {
  name: string;
  size: number;
  modified_at: string;
  digest: string;
}

/**
 * Shape of a non-streaming chat response message.
 */
export interface CannedChatResponse {
  model: string;
  message: { role: 'assistant'; content: string };
  done: boolean;
}

/**
 * Shape of a single NDJSON chunk in a streaming chat or generate response.
 */
export interface OllamaStreamChunk {
  model: string;
  message?: { role: 'assistant'; content: string };
  response?: string; // used by /api/generate
  done: boolean;
}

/**
 * All configurable behaviour for the fake server. Every field is optional;
 * omitted fields fall back to built-in defaults.
 */
export interface FakeOllamaConfig {
  /** Override the model list returned by GET /api/tags */
  models?: FakeOllamaModel[];
  /** Full response text for non-streaming POST /api/chat */
  chatResponse?: string;
  /** Token array for streaming POST /api/chat */
  chatStreamChunks?: string[];
  /** Full response text for non-streaming POST /api/generate */
  generateResponse?: string;
  /** Token array for streaming POST /api/generate */
  generateStreamChunks?: string[];
  /** Explicit embedding vectors (one per input string) */
  embeddings?: number[][];
  /** Dimension for auto-generated random embeddings when embeddings is not set */
  embedDimension?: number;
  /** Return HTTP 500 for GET / */
  healthError?: boolean;
  /** Return HTTP 500 for GET /api/tags */
  tagsError?: boolean;
  /** Return HTTP 500 for POST /api/chat */
  chatError?: boolean;
  /** Return HTTP 500 for POST /api/generate */
  generateError?: boolean;
  /** Return HTTP 500 for POST /api/embed */
  embedError?: boolean;
  /** Artificial delay in ms applied to all endpoints before responding */
  timeoutMs?: number;
  /** Informational: the model name that is considered "currently selected" */
  currentModel?: string;
}

/**
 * A record of a single HTTP request received by the fake server.
 * Use `getCapturedRequests()` / `getRequestsFor()` to inspect these in tests.
 */
export interface CapturedRequest {
  endpoint: string;
  method: string;
  body: Record<string, unknown>;
  timestamp: Date;
}

// ---- Main class ----

/**
 * A local plain-HTTP server that mimics the Ollama API endpoints consumed by
 * OllamaService. Start it, redirect OllamaService's baseUrl to `getBaseUrl()`,
 * and configure responses with the test-control methods below.
 */
export class FakeOllamaServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private config: FakeOllamaConfig = {};
  private capturedRequests: CapturedRequest[] = [];

  /** Built-in default model list (used when config.models is not set) */
  private readonly defaultModels: FakeOllamaModel[] = [
    {
      name: 'llama3.2:latest',
      size: 2_000_000_000,
      modified_at: '2025-01-01T00:00:00Z',
      digest: 'sha256:abc123',
    },
    {
      name: 'nomic-embed-text:latest',
      size: 500_000_000,
      modified_at: '2025-01-01T00:00:00Z',
      digest: 'sha256:def456',
    },
  ];

  // ---- Lifecycle ----

  /**
   * Start the HTTP server on a random available port on 127.0.0.1.
   * @returns Promise resolving with the assigned port number.
   */
  async start(): Promise<number> {
    this.server = http.createServer(
      (request: http.IncomingMessage, response: http.ServerResponse) => {
        this.handleRequest(request, response);
      },
    );

    return new Promise<number>((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error('FakeOllamaServer: failed to get port after server.listen()'));
        }
      });

      this.server!.on('error', (serverError: Error) => {
        reject(serverError);
      });
    });
  }

  /**
   * Shut down the HTTP server and release the port.
   * @returns Promise resolving when the server is fully closed.
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ---- Request routing ----

  private handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    request.on('end', (): void => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsedBody: Record<string, unknown> = {};

      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          // Not all endpoints send JSON; ignore parse failures gracefully.
        }
      }

      const requestUrl = request.url ?? '/';
      const method = request.method ?? 'GET';

      this.capturedRequests.push({
        endpoint: requestUrl,
        method,
        body: parsedBody,
        timestamp: new Date(),
      });

      // Dispatch to endpoint handlers asynchronously so delay and streaming work.
      this.dispatchRequest(requestUrl, method, parsedBody, response).catch(
        (dispatchError: unknown) => {
          // Surface any unhandled handler errors as HTTP 500 responses.
          if (!response.headersSent) {
            response.writeHead(500, { 'Content-Type': 'application/json' });
          }
          response.end(JSON.stringify({ error: String(dispatchError) }));
        },
      );
    });

    request.on('error', (requestError: Error) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
      }
      response.end(JSON.stringify({ error: requestError.message }));
    });
  }

  private async dispatchRequest(
    requestUrl: string,
    method: string,
    parsedBody: Record<string, unknown>,
    response: http.ServerResponse,
  ): Promise<void> {
    // Apply a global response delay when configured (simulates slow/timeout scenarios).
    if (this.config.timeoutMs && this.config.timeoutMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.timeoutMs));
    }

    if (requestUrl === '/' && method === 'GET') {
      this.handleHealth(response);
    } else if (requestUrl === '/api/tags' && method === 'GET') {
      this.handleTags(response);
    } else if (requestUrl === '/api/chat' && method === 'POST') {
      await this.handleChat(parsedBody, response);
    } else if (requestUrl === '/api/generate' && method === 'POST') {
      await this.handleGenerate(parsedBody, response);
    } else if (requestUrl === '/api/embed' && method === 'POST') {
      this.handleEmbed(parsedBody, response);
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found', path: requestUrl }));
    }
  }

  // ---- Endpoint handlers ----

  private handleHealth(response: http.ServerResponse): void {
    if (this.config.healthError) {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('Internal Server Error');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Ollama is running');
  }

  private handleTags(response: http.ServerResponse): void {
    if (this.config.tagsError) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'server error' }));
      return;
    }

    const models = this.config.models ?? this.defaultModels;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ models }));
  }

  private async handleChat(
    body: Record<string, unknown>,
    response: http.ServerResponse,
  ): Promise<void> {
    if (this.config.chatError) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'chat error' }));
      return;
    }

    // Ollama's default is stream: true; only false when explicitly set.
    const shouldStream = body['stream'] !== false;
    const modelName = typeof body['model'] === 'string' ? body['model'] : 'llama3.2:latest';

    if (shouldStream) {
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
      });

      const streamChunks = this.config.chatStreamChunks ?? ['Hello', ' world', '!'];
      for (const tokenText of streamChunks) {
        const streamLine: OllamaStreamChunk = {
          model: modelName,
          message: { role: 'assistant', content: tokenText },
          done: false,
        };
        response.write(JSON.stringify(streamLine) + '\n');
        // Small inter-token delay to simulate realistic streaming behaviour.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }

      // Final termination chunk with done: true.
      const finalChunk: OllamaStreamChunk = {
        model: modelName,
        message: { role: 'assistant', content: '' },
        done: true,
      };
      response.write(JSON.stringify(finalChunk) + '\n');
      response.end();
    } else {
      const responseContent = this.config.chatResponse ?? 'Hello world!';
      const responseBody = {
        model: modelName,
        message: { role: 'assistant', content: responseContent },
        done: true,
        total_duration: 1_000_000,
        eval_count: 10,
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(responseBody));
    }
  }

  private async handleGenerate(
    body: Record<string, unknown>,
    response: http.ServerResponse,
  ): Promise<void> {
    if (this.config.generateError) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'generate error' }));
      return;
    }

    const shouldStream = body['stream'] !== false;
    const modelName = typeof body['model'] === 'string' ? body['model'] : 'llama3.2:latest';

    if (shouldStream) {
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
      });

      const streamChunks = this.config.generateStreamChunks ?? ['Hello', ' world', '!'];
      for (const tokenText of streamChunks) {
        const streamLine: OllamaStreamChunk = {
          model: modelName,
          response: tokenText,
          done: false,
        };
        response.write(JSON.stringify(streamLine) + '\n');
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }

      const finalChunk: OllamaStreamChunk = {
        model: modelName,
        response: '',
        done: true,
      };
      response.write(JSON.stringify(finalChunk) + '\n');
      response.end();
    } else {
      const responseText = this.config.generateResponse ?? 'Hello world!';
      const responseBody = {
        model: modelName,
        response: responseText,
        done: true,
        total_duration: 1_000_000,
        eval_count: 10,
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(responseBody));
    }
  }

  private handleEmbed(body: Record<string, unknown>, response: http.ServerResponse): void {
    if (this.config.embedError) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'embed error' }));
      return;
    }

    // The Ollama /api/embed endpoint accepts a single string or an array of strings.
    const inputField = body['input'] as string | string[] | undefined;
    const inputArray: string[] = Array.isArray(inputField)
      ? inputField
      : typeof inputField === 'string'
        ? [inputField]
        : [''];

    const vectorDimension = this.config.embedDimension ?? 768;

    let embeddingVectors: number[][];
    if (
      this.config.embeddings &&
      this.config.embeddings.length >= inputArray.length
    ) {
      // Use the explicitly configured embedding vectors when available.
      embeddingVectors = this.config.embeddings.slice(0, inputArray.length);
    } else {
      // Generate random unit-range vectors when no explicit embeddings are configured.
      embeddingVectors = inputArray.map(() => {
        return Array.from(
          { length: vectorDimension },
          () => (Math.random() * 2) - 1,
        );
      });
    }

    const modelName =
      typeof body['model'] === 'string' ? body['model'] : 'nomic-embed-text:latest';

    const responseBody = {
      model: modelName,
      embeddings: embeddingVectors,
      total_duration: 100_000,
      load_duration: 10_000,
      prompt_eval_count: inputArray.length,
    };

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responseBody));
  }

  // ---- Test-control API ----

  /**
   * Merge additional configuration into the current config.
   * Only the specified fields are changed; all other fields keep their current values.
   * To clear all configuration, call `reset()`.
   */
  configure(config: Partial<FakeOllamaConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Override the model list returned by GET /api/tags.
   */
  setModels(models: FakeOllamaModel[]): void {
    this.config.models = models;
  }

  /**
   * Set the full response text returned for non-streaming POST /api/chat requests.
   */
  setChatResponse(text: string): void {
    this.config.chatResponse = text;
  }

  /**
   * Set the token sequence returned for streaming POST /api/chat requests.
   * Each string in the array becomes a separate NDJSON chunk.
   */
  setChatStreamChunks(chunks: string[]): void {
    this.config.chatStreamChunks = chunks;
  }

  /**
   * Set the full response text returned for non-streaming POST /api/generate requests.
   */
  setGenerateResponse(text: string): void {
    this.config.generateResponse = text;
  }

  /**
   * Set the token sequence returned for streaming POST /api/generate requests.
   */
  setGenerateStreamChunks(chunks: string[]): void {
    this.config.generateStreamChunks = chunks;
  }

  /**
   * Provide explicit embedding vectors for POST /api/embed.
   * The vectors are returned in order — one per input string.
   * If fewer vectors are provided than inputs, random vectors fill the remainder.
   */
  setEmbeddings(embeddings: number[][]): void {
    this.config.embeddings = embeddings;
  }

  /**
   * Set the vector dimension used when auto-generating random embeddings
   * (i.e. when `setEmbeddings()` has not been called). Default is 768.
   */
  setEmbedDimension(dimension: number): void {
    this.config.embedDimension = dimension;
  }

  /**
   * Enable or disable error simulation for a specific endpoint.
   * When enabled, that endpoint returns HTTP 500 regardless of the request body.
   */
  setError(
    endpoint: 'health' | 'tags' | 'chat' | 'generate' | 'embed',
    hasError: boolean,
  ): void {
    switch (endpoint) {
      case 'health': {
        this.config.healthError = hasError;
        break;
      }
      case 'tags': {
        this.config.tagsError = hasError;
        break;
      }
      case 'chat': {
        this.config.chatError = hasError;
        break;
      }
      case 'generate': {
        this.config.generateError = hasError;
        break;
      }
      case 'embed': {
        this.config.embedError = hasError;
        break;
      }
    }
  }

  /**
   * Configure an artificial delay (in milliseconds) applied to all endpoints
   * before any response data is sent. Set to 0 to disable.
   * Useful for testing request timeouts and AbortSignal behaviour.
   */
  setResponseDelay(delayMs: number): void {
    this.config.timeoutMs = delayMs;
  }

  /**
   * Return a snapshot of all HTTP requests this server received, in arrival order.
   * Useful for asserting that OllamaService sent the expected requests.
   */
  getCapturedRequests(): CapturedRequest[] {
    return [...this.capturedRequests];
  }

  /**
   * Return all captured requests whose URL path matches the given endpoint string.
   * Example: `getRequestsFor('/api/chat')`
   */
  getRequestsFor(endpoint: string): CapturedRequest[] {
    return this.capturedRequests.filter(
      (capturedRequest) => capturedRequest.endpoint === endpoint,
    );
  }

  /**
   * Return the most recently received request, or `undefined` if no requests
   * have been received yet.
   */
  getLastRequest(): CapturedRequest | undefined {
    return this.capturedRequests[this.capturedRequests.length - 1];
  }

  /**
   * Clear all configuration overrides and all captured request history,
   * returning the server to its default state without restarting it.
   */
  reset(): void {
    this.config = {};
    this.capturedRequests = [];
  }

  /**
   * Return the TCP port the server is currently bound to.
   * Returns 0 before `start()` is called.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Return the full base URL for this server.
   * Use this to override OllamaService's baseUrl in tests.
   * Example: `http://127.0.0.1:54321`
   */
  getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}
