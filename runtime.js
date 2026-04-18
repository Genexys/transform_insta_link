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
exports.log = void 0;
exports.requireEnv = requireEnv;
const dotenv_1 = __importDefault(require("dotenv"));
const Sentry = __importStar(require("@sentry/node"));
dotenv_1.default.config();
Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.2,
});
function requireEnv(name) {
    const value = process.env[name]?.trim();
    if (value) {
        return value;
    }
    console.error(JSON.stringify({
        level: 'fatal',
        msg: `Missing required env var: ${name}`,
        ts: new Date().toISOString(),
    }));
    process.exit(1);
}
exports.log = {
    info: (msg, meta) => console.log(JSON.stringify({
        level: 'info',
        msg,
        ...meta,
        ts: new Date().toISOString(),
    })),
    warn: (msg, meta) => console.warn(JSON.stringify({
        level: 'warn',
        msg,
        ...meta,
        ts: new Date().toISOString(),
    })),
    error: (msg, meta) => {
        console.error(JSON.stringify({
            level: 'error',
            msg,
            ...meta,
            ts: new Date().toISOString(),
        }));
        Sentry.captureException(meta?.hasOwnProperty('err') ? meta.err : new Error(msg), {
            extra: meta,
        });
    },
};
