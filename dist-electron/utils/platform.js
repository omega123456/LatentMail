"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isWindows = isWindows;
exports.isMacOS = isMacOS;
exports.isLinux = isLinux;
function isWindows() {
    return process.platform === 'win32';
}
function isMacOS() {
    return process.platform === 'darwin';
}
function isLinux() {
    return process.platform === 'linux';
}
//# sourceMappingURL=platform.js.map