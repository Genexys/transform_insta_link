"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDbSsl = resolveDbSsl;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function hostOf(connectionString) {
    try {
        return new URL(connectionString).hostname.toLowerCase();
    }
    catch {
        return null;
    }
}
function resolveDbSsl(connectionString, mode = process.env.DATABASE_SSL) {
    const normalized = mode?.trim().toLowerCase();
    if (normalized === 'disable' || normalized === 'false' || normalized === 'off') {
        return false;
    }
    if (normalized === 'verify' || normalized === 'verify-full') {
        return { rejectUnauthorized: true };
    }
    if (normalized === 'require' || normalized === 'true' || normalized === 'on') {
        return { rejectUnauthorized: false };
    }
    const host = connectionString ? hostOf(connectionString) : null;
    if (host && LOCAL_HOSTS.has(host)) {
        return false;
    }
    return { rejectUnauthorized: false };
}
