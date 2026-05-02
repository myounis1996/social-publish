const fs = require('fs');
const crypto = require('crypto');
const {request, buildQuery} = require('../shared/http');
const {loadCookies, requireCookies} = require('../shared/cookies');
const {makeLogger} = require('../shared/logger');
const {signRequest} = require('./aws-sigv4');
const {generateSignature} = require('./signer');

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const AID = 1988;
const APP_NAME = 'tiktok_web';
const CHUNK_SIZE = 5 * 1024 * 1024;
const TT_BASE = 'https://www.tiktok.com';

/**
 * Pure-HTTP TikTok publish.
 *
 * Required:
 *   - videoPath        absolute path to a video file (mp4)
 *   - description      caption with optional #tags / @mentions (≤ 2200 chars)
 *   - cookies          see lib/shared/cookies.js — string, array, object, file, etc.
 *
 * Optional:
 *   - userAgent
 *   - scheduleSeconds  900..864000 (offset from now); 0 = post immediately
 *   - allowComment / allowDuet / allowStitch (0|1, default 1)
 *   - visibilityType   0 = public, 1 = private (default 0)
 *   - verifyHashtags   resolve canonical name via challenge/sug (default true)
 *   - signer / signerCommand   pluggable X-Bogus signer (see lib/tiktok/signer.js)
 *   - logger           true|false|object
 *   - debug            dump SigV4 canonical request to stderr
 *
 * Returns: {success, videoId, creationId, projectId, scheduledFor, response}
 */
async function publishVideo(opts) {
    const {
        videoPath,
        description,
        cookies: cookieInput,
        userAgent = DEFAULT_USER_AGENT,
        scheduleSeconds = 0,
        allowComment = 1,
        allowDuet = 1,
        allowStitch = 1,
        visibilityType = 0,
        signer,
        signerCommand,
        logger,
        debug = false,
        verifyHashtags = true,
    } = opts;

    if (!videoPath || !fs.existsSync(videoPath)) {
        throw new Error(`videoPath not found: ${videoPath}`);
    }
    if (typeof description !== 'string') throw new Error('description is required');
    if (description.length > 2200) throw new Error('description must be ≤ 2200 chars');
    if (scheduleSeconds && (scheduleSeconds < 900 || scheduleSeconds > 864_000)) {
        throw new Error('scheduleSeconds must be between 900 and 864000');
    }
    if (scheduleSeconds && visibilityType === 1) {
        throw new Error('Private videos cannot be scheduled');
    }

    const log = makeLogger(logger, 'tiktok');
    const cookies = loadCookies(cookieInput, {filterDomain: 'tiktok.com'});
    requireCookies(cookies, ['sessionid', 'tt-target-idc'], 'TikTok');

    const dcId = cookies.get('tt-target-idc') || 'useast2a';
    log.info(`datacenter=${dcId}`);

    const baseHeaders = {
        'user-agent': userAgent,
        'accept': 'application/json, text/plain, */*',
        'cookie': cookies.jar,
    };

    // ── 1. Create draft project ──
    const creationId = randomString(21, true);
    const projectUrl =
        `${TT_BASE}/api/v1/web/project/create/?` +
        buildQuery({creation_id: creationId, type: 1, aid: AID});
    const projectRes = await request({url: projectUrl, method: 'POST', headers: baseHeaders});
    assertOk('project/create', projectRes);
    const projectId = projectRes.json?.project?.project_id;
    if (!projectId) throw new Error(`project/create returned no project_id: ${projectRes.body}`);
    log.info(`project_id=${projectId} creation_id=${creationId}`);

    // ── 2. Get ephemeral AWS upload credentials ──
    const authRes = await request({
        url: `${TT_BASE}/api/v1/video/upload/auth/?aid=${AID}`,
        method: 'GET',
        headers: baseHeaders,
    });
    assertOk('upload/auth', authRes);
    const tok = authRes.json?.video_token_v5;
    if (!tok) throw new Error(`upload/auth returned no video_token_v5: ${authRes.body}`);

    // TikTok mis-spells secret_access_key; tolerate both.
    const awsCreds = {
        accessKeyId: tok.access_key_id,
        secretAccessKey: tok.secret_acess_key || tok.secret_access_key,
        sessionToken: tok.session_token,
    };

    // ── 3. ApplyUploadInner (signed) ──
    const videoBytes = fs.readFileSync(videoPath);
    const fileSize = videoBytes.length;

    const applyUrl = `${TT_BASE}/top/v1?` + buildQuery({
        Action: 'ApplyUploadInner',
        Version: '2020-11-19',
        SpaceName: 'tiktok',
        FileType: 'video',
        IsInner: 1,
        FileSize: fileSize,
        s: 'g158iqx8434',
    });
    const applySig = signRequest({
        method: 'GET', url: applyUrl, body: '',
        credentials: awsCreds, service: 'vod', region: 'ap-singapore-1', debug,
    });
    const applyRes = await request({
        url: applyUrl, method: 'GET',
        headers: {...baseHeaders, ...applySig},
    });
    assertOk('ApplyUploadInner', applyRes);
    const node = applyRes.json?.Result?.InnerUploadAddress?.UploadNodes?.[0];
    if (!node) throw new Error(`ApplyUploadInner returned no UploadNodes: ${applyRes.body}`);

    const videoId = node.Vid;
    const storeUri = node.StoreInfos[0].StoreUri;
    const videoAuth = node.StoreInfos[0].Auth;
    const uploadHost = node.UploadHost;
    const sessionKey = node.SessionKey;
    log.info(`video_id=${videoId} chunks=${Math.ceil(fileSize / CHUNK_SIZE)}`);

    // ── 4. Chunked upload of video bytes ──
    const uploadId = crypto.randomUUID();
    const crcs = [];
    for (let i = 0, part = 1; i < fileSize; i += CHUNK_SIZE, part++) {
        const chunk = videoBytes.subarray(i, Math.min(i + CHUNK_SIZE, fileSize));
        const crc = crc32Hex(chunk);
        crcs.push(crc);

        const chunkUrl =
            `https://${uploadHost}/${storeUri}?` +
            buildQuery({partNumber: part, uploadID: uploadId, phase: 'transfer'});

        const chunkRes = await request({
            url: chunkUrl, method: 'POST',
            headers: {
                'authorization': videoAuth,
                'content-type': 'application/octet-stream',
                'content-disposition': 'attachment; filename="undefined"',
                'content-crc32': crc,
                'user-agent': userAgent,
            },
            body: chunk,
        });
        if (chunkRes.statusCode !== 200) {
            throw new Error(
                `Chunk ${part} upload failed: HTTP ${chunkRes.statusCode} — ${chunkRes.body.slice(0, 300)}`
            );
        }
        log.info(`chunk ${part}/${crcs.length}+ uploaded (${chunk.length}B, crc=${crc})`);
    }

    // ── 5. Finish chunked upload ──
    const finishUrl = `https://${uploadHost}/${storeUri}?` +
        buildQuery({uploadID: uploadId, phase: 'finish', uploadmode: 'part'});
    const finishBody = crcs.map((c, i) => `${i + 1}:${c}`).join(',');
    const finishRes = await request({
        url: finishUrl, method: 'POST',
        headers: {
            'authorization': videoAuth,
            'content-type': 'text/plain;charset=UTF-8',
            'user-agent': userAgent,
        },
        body: finishBody,
    });
    assertOk('upload/finish', finishRes);

    // ── 6. CommitUploadInner (signed) ──
    const commitUrl = `${TT_BASE}/top/v1?` +
        buildQuery({Action: 'CommitUploadInner', Version: '2020-11-19', SpaceName: 'tiktok'});
    const commitBody = JSON.stringify({SessionKey: sessionKey, Functions: [{name: 'GetMeta'}]});
    const commitSig = signRequest({
        method: 'POST', url: commitUrl, body: commitBody,
        credentials: awsCreds, service: 'vod', region: 'ap-singapore-1', debug,
    });
    const commitRes = await request({
        url: commitUrl, method: 'POST',
        headers: {...baseHeaders, ...commitSig, 'content-type': 'application/json'},
        body: commitBody,
    });
    assertOk('CommitUploadInner', commitRes);

    // ── 7. Publish ──
    const msToken = cookies.get('msToken') || '';
    const sigUrl = `${TT_BASE}/api/v1/web/project/post/?` + buildQuery({
        app_name: APP_NAME, channel: APP_NAME, device_platform: 'web', aid: AID, msToken,
    });
    const sig = await generateSignature({userAgent, url: sigUrl, signer, signerCommand});

    const postParams = {
        app_name: APP_NAME,
        channel: APP_NAME,
        device_platform: 'web',
        aid: AID,
        msToken,
        'X-Bogus': sig.xBogus,
        _signature: sig.signature,
    };

    const caption = await buildCaptionPayload({
        text: description, cookies, userAgent, verifyHashtags, log,
    });

    const featureCommon = {
        geofencing_regions: [],
        playlist_name: '',
        playlist_id: '',
        tcm_params: '{"commerce_toggle_info":{}}',
        sound_exemption: 0,
        anchors: [],
        vedit_common_info: {draft: '', video_id: videoId},
        privacy_setting_info: {
            visibility_type: visibilityType,
            allow_duet: allowDuet,
            allow_stitch: allowStitch,
            allow_comment: allowComment,
        },
    };
    if (scheduleSeconds > 0) {
        featureCommon.schedule_time = scheduleSeconds + Math.floor(Date.now() / 1000);
    }

    const publishBody = JSON.stringify({
        post_common_info: {creation_id: creationId, enter_post_page_from: 1, post_type: 3},
        feature_common_info_list: [featureCommon],
        single_post_req_list: [{
            batch_index: 0,
            video_id: videoId,
            is_long_video: 0,
            single_post_feature_info: {
                text: caption.text,
                text_extra: caption.textExtra,
                // <h id="N">#tag</h> + <br> for newlines is what makes
                // hashtags clickable on TikTok.
                markup_text: caption.markupText.replace(/\n/g, '<br>'),
                music_info: {},
                poster_delay: 0,
            },
        }],
    });

    const publishUrl = `${TT_BASE}/tiktok/web/project/post/v1/?` + buildQuery(postParams);
    const publishRes = await request({
        url: publishUrl, method: 'POST',
        headers: {...baseHeaders, 'content-type': 'application/json'},
        body: publishBody,
    });
    assertOk('project/post', publishRes);

    if (publishRes.json?.status_code !== 0) {
        throw new Error(`Publish rejected: ${publishRes.body}`);
    }

    log.success(`Published TikTok video_id=${videoId}`);
    return {
        success: true,
        videoId,
        creationId,
        projectId,
        scheduledFor: scheduleSeconds ? scheduleSeconds + Math.floor(Date.now() / 1000) : null,
        response: publishRes.json,
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomString(length, allowUnderscore) {
    const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
        (allowUnderscore ? '_' : '');
    const buf = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[buf[i] % alphabet.length];
    return out;
}

const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
    }
    return t;
})();

function crc32Hex(buffer) {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) {
        c = (c >>> 8) ^ CRC32_TABLE[(c ^ buffer[i]) & 0xff];
    }
    return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function assertOk(label, res) {
    if (res.statusCode !== 200) {
        throw new Error(`${label} failed: HTTP ${res.statusCode} — ${res.body.slice(0, 500)}`);
    }
}

// JS \w is ASCII-only even under /u — use Unicode property classes for
// Arabic/CJK/etc. hashtags.
const CAPTION_PATTERN = /#([\p{L}\p{N}_]+)|@([A-Za-z0-9._-]+)|([^#@]+)/gu;

function tokenizeCaption(text) {
    const tokens = [];
    let m;
    while ((m = CAPTION_PATTERN.exec(text)) !== null) {
        if (m[1]) tokens.push({kind: 'tag', name: m[1]});
        else if (m[2]) tokens.push({kind: 'mention', name: m[2]});
        else tokens.push({kind: 'text', value: m[3]});
    }
    return tokens;
}

async function lookupHashtag(name, cookies, userAgent) {
    const url = `${TT_BASE}/api/upload/challenge/sug/?keyword=${encodeURIComponent(name)}`;
    try {
        const res = await request({
            url, method: 'GET',
            headers: {
                'user-agent': userAgent,
                'accept': 'application/json, text/plain, */*',
                'cookie': cookies.jar,
            },
        });
        if (res.statusCode !== 200) return null;
        const sug = res.json?.sug_list?.[0];
        if (!sug) return null;
        return {cid: sug.cid || sug.cha_id || '', name: sug.cha_name || sug.text || name};
    } catch {
        return null;
    }
}

async function buildCaptionPayload({text, cookies, userAgent, verifyHashtags, log}) {
    const tokens = tokenizeCaption(text);
    const textExtra = [];
    let cursor = 0, markup = '', id = 0, outText = '';

    for (const tok of tokens) {
        if (tok.kind === 'tag') {
            let name = tok.name;
            if (verifyHashtags) {
                const looked = await lookupHashtag(name, cookies, userAgent);
                if (looked) {
                    if (looked.name) name = looked.name;
                    log.info(`tag #${name} → cid=${looked.cid || 'n/a'}`);
                } else {
                    log.info(`tag #${name} → not found, using as-is`);
                }
            }
            const visible = '#' + name;
            outText += visible;
            const start = cursor, end = cursor + visible.length;
            textExtra.push({start, end, type: 1, hashtag_name: name, user_id: '', tag_id: String(id)});
            markup += `<h id="${id}">${visible}</h>`;
            cursor = end;
            id++;
        } else if (tok.kind === 'mention') {
            const visible = '@' + tok.name;
            outText += visible;
            const start = cursor, end = cursor + visible.length;
            textExtra.push({start, end, type: 0, hashtag_name: '', user_id: '', tag_id: String(id)});
            markup += `<m id="${id}">${visible}</m>`;
            cursor = end;
            id++;
        } else {
            outText += tok.value;
            markup += tok.value;
            cursor += tok.value.length;
        }
    }
    return {text: outText, markupText: markup, textExtra};
}

module.exports = {publishVideo};
