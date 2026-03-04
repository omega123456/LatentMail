import { app } from 'electron';
import log from 'electron-log/main';
import fs from 'fs';
import path from 'path';
import { isMacOS } from '../utils/platform';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_RETENTION_DAYS = 7;
const VALID_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Matches daily log filenames: main-YYYY-MM-DD.log */
const DAILY_LOG_PATTERN = /^main-\d{4}-\d{2}-\d{2}\.log$/;

/** Matches electron-log default file format: [YYYY-MM-DD HH:mm:ss.mmm] [level] message */
const LOG_LINE_REGEX = /^\[([^\]]+)\] \[(\w+)\] (.*)$/;

export interface LogEntry {
  date: string;
  level: string;
  message: string;
}

function isValidLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (VALID_LEVELS as readonly string[]).includes(value);
}

/**
 * Singleton wrapper around `electron-log` that centralizes all logging configuration
 * for the main process.
 *
 * File transport uses daily log files (one per calendar day, e.g. main-YYYY-MM-DD.log)
 * and automatically deletes logs older than LOG_RETENTION_DAYS (7) on startup.
 *
 * Two-phase initialization:
 *  - Phase 1 (constructor / first getInstance() call): calls log.initialize(), sets
 *    daily resolvePathFn, disables size-based rotation, runs 7-day cleanup, and applies
 *    the LOG_LEVEL env var (or 'info' as the ultimate fallback). Logging is fully
 *    functional after Phase 1.
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
  private currentLevel: LogLevel = 'info';

  private constructor() {
    // ── Phase 1: early bootstrap ───────────────────────────────────────────
    log.initialize();

    log.transports.file.resolvePathFn = (variables, message) => {
      const date = message?.date ?? new Date();
      const dateStr = date.toISOString().split('T')[0];
      return path.join(variables.libraryDefaultDir, `main-${dateStr}.log`);
    };
    log.transports.file.maxSize = 0; // Daily rotation only; no size-based rotation

    this.cleanupOldLogs();

    log.transports.file.level = this.currentLevel;
    // Console transport is deliberately left at its electron-log default.
  }

  /**
   * Returns the directory where daily log files are written (same rules as electron-log).
   */
  private getLogDir(): string {
    return isMacOS()
      ? path.join(app.getPath('home'), 'Library', 'Logs', app.getName())
      : path.join(app.getPath('userData'), 'logs');
  }

  /**
   * Deletes daily log files older than LOG_RETENTION_DAYS. Uses the same log
   * directory rules as electron-log. Never throws; logs errors and returns.
   */
  private cleanupOldLogs(): void {
    try {
      const logDir = this.getLogDir();

      if (!fs.existsSync(logDir)) {
        return;
      }

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS);
      cutoff.setHours(0, 0, 0, 0);

      const entries = fs.readdirSync(logDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !DAILY_LOG_PATTERN.test(entry.name)) {
          continue;
        }
        const match = entry.name.match(/^main-(\d{4})-(\d{2})-(\d{2})\.log$/);
        if (!match) {
          continue;
        }
        const [, y, m, d] = match;
        const fileDate = new Date(parseInt(y!, 10), parseInt(m!, 10) - 1, parseInt(d!, 10));
        if (fileDate < cutoff) {
          const fullPath = path.join(logDir, entry.name);
          fs.unlinkSync(fullPath);
          log.info(`[LoggerService] Removed old log file: ${entry.name}`);
        }
      }
    } catch (err) {
      log.warn('[LoggerService] Failed to cleanup old log files:', err);
    }
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

  /**
   * Reads the last `limit` log entries from the daily log file(s), newest first.
   * Reads today's file and, if needed, yesterday's to reach the limit.
   * Returns empty array on missing dir/file or parse errors (never throws).
   */
  async getRecentEntries(limit: number): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    try {
      const logDir = this.getLogDir();
      if (!fs.existsSync(logDir)) {
        return [];
      }

      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const readFileLines = (filePath: string): string[] => {
        if (!fs.existsSync(filePath)) {
          return [];
        }
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          return content.split(/\r?\n/);
        } catch {
          return [];
        }
      };

      const todayPath = path.join(logDir, `main-${todayStr}.log`);
      const yesterdayPath = path.join(logDir, `main-${yesterdayStr}.log`);
      let lines = readFileLines(yesterdayPath).concat(readFileLines(todayPath));

      for (const line of lines) {
        const match = line.match(LOG_LINE_REGEX);
        if (match) {
          entries.push({
            date: match[1].trim(),
            level: match[2].toLowerCase(),
            message: match[3] ?? '',
          });
        } else if (entries.length > 0) {
          // Multi-line: stack traces and continuation lines belong to the previous entry
          entries[entries.length - 1].message += '\n' + line;
        }
      }

      const lastN = entries.slice(-limit);
      lastN.reverse();
      return lastN;
    } catch (err) {
      log.warn('[LoggerService] Failed to read recent log entries:', err);
      return [];
    }
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
