const https = require('https');

/**
 * Minimal https.request wrapper. Resolves with { statusCode, headers, body, json }.
 * `body` may be a Buffer, string, or null.
 *
 * Sets content-length explicitly so Node never falls back to chunked
 * transfer-encoding (some upload endpoints reject chunked bodies).
 */
function request({url, method = 'GET', headers = {}, body = null, timeoutMs = 60_000}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const finalHeaders = {...headers};

        if (Buffer.isBuffer(body)) {
            finalHeaders['content-length'] = String(body.length);
        } else if (typeof body === 'string') {
            finalHeaders['content-length'] = String(Buffer.byteLength(body));
        }

        const req = https.request(
            {
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                method,
                headers: finalHeaders,
            },
            res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try { json = JSON.parse(raw); } catch { /* not JSON */ }
                    resolve({statusCode: res.statusCode, headers: res.headers, body: raw, json});
                });
            }
        );

        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
        });

        if (body) req.end(body);
        else req.end();
    });
}

function buildQuery(params) {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

module.exports = {request, buildQuery};
