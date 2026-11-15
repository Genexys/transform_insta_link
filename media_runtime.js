"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveFromPath = resolveFromPath;
exports.initMediaRuntime = initMediaRuntime;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ytdlp_nodejs_1 = require("ytdlp-nodejs");
const runtime_1 = require("./runtime");
function resolveFromPath(binary, envPath = process.env.PATH ?? '') {
    for (const dir of envPath.split(path_1.default.delimiter)) {
        if (!dir)
            continue;
        const candidate = path_1.default.join(dir, binary);
        try {
            fs_1.default.accessSync(candidate, fs_1.default.constants.X_OK);
            return candidate;
        }
        catch {
        }
    }
    return null;
}
function hasBinary(binary, versionArg) {
    const result = (0, child_process_1.spawnSync)(binary, [versionArg], { stdio: 'ignore' });
    return !result.error && result.status === 0;
}
function initMediaRuntime() {
    const hasYtDlp = hasBinary('yt-dlp', '--version');
    const hasFfmpeg = hasBinary('ffmpeg', '-version');
    if (!hasYtDlp || !hasFfmpeg) {
        runtime_1.log.warn('Media download disabled: missing runtime binaries', {
            hasYtDlp,
            hasFfmpeg,
        });
        return {
            downloadsEnabled: false,
            ytdlp: null,
        };
    }
    return {
        downloadsEnabled: true,
        ytdlp: new ytdlp_nodejs_1.YtDlp({
            binaryPath: resolveFromPath('yt-dlp') ?? 'yt-dlp',
            ffmpegPath: resolveFromPath('ffmpeg') ?? undefined,
        }),
    };
}
