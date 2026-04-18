import { spawnSync } from 'child_process';
import { YtDlp } from 'ytdlp-nodejs';
import { log } from './runtime';

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
    ytdlp: new YtDlp({ binaryPath: 'yt-dlp', ffmpegPath: 'ffmpeg' }),
  };
}
