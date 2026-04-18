"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initMediaRuntime = initMediaRuntime;
const child_process_1 = require("child_process");
const ytdlp_nodejs_1 = require("ytdlp-nodejs");
const runtime_1 = require("./runtime");
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
        ytdlp: new ytdlp_nodejs_1.YtDlp({ binaryPath: 'yt-dlp', ffmpegPath: 'ffmpeg' }),
    };
}
