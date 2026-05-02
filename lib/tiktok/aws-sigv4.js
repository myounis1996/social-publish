const crypto = require('crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

function amzDates(now = new Date()) {
    const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    return {amzDate: iso, dateStamp: iso.slice(0, 8)};
}

// AWS-strict RFC 3986 — encodeURIComponent leaves !'()* untouched.
function awsUriEncode(s) {
    return encodeURIComponent(String(s)).replace(
        /[!'()*]/g,
        c => '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );
}

const byteSort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function canonicalQuery(searchParams) {
    const entries = [];
    for (const [k, v] of searchParams) entries.push([awsUriEncode(k), awsUriEncode(v)]);
    entries.sort((a, b) => byteSort(a[0], b[0]) || byteSort(a[1], b[1]));
    return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * AWS SigV4 signer for the TikTok VOD Top API.
 * Only host + x-amz-* headers are signed; signing application headers (Cookie)
 * causes verification failures due to client/server normalization differences.
 */
function signRequest({method, url, body = '', credentials, service, region, debug = false}) {
    const u = new URL(url);
    const {amzDate, dateStamp} = amzDates();
    const payloadHash = sha256Hex(body || '');

    const allHeaders = {
        host: u.hostname,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
    };
    if (credentials.sessionToken) allHeaders['x-amz-security-token'] = credentials.sessionToken;

    const sortedHeaderNames = Object.keys(allHeaders).sort(byteSort);
    const canonicalHeaders =
        sortedHeaderNames.map(n => `${n}:${String(allHeaders[n]).trim()}`).join('\n') + '\n';
    const signedHeaders = sortedHeaderNames.join(';');

    const canonicalRequest = [
        method.toUpperCase(),
        u.pathname || '/',
        canonicalQuery(u.searchParams),
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        ALGORITHM,
        amzDate,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    if (debug) {
        process.stderr.write(
            `── SigV4 debug ──\n${canonicalRequest}\n` +
            `── string to sign ──\n${stringToSign}\n` +
            `── signature ──\n${signature}\n─────────────────\n`
        );
    }

    return {
        ...allHeaders,
        authorization:
            `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
}

module.exports = {signRequest};
