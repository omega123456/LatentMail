"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAllIpcHandlers = registerAllIpcHandlers;
const main_1 = __importDefault(require("electron-log/main"));
const system_ipc_1 = require("./system-ipc");
const db_ipc_1 = require("./db-ipc");
const mail_ipc_1 = require("./mail-ipc");
const auth_ipc_1 = require("./auth-ipc");
const ai_ipc_1 = require("./ai-ipc");
function registerAllIpcHandlers() {
    main_1.default.info('Registering IPC handlers...');
    (0, system_ipc_1.registerSystemIpcHandlers)();
    (0, db_ipc_1.registerDbIpcHandlers)();
    (0, mail_ipc_1.registerMailIpcHandlers)();
    (0, auth_ipc_1.registerAuthIpcHandlers)();
    (0, ai_ipc_1.registerAiIpcHandlers)();
    main_1.default.info('All IPC handlers registered');
}
//# sourceMappingURL=index.js.map