import log from 'electron-log/main';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const VALID_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function isValidLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (VALID_LEVELS as readonly string[]).includes(value);
}

/**
 * Singleton wrapper around `electron-log` that centralizes all logging configuration
 * for the main process.
 *
 * Two-phase initialization:
 *  - Phase 1 (constructor / first getInstance() call): calls log.initialize(), sets the
 *    file transport max size, and applies the LOG_LEVEL env var (or 'info' as the
 *    ultimate fallback). Logging is fully functional after Phase 1.
 *  - Phase 2 (initialize() method): lazily imports DatabaseService and overrides the
 *    transport level with whatever was persisted in the settings table.  Must be called
 *    after DatabaseService.initialize() completes.
 *
 * Circular dependency (LoggerService ↔ DatabaseService) is broken by importing
 * DatabaseService inside method bodies only — never at module scope.
 * Internal operational logging (errors within setLevel/initialize) uses the raw
 * electron-log instance directly to avoid recursion.
 */
export class LoggerService {
  private static instance: LoggerService;
  private currentLevel: LogLevel;

  private constructor() {
    // ── Phase 1: early bootstrap ───────────────────────────────────────────
    log.initialize();
    log.transports.file.maxSize = 10 * 1024 * 1024; // 10 MB

    const envLevel = process.env['LOG_LEVEL'];
    this.currentLevel = isValidLevel(envLevel) ? envLevel : 'info';
    log.transports.file.level = this.currentLevel;
    // Console transport is deliberately left at its electron-log default.
  }

  static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }

  /**
   * Phase 2 — DB-aware initialization.
   * Reads the persisted `logLevel` setting from the database and applies it if valid.
   * Must be called immediately after DatabaseService.initialize() succeeds.
   */
  initialize(): void {
    try {
      // Lazy import: breaks the circular dependency with DatabaseService.
      // By the time this method is called, DatabaseService is fully initialized.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseService } = require('./database-service') as typeof import('./database-service');
      const storedLevel = DatabaseService.getInstance().getSetting('logLevel');
      if (isValidLevel(storedLevel)) {
        this.currentLevel = storedLevel;
        log.transports.file.level = this.currentLevel;
        log.info(`[LoggerService] File log level applied from database: ${this.currentLevel}`);
      } else if (storedLevel !== null) {
        log.warn(
          `[LoggerService] Ignoring invalid stored log level: '${storedLevel}', ` +
          `keeping '${this.currentLevel}'`
        );
      }
    } catch (err) {
      log.error('[LoggerService] Failed to read log level from database:', err);
    }
  }

  /**
   * Update the file transport log level immediately and persist it to the database.
   * The whitelist is validated before any mutation occurs.
   */
  setLevel(level: LogLevel): void {
    if (!isValidLevel(level)) {
      log.error(`[LoggerService] Attempted to set invalid log level: '${level}'`);
      return;
    }
    this.currentLevel = level;
    log.transports.file.level = level;
    try {
      // Lazy import to avoid circular dependency at module scope.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseService } = require('./database-service') as typeof import('./database-service');
      DatabaseService.getInstance().setSetting('logLevel', level);
    } catch (err) {
      log.error('[LoggerService] Failed to persist log level to database:', err);
    }
  }

  /** Returns the current active file transport log level. */
  getLevel(): LogLevel {
    return this.currentLevel;
  }

  // ── Standard logging methods (delegate to electron-log) ──────────────────
  // Using `any[]` here is intentional — these wrap electron-log's own variadic API.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug(...args: any[]): void {
    log.debug(...args);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info(...args: any[]): void {
    log.info(...args);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn(...args: any[]): void {
    log.warn(...args);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(...args: any[]): void {
    log.error(...args);
  }
}
