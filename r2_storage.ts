// Cloudflare R2 (S3-compatible) storage for download links, used by the home
// worker only: the R2 keys live in its .env.worker, never on Railway.
//
// The bucket stays private. A video is uploaded under a random key and shared
// through a presigned GET URL that expires; a bucket lifecycle rule deletes the
// objects after a day (docs/youtube-home-worker.md).

import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { Transform } from 'stream';
import { AwsClient } from 'aws4fetch';

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  // Tests point this at a local S3 server; production uses the account's R2
  // endpoint.
  endpoint: string;
};

// How long a link works. R2 deletes the object a day later anyway.
export const LINK_TTL_SECONDS = 24 * 60 * 60;

const ACCOUNT_ID_REGEX = /^[0-9a-f]{32}$/;
// The S3 endpoint Cloudflare shows next to the keys; a bucket created in a
// jurisdiction has its own host (https://<id>.eu.r2.cloudflarestorage.com).
const ENDPOINT_REGEX =
  /^https:\/\/([0-9a-f]{32})\.((?:eu|fedramp)\.)?r2\.cloudflarestorage\.com\/?$/;
const BUCKET_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// All of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET,
// or null (download links off). R2_ACCOUNT_ID takes the 32-character id or the
// whole S3 endpoint URL (needed for an EU-jurisdiction bucket). Throws on a
// partial or malformed set, so a typo fails the worker at start instead of
// every link later.
export function r2ConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): R2Config | null {
  const accountInput = env.R2_ACCOUNT_ID?.trim() ?? '';
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim() ?? '';
  const secretInput = env.R2_SECRET_ACCESS_KEY?.trim() ?? '';
  const bucket = env.R2_BUCKET?.trim() ?? '';
  const values = [accountInput, accessKeyId, secretInput, bucket];
  if (values.every(v => !v)) return null;
  if (values.some(v => !v)) {
    throw new Error(
      'Set all of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET, or none'
    );
  }
  const fromEndpoint = ENDPOINT_REGEX.exec(accountInput);
  const accountId = fromEndpoint ? fromEndpoint[1] : accountInput;
  if (!ACCOUNT_ID_REGEX.test(accountId)) {
    throw new Error(
      'R2_ACCOUNT_ID must be the 32-character account id or the https://<id>.r2.cloudflarestorage.com endpoint'
    );
  }
  if (!BUCKET_REGEX.test(bucket)) {
    throw new Error('R2_BUCKET is not a valid bucket name');
  }
  const secretAccessKey = r2SecretAccessKey(secretInput);
  const endpoint = (
    env.R2_ENDPOINT?.trim() ||
    (fromEndpoint
      ? `https://${accountId}.${fromEndpoint[2] ?? ''}r2.cloudflarestorage.com`
      : `https://${accountId}.r2.cloudflarestorage.com`)
  ).replace(/\/+$/, '');
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint };
}

// R2's S3 secret is the SHA-256 (hex) of the API token value
// (developers.cloudflare.com/r2/api/tokens). Take the 64-hex secret as is, and
// derive it when the token value was pasted instead.
export function r2SecretAccessKey(value: string): string {
  return /^[0-9a-f]{64}$/.test(value)
    ? value
    : createHash('sha256').update(value).digest('hex');
}

function client(config: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
    // aws4fetch retries 10 times by default, which cannot work with a
    // streamed body; a failed upload is reported and the user can retry.
    retries: 0,
  });
}

export function objectUrl(config: R2Config, key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${config.endpoint}/${config.bucket}/${path}`;
}

// A random, unguessable key per video; the date prefix only helps browsing
// the bucket.
export function newObjectKey(now: Date = new Date()): string {
  return `videos/${now.toISOString().slice(0, 10)}/${randomUUID()}.mp4`;
}

// The file name the browser saves: the video title, reduced to characters
// every OS accepts, plus an ASCII fallback for old clients.
export function contentDisposition(title: string): string {
  const name =
    title
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video';
  const ascii = name.replace(/[^\x20-\x7e]+/g, '_').replace(/["%;\\]/g, '_');
  return `attachment; filename="${ascii}.mp4"; filename*=UTF-8''${encodeURIComponent(`${name}.mp4`)}`;
}

// Checks the keys and the bucket at worker start by listing one object: 200
// when both work; otherwise R2's error code (NoSuchBucket for a bucket in
// another jurisdiction, AccessDenied, SignatureDoesNotMatch …) in the error.
export async function checkAccess(config: R2Config): Promise<void> {
  const url = `${config.endpoint}/${config.bucket}?list-type=2&max-keys=1`;
  const res = await client(config).fetch(url, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text().catch(() => '');
  if (res.status !== 200) {
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? 'no error code';
    throw new Error(
      `R2 answered HTTP ${res.status} (${code}) for bucket ${config.bucket} at ${new URL(config.endpoint).host.replace(/^[0-9a-f]{32}/, '<account>')}`
    );
  }
}

// Streams the file to R2 with a single PUT (R2 takes up to 5 GiB that way).
export async function uploadFile(
  config: R2Config,
  key: string,
  filePath: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (sentBytes: number, totalBytes: number) => void;
  } = {}
): Promise<number> {
  const size = (await fs.promises.stat(filePath)).size;
  let sent = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sent += chunk.length;
      options.onProgress?.(sent, size);
      callback(null, chunk);
    },
  });
  const body = fs.createReadStream(filePath).pipe(counter);
  const res = await client(config).fetch(objectUrl(config, key), {
    method: 'PUT',
    headers: {
      'Content-Length': String(size),
      'Content-Type': 'video/mp4',
    },
    body: body as unknown as RequestInit['body'],
    signal: options.signal,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(
      `R2 upload answered HTTP ${res.status}: ${text.slice(0, 300)}`
    );
  }
  return size;
}

// A GET URL for the object that works for `ttlSeconds` and makes the browser
// save it under the video's title.
export async function presignDownload(
  config: R2Config,
  key: string,
  title: string,
  ttlSeconds: number = LINK_TTL_SECONDS,
  now: Date = new Date()
): Promise<string> {
  const url = new URL(objectUrl(config, key));
  url.searchParams.set('X-Amz-Expires', String(ttlSeconds));
  url.searchParams.set(
    'response-content-disposition',
    contentDisposition(title)
  );
  const signed = await client(config).sign(url.toString(), {
    method: 'GET',
    aws: {
      signQuery: true,
      datetime: now.toISOString().replace(/[:-]|\.\d{3}/g, ''),
    },
  });
  return signed.url;
}
