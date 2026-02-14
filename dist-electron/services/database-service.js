"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseService = void 0;
const sql_js_1 = __importDefault(require("sql.js"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const electron_1 = require("electron");
const main_1 = __importDefault(require("electron-log/main"));
const schema_1 = require("../database/schema");
class DatabaseService {
    static instance;
    db = null;
    dbPath = '';
    saveTimer = null;
    constructor() { }
    static getInstance() {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }
    getDbPath() {
        if (process.env['DATABASE_PATH']) {
            return process.env['DATABASE_PATH'];
        }
        const userDataPath = electron_1.app.getPath('userData');
        return path.join(userDataPath, 'mailclient.db');
    }
    async initialize() {
        this.dbPath = this.getDbPath();
        main_1.default.info(`Initializing database at: ${this.dbPath}`);
        // Ensure directory exists
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // Initialize sql.js with the WASM binary from node_modules
        const wasmPath = path.join(electron_1.app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
        const SQL = await (0, sql_js_1.default)({
            locateFile: () => wasmPath,
        });
        // Load existing database or create new one
        if (fs.existsSync(this.dbPath)) {
            const fileBuffer = fs.readFileSync(this.dbPath);
            this.db = new SQL.Database(fileBuffer);
            main_1.default.info('Loaded existing database');
        }
        else {
            this.db = new SQL.Database();
            main_1.default.info('Created new database');
        }
        // Enable foreign keys
        this.db.run('PRAGMA foreign_keys = ON');
        // Run schema creation
        this.db.run(schema_1.CREATE_TABLES_SQL);
        // Check and run migrations
        this.runMigrations();
        // Save to disk
        this.saveToDisk();
        main_1.default.info('Database schema initialized');
    }
    runMigrations() {
        if (!this.db)
            throw new Error('Database not initialized');
        const result = this.db.exec('SELECT version FROM schema_version LIMIT 1');
        const versionRow = result.length > 0 && result[0].values.length > 0
            ? { version: result[0].values[0][0] }
            : undefined;
        if (!versionRow) {
            this.db.run('INSERT INTO schema_version (version) VALUES (?)', [schema_1.SCHEMA_VERSION]);
            main_1.default.info(`Database schema version set to ${schema_1.SCHEMA_VERSION}`);
        }
        else if (versionRow.version < schema_1.SCHEMA_VERSION) {
            main_1.default.info(`Migrating database from version ${versionRow.version} to ${schema_1.SCHEMA_VERSION}`);
            this.db.run('UPDATE schema_version SET version = ?', [schema_1.SCHEMA_VERSION]);
        }
    }
    /** Persist the in-memory database to disk */
    saveToDisk() {
        if (!this.db)
            return;
        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
        }
        catch (err) {
            main_1.default.error('Failed to save database to disk:', err);
        }
    }
    /** Schedule a debounced save (avoids writing on every single mutation) */
    scheduleSave() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveToDisk(), 1000);
    }
    getDatabase() {
        if (!this.db)
            throw new Error('Database not initialized');
        return this.db;
    }
    // Settings operations
    getSetting(key) {
        if (!this.db)
            throw new Error('Database not initialized');
        const result = this.db.exec('SELECT value FROM settings WHERE key = ?', [key]);
        if (result.length > 0 && result[0].values.length > 0) {
            return result[0].values[0][0];
        }
        return null;
    }
    setSetting(key, value, scope = 'global') {
        if (!this.db)
            throw new Error('Database not initialized');
        this.db.run('INSERT INTO settings (key, value, scope) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value, scope]);
        this.scheduleSave();
    }
    getAllSettings() {
        if (!this.db)
            throw new Error('Database not initialized');
        const result = this.db.exec('SELECT key, value FROM settings');
        const settings = {};
        if (result.length > 0) {
            for (const row of result[0].values) {
                settings[row[0]] = row[1];
            }
        }
        return settings;
    }
    // Account operations
    getAccounts() {
        if (!this.db)
            throw new Error('Database not initialized');
        const result = this.db.exec('SELECT id, email, display_name, avatar_url, is_active FROM accounts WHERE is_active = 1');
        if (result.length === 0)
            return [];
        return result[0].values.map((row) => ({
            id: row[0],
            email: row[1],
            display_name: row[2],
            avatar_url: row[3],
            is_active: row[4],
        }));
    }
    close() {
        if (this.db) {
            if (this.saveTimer) {
                clearTimeout(this.saveTimer);
                this.saveTimer = null;
            }
            this.saveToDisk();
            this.db.close();
            this.db = null;
            main_1.default.info('Database closed');
        }
    }
}
exports.DatabaseService = DatabaseService;
//# sourceMappingURL=database-service.js.map