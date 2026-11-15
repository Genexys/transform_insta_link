import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { YtDlp } from 'ytdlp-nodejs';
import { log } from './runtime';

// ytdlp-nodejs takes file paths: a bare "ffmpeg" becomes
// `--ffmpeg-location ffmpeg`, which yt-dlp treats as a missing file and then
// runs without ffmpeg (no audio+video merge). Resolve real paths from PATH.
export function resolveFromPath(
  binary: string,
  envPath: string = process.env.PATH ?? ''
): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

// Absolute yt-dlp and ffmpeg paths, or null when either is missing.
export function ytDlpBinaries(): { ytDlp: string; ffmpeg: string } | null {
  const ytDlp = resolveFromPath('yt-dlp');
  const ffmpeg = resolveFromPath('ffmpeg');
  return ytDlp && ffmpeg ? { ytDlp, ffmpeg } : null;
}

function hasBinary(binary: string, versionArg: string): boolean {
  const result = spawnSync(binary, [versionArg], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function initMediaRuntime(): {
  downloadsEnabled: boolean;
  ytdlp: YtDlp | null;
} {
  const hasYtDlp = hasBinary('yt-dlp', '--version');
  const hasFfmpeg = hasBinary('ffmpeg', '-version');

  if (!hasYtDlp || !hasFfmpeg) {
    log.warn('Media download disabled: missing runtime binaries', {
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
    ytdlp: new YtDlp({
      binaryPath: resolveFromPath('yt-dlp') ?? 'yt-dlp',
      ffmpegPath: resolveFromPath('ffmpeg') ?? undefined,
    }),
  };
}
