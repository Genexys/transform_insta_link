"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LINK_TTL_SECONDS = void 0;
exports.r2ConfigFromEnv = r2ConfigFromEnv;
exports.objectUrl = objectUrl;
exports.newObjectKey = newObjectKey;
exports.contentDisposition = contentDisposition;
exports.uploadFile = uploadFile;
exports.presignDownload = presignDownload;
const fs_1 = __importDefault(require("fs"));
const crypto_1 = require("crypto");
const stream_1 = require("stream");
const aws4fetch_1 = require("aws4fetch");
exports.LINK_TTL_SECONDS = 24 * 60 * 60;
const ACCOUNT_ID_REGEX = /^[0-9a-f]{32}$/;
const BUCKET_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
function r2ConfigFromEnv(env = process.env) {
    const accountId = env.R2_ACCOUNT_ID?.trim() ?? '';
    const accessKeyId = env.R2_ACCESS_KEY_ID?.trim() ?? '';
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim() ?? '';
    const bucket = env.R2_BUCKET?.trim() ?? '';
    const values = [accountId, accessKeyId, secretAccessKey, bucket];
    if (values.every(v => !v))
        return null;
    if (values.some(v => !v)) {
        throw new Error('Set all of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET, or none');
    }
    if (!ACCOUNT_ID_REGEX.test(accountId)) {
        throw new Error('R2_ACCOUNT_ID must be the 32-character account id');
    }
    if (!BUCKET_REGEX.test(bucket)) {
        throw new Error('R2_BUCKET is not a valid bucket name');
    }
    const endpoint = (env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
    return { accountId, accessKeyId, secretAccessKey, bucket, endpoint };
}
function client(config) {
    return new aws4fetch_1.AwsClient({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        service: 's3',
        region: 'auto',
        retries: 0,
    });
}
function objectUrl(config, key) {
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${config.endpoint}/${config.bucket}/${path}`;
}
function newObjectKey(now = new Date()) {
    return `videos/${now.toISOString().slice(0, 10)}/${(0, crypto_1.randomUUID)()}.mp4`;
}
function contentDisposition(title) {
    const name = title
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'video';
    const ascii = name.replace(/[^\x20-\x7e]+/g, '_').replace(/["%;\\]/g, '_');
    return `attachment; filename="${ascii}.mp4"; filename*=UTF-8''${encodeURIComponent(`${name}.mp4`)}`;
}
async function uploadFile(config, key, filePath, options = {}) {
    const size = (await fs_1.default.promises.stat(filePath)).size;
    let sent = 0;
    const counter = new stream_1.Transform({
        transform(chunk, _encoding, callback) {
            sent += chunk.length;
            options.onProgress?.(sent, size);
            callback(null, chunk);
        },
    });
    const body = fs_1.default.createReadStream(filePath).pipe(counter);
    const res = await client(config).fetch(objectUrl(config, key), {
        method: 'PUT',
        headers: {
            'Content-Length': String(size),
            'Content-Type': 'video/mp4',
        },
        body: body,
        signal: options.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
        throw new Error(`R2 upload answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return size;
}
async function presignDownload(config, key, title, ttlSeconds = exports.LINK_TTL_SECONDS, now = new Date()) {
    const url = new URL(objectUrl(config, key));
    url.searchParams.set('X-Amz-Expires', String(ttlSeconds));
    url.searchParams.set('response-content-disposition', contentDisposition(title));
    const signed = await client(config).sign(url.toString(), {
        method: 'GET',
        aws: {
            signQuery: true,
            datetime: now.toISOString().replace(/[:-]|\.\d{3}/g, ''),
        },
    });
    return signed.url;
}
