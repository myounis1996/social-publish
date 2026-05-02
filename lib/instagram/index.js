const fs = require('fs');
const {execSync} = require('child_process');
const {request} = require('../shared/http');
const {loadCookies, requireCookies} = require('../shared/cookies');
const {makeLogger} = require('../shared/logger');

const CHUNK_SIZE = 5 * 1024 * 1024;     // 5 MB — matches IG's web client
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;
const DEFAULT_APP_ID = '936619743392459';
const FALLBACK_AJAX_REV = '1034262494';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function generateSessionId() {
    const r = n => Math.random().toString(36).substring(2, 2 + n);
    return `${r(6)}:${r(6)}:${r(6)}`;
}

function computeJazoest(uploadId) {
    let sum = 0;
    for (const ch of String(uploadId)) sum += ch.charCodeAt(0);
    return `2${sum}`;
}

function getVideoMeta(videoPath, log) {
    try {
        const raw = execSync(
            `ffprobe -v quiet -print_format json -show_streams "${videoPath}"`,
            {stdio: ['pipe', 'pipe', 'pipe']}
        ).toString();
        const data = JSON.parse(raw);
        const vid = data.streams.find(s => s.codec_type === 'video');
        return {
            durationMs: Math.round(parseFloat(vid.duration || 0) * 1000),
            width: parseInt(vid.width, 10) || 1080,
            height: parseInt(vid.height, 10) || 1920,
        };
    } catch {
        log.warn('ffprobe unavailable — using default video metadata (30s, 1080x1920)');
        return {durationMs: 30000, width: 1080, height: 1920};
    }
}

function extractThumbnail(videoPath, durationMs) {
    const tmpThumb = videoPath + '_thumb.jpg';
    const seekSec = ((durationMs / 1000) / 2).toFixed(3);
    try {
        execSync(
            `ffmpeg -y -ss ${seekSec} -i "${videoPath}" -vframes 1 -q:v 2 "${tmpThumb}"`,
            {stdio: ['pipe', 'pipe', 'pipe']}
        );
        const buf = fs.readFileSync(tmpThumb);
        fs.unlinkSync(tmpThumb);
        return buf;
    } catch (err) {
        throw new Error(`ffmpeg thumbnail extraction failed: ${err.message}`);
    }
}

async function scrapeAjaxRevision(cookieStr) {
    try {
        const res = await request({
            url: 'https://www.instagram.com/',
            method: 'GET',
            headers: {
                accept: 'text/html',
                'accept-language': 'en-US,en;q=0.9',
                'user-agent': UA,
                cookie: cookieStr,
            },
        });
        const m = res.body.match(/"server_revision":(\d+)/);
        return m ? m[1] : FALLBACK_AJAX_REV;
    } catch {
        return FALLBACK_AJAX_REV;
    }
}

// ─── Phase 1: query upload offset (initialises the session) ──────────────────

async function queryUploadOffset(ctx) {
    const {uploadUrl, entityName, ruploadParams, cookieStr, appId, ajaxRev, sessionId, log} = ctx;
    log.info('Querying upload offset …');
    const res = await request({
        url: uploadUrl,
        method: 'GET',
        headers: {
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'no-cache',
            'x-entity-type': 'video/mp4',
            'x-entity-name': entityName,
            'x-ig-app-id': appId,
            'x-instagram-ajax': ajaxRev,
            'x-instagram-rupload-params': ruploadParams,
            'x-web-session-id': sessionId,
            cookie: cookieStr,
            referer: 'https://www.instagram.com/',
        },
    });
    if (![200, 201].includes(res.statusCode) || !res.json) {
        throw new Error(`Offset query failed (HTTP ${res.statusCode}): ${res.body}`);
    }
    if (typeof res.json.offset !== 'number') {
        throw new Error(`Unexpected offset response: ${res.body}`);
    }
    log.info(`Server offset: ${res.json.offset}`);
    return res.json.offset;
}

// ─── Phase 2: chunked upload ─────────────────────────────────────────────────

async function postChunk(ctx, chunk, offset, totalSize) {
    const {uploadUrl, entityName, ruploadParams, cookieStr, appId, ajaxRev, sessionId} = ctx;
    const res = await request({
        url: uploadUrl,
        method: 'POST',
        headers: {
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'no-cache',
            'content-type': 'application/octet-stream',
            offset: String(offset),
            'x-entity-length': String(totalSize),
            'x-entity-name': entityName,
            'x-entity-type': 'video/mp4',
            'x-ig-app-id': appId,
            'x-instagram-ajax': ajaxRev,
            'x-instagram-rupload-params': ruploadParams,
            'x-web-session-id': sessionId,
            cookie: cookieStr,
            referer: 'https://www.instagram.com/',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-site',
        },
        body: chunk,
    });
    const partial = res.statusCode === 206;
    const complete = res.statusCode === 200 || res.statusCode === 201;
    if (!partial && !complete) {
        throw new Error(`Chunk upload failed (HTTP ${res.statusCode}): ${res.body}`);
    }
    return {
        nextOffset: res.json?.offset ?? (offset + chunk.length),
        done: complete,
    };
}

async function uploadVideo({videoPath, uploadId, cookieStr, appId, ajaxRev, sessionId, log}) {
    const fileBuffer = fs.readFileSync(videoPath);
    const totalSize = fileBuffer.length;
    const entityName = `fb_uploader_${uploadId}`;
    const uploadUrl = `https://i.instagram.com/rupload_igvideo/${entityName}`;

    const {durationMs, width, height} = getVideoMeta(videoPath, log);

    const ruploadParams = JSON.stringify({
        'client-passthrough': '1',
        is_clips_video: '1',
        is_sidecar: '0',
        media_type: 2,
        for_album: false,
        video_format: '',
        upload_id: uploadId,
        upload_media_duration_ms: durationMs,
        upload_media_height: height,
        upload_media_width: width,
        video_transform: null,
        video_edit_params: {
            crop_width: width,
            crop_height: height,
            crop_x1: 0,
            crop_y1: 0,
            mute: false,
            trim_end: parseFloat((durationMs / 1000).toFixed(6)),
            trim_start: 0,
        },
    });

    log.info(`File: ${videoPath} | size: ${totalSize}B | uploadId: ${uploadId}`);
    log.info(`Video: ${width}x${height} | duration: ${durationMs}ms`);

    const ctx = {uploadUrl, entityName, ruploadParams, cookieStr, appId, ajaxRev, sessionId, log};

    let currentOffset;
    try {
        currentOffset = await queryUploadOffset(ctx);
    } catch (e) {
        log.warn(`Offset query failed, starting from 0: ${e.message}`);
        currentOffset = 0;
    }

    let chunkIndex = 0;
    while (currentOffset < totalSize) {
        const end = Math.min(currentOffset + CHUNK_SIZE, totalSize);
        const chunk = fileBuffer.slice(currentOffset, end);
        const pct = ((currentOffset / totalSize) * 100).toFixed(1);
        log.info(`Chunk #${chunkIndex + 1}: bytes ${currentOffset}–${end - 1} / ${totalSize} (${pct}%)`);

        let attempt = 0;
        let result;
        while (attempt < MAX_RETRIES) {
            try {
                result = await postChunk(ctx, chunk, currentOffset, totalSize);
                break;
            } catch (err) {
                attempt++;
                log.warn(`Chunk #${chunkIndex + 1} attempt ${attempt} failed: ${err.message}`);
                if (attempt >= MAX_RETRIES) throw err;
                try { currentOffset = await queryUploadOffset(ctx); } catch { /* keep offset */ }
                await sleep(RETRY_DELAY_MS * attempt);
            }
        }

        currentOffset = result.nextOffset;
        chunkIndex++;
        if (result.done) {
            log.success('Server signalled upload complete.');
            break;
        }
    }

    log.success(`All ${chunkIndex} chunk(s) uploaded successfully.`);
    return {durationMs, width, height};
}

// ─── Phase 3: cover thumbnail (kicks off transcoding) ────────────────────────

async function uploadThumbnail({videoPath, uploadId, durationMs, width, height, cookieStr, appId, ajaxRev, sessionId, log}) {
    const entityName = `fb_uploader_${uploadId}`;
    const thumbBuffer = extractThumbnail(videoPath, durationMs);
    const thumbSize = thumbBuffer.length;

    const ruploadParams = JSON.stringify({
        media_type: 2,
        upload_id: uploadId,
        upload_media_height: height,
        upload_media_width: width,
    });

    log.info(`Uploading cover frame (${thumbSize} bytes) …`);

    const res = await request({
        url: `https://i.instagram.com/rupload_igphoto/${entityName}`,
        method: 'POST',
        headers: {
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'no-cache',
            'content-type': 'image/jpeg',
            offset: '0',
            'x-entity-length': String(thumbSize),
            'x-entity-name': entityName,
            'x-entity-type': 'image/jpeg',
            'x-ig-app-id': appId,
            'x-instagram-ajax': ajaxRev,
            'x-instagram-rupload-params': ruploadParams,
            'x-web-session-id': sessionId,
            'x-asbd-id': '359341',
            cookie: cookieStr,
            referer: 'https://www.instagram.com/',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-site',
        },
        body: thumbBuffer,
    });

    if (![200, 201].includes(res.statusCode) || !res.json) {
        throw new Error(`Thumbnail upload failed (HTTP ${res.statusCode}): ${res.body}`);
    }
    return res.json;
}

// ─── Phase 4: configure / publish (poll until transcode is done) ─────────────

async function configureClipWithRetry({uploadId, caption, cookies, cookieStr, appId, ajaxRev, sessionId, log, maxRetries}) {
    const RETRY_DELAY = 5000;
    const csrfToken = cookies.get('csrftoken');
    if (!csrfToken) throw new Error('csrftoken cookie not found');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const params = new URLSearchParams({
            archive_only: 'false',
            caption,
            clips_share_preview_to_feed: '1',
            disable_comments: '0',
            disable_oa_reuse: 'false',
            igtv_share_preview_to_feed: '1',
            is_meta_only_post: '0',
            is_unified_video: '1',
            like_and_view_counts_disabled: '0',
            media_share_flow: 'creation_flow',
            share_to_facebook: '',
            share_to_fb_destination_type: 'USER',
            source_type: 'library',
            upload_id: uploadId,
            video_subtitles_enabled: '0',
            jazoest: computeJazoest(uploadId),
        });

        log.info(`Configure attempt ${attempt}/${maxRetries} …`);

        const res = await request({
            url: 'https://www.instagram.com/api/v1/media/configure_to_clips/',
            method: 'POST',
            headers: {
                accept: '*/*',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'no-cache',
                'content-type': 'application/x-www-form-urlencoded',
                pragma: 'no-cache',
                'x-asbd-id': '359341',
                'x-csrftoken': csrfToken,
                'x-ig-app-id': appId,
                'x-ig-www-claim': '0',
                'x-instagram-ajax': ajaxRev,
                'x-requested-with': 'XMLHttpRequest',
                'x-web-session-id': sessionId,
                cookie: cookieStr,
                referer: 'https://www.instagram.com/',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
            },
            body: params.toString(),
        });

        if (res.json?.status === 'ok') return res.json;

        if (res.json?.message?.toLowerCase().includes('transcode')) {
            log.info(`Transcode pending, retrying in ${RETRY_DELAY / 1000}s …`);
            await sleep(RETRY_DELAY);
            continue;
        }
        throw new Error(`Configure failed: ${res.body}`);
    }
    throw new Error(`Gave up after ${maxRetries} configure attempts — transcode never completed`);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Upload + publish a Reel to Instagram via the public web API.
 *
 * Required:
 *   - videoPath          absolute path to an mp4 file (vertical 9:16 recommended)
 *   - cookies            see lib/shared/cookies.js — string, array, object, file, etc.
 *   - caption            Reel caption (string, may include hashtags + mentions)
 *
 * Optional:
 *   - appId              x-ig-app-id (default 936619743392459)
 *   - sessionId          web session id (auto-generated if absent)
 *   - configureRetries   poll attempts while waiting for transcode (default 10)
 *   - logger             true|false|object (see lib/shared/logger.js)
 *
 * Returns: {url, code, mediaId, response}
 */
async function publishReel(opts) {
    const {
        videoPath,
        cookies: cookieInput,
        caption,
        appId = DEFAULT_APP_ID,
        sessionId = generateSessionId(),
        configureRetries = 10,
        logger,
    } = opts;

    if (!videoPath) throw new Error('videoPath is required');
    if (!fs.existsSync(videoPath)) throw new Error(`Video not found: ${videoPath}`);
    if (typeof caption !== 'string') throw new Error('caption is required (string)');

    const log = makeLogger(logger, 'instagram');
    const cookies = loadCookies(cookieInput);
    requireCookies(cookies, ['sessionid', 'csrftoken'], 'Instagram');
    const cookieStr = cookies.toString();

    const ajaxRev = await scrapeAjaxRevision(cookieStr);
    log.info(`ajax revision: ${ajaxRev}`);

    const uploadId = Date.now().toString();

    const {durationMs, width, height} = await uploadVideo({
        videoPath, uploadId, cookieStr, appId, ajaxRev, sessionId, log,
    });

    await uploadThumbnail({
        videoPath, uploadId, durationMs, width, height,
        cookieStr, appId, ajaxRev, sessionId, log,
    });

    await sleep(5000);

    const result = await configureClipWithRetry({
        uploadId, caption, cookies, cookieStr,
        appId, ajaxRev, sessionId, log, maxRetries: configureRetries,
    });

    const code = result?.media?.code || null;
    const url = code ? `https://www.instagram.com/reels/${code}/` : null;
    log.success(`Reel published → ${url || '(URL unavailable)'}`);

    return {url, code, mediaId: result?.media?.id || null, response: result};
}

module.exports = {publishReel};
