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
exports.mainWindow = void 0;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const main_1 = __importDefault(require("electron-log/main"));
const ipc_1 = require("./ipc");
const database_service_1 = require("./services/database-service");
// Configure logging
main_1.default.initialize();
main_1.default.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
main_1.default.transports.file.level = process.env['LOG_LEVEL'] || 'info';
let mainWindow = null;
exports.mainWindow = mainWindow;
// Single instance lock
const gotTheLock = electron_1.app.requestSingleInstanceLock();
if (!gotTheLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.focus();
        }
    });
    electron_1.app.whenReady().then(async () => {
        main_1.default.info('MailClient starting...');
        // Initialize database
        try {
            const dbService = database_service_1.DatabaseService.getInstance();
            await dbService.initialize();
            main_1.default.info('Database initialized successfully');
        }
        catch (err) {
            main_1.default.error('Failed to initialize database:', err);
        }
        // Register IPC handlers
        (0, ipc_1.registerAllIpcHandlers)();
        // Create the main window
        createMainWindow();
    });
}
function createMainWindow() {
    const isWindows = process.platform === 'win32';
    exports.mainWindow = mainWindow = new electron_1.BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        frame: !isWindows, // Frameless on Windows for custom titlebar
        titleBarStyle: isWindows ? undefined : 'hiddenInset', // macOS native titlebar with inset
        show: false,
        icon: path.join(__dirname, '../assets/icons/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
        },
    });
    // Restore window position/size from saved state
    restoreWindowState(mainWindow);
    // Show window when ready
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });
    // Open external links in system browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        electron_1.shell.openExternal(url);
        return { action: 'deny' };
    });
    // Save window state on close
    mainWindow.on('close', () => {
        if (mainWindow) {
            saveWindowState(mainWindow);
        }
    });
    mainWindow.on('closed', () => {
        exports.mainWindow = mainWindow = null;
    });
    // Load the Angular app
    if (process.env['NODE_ENV'] === 'development') {
        mainWindow.loadURL('http://localhost:4200');
        mainWindow.webContents.openDevTools();
    }
    else {
        mainWindow.loadFile(path.join(__dirname, '../dist/mailclient-app/browser/index.html'));
    }
    main_1.default.info('Main window created');
}
function saveWindowState(win) {
    try {
        const bounds = win.getBounds();
        const isMaximized = win.isMaximized();
        const dbService = database_service_1.DatabaseService.getInstance();
        dbService.setSetting('windowState', JSON.stringify({ bounds, isMaximized }));
    }
    catch (err) {
        main_1.default.warn('Failed to save window state:', err);
    }
}
function restoreWindowState(win) {
    try {
        const dbService = database_service_1.DatabaseService.getInstance();
        const stateStr = dbService.getSetting('windowState');
        if (stateStr) {
            const state = JSON.parse(stateStr);
            if (state.bounds) {
                win.setBounds(state.bounds);
            }
            if (state.isMaximized) {
                win.maximize();
            }
        }
    }
    catch (err) {
        main_1.default.warn('Failed to restore window state:', err);
    }
}
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
electron_1.app.on('activate', () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
    }
});
//# sourceMappingURL=main.js.map