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
exports.CredentialService = void 0;
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const main_1 = __importDefault(require("electron-log/main"));
class CredentialService {
    static instance;
    credentialsPath;
    constructor() {
        const userDataPath = electron_1.app.getPath('userData');
        this.credentialsPath = path.join(userDataPath, 'credentials.enc');
    }
    static getInstance() {
        if (!CredentialService.instance) {
            CredentialService.instance = new CredentialService();
        }
        return CredentialService.instance;
    }
    isEncryptionAvailable() {
        return electron_1.safeStorage.isEncryptionAvailable();
    }
    readCredentials() {
        try {
            if (!fs.existsSync(this.credentialsPath)) {
                return {};
            }
            const fileContent = fs.readFileSync(this.credentialsPath);
            if (this.isEncryptionAvailable()) {
                const decrypted = electron_1.safeStorage.decryptString(fileContent);
                return JSON.parse(decrypted);
            }
            else {
                // Fallback to plaintext (with warning)
                main_1.default.warn('safeStorage not available — credentials stored without encryption');
                return JSON.parse(fileContent.toString('utf-8'));
            }
        }
        catch (err) {
            main_1.default.error('Failed to read credentials:', err);
            return {};
        }
    }
    writeCredentials(credentials) {
        try {
            const json = JSON.stringify(credentials);
            if (this.isEncryptionAvailable()) {
                const encrypted = electron_1.safeStorage.encryptString(json);
                fs.writeFileSync(this.credentialsPath, encrypted);
            }
            else {
                main_1.default.warn('safeStorage not available — credentials stored without encryption');
                fs.writeFileSync(this.credentialsPath, json, 'utf-8');
            }
        }
        catch (err) {
            main_1.default.error('Failed to write credentials:', err);
            throw err;
        }
    }
    storeTokens(accountId, accessToken, refreshToken, expiresAt) {
        const credentials = this.readCredentials();
        credentials[accountId] = { accessToken, refreshToken, expiresAt };
        this.writeCredentials(credentials);
        main_1.default.info(`Tokens stored for account ${accountId}`);
    }
    getTokens(accountId) {
        const credentials = this.readCredentials();
        return credentials[accountId] ?? null;
    }
    removeTokens(accountId) {
        const credentials = this.readCredentials();
        delete credentials[accountId];
        this.writeCredentials(credentials);
        main_1.default.info(`Tokens removed for account ${accountId}`);
    }
    hasTokens(accountId) {
        const credentials = this.readCredentials();
        return accountId in credentials;
    }
    clearAll() {
        try {
            if (fs.existsSync(this.credentialsPath)) {
                fs.unlinkSync(this.credentialsPath);
            }
            main_1.default.info('All credentials cleared');
        }
        catch (err) {
            main_1.default.error('Failed to clear credentials:', err);
        }
    }
}
exports.CredentialService = CredentialService;
//# sourceMappingURL=credential-service.js.map