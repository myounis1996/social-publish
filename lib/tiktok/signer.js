const {spawn} = require('child_process');

/**
 * X-Bogus / _signature generator for the TikTok web /project/post/ endpoint.
 *
 * The publish endpoint requires two reverse-engineered values that depend on the
 * URL + User-Agent. We keep the signer pluggable instead of hard-coding one
 * implementation. Provide one of (in order of preference):
 *
 *   1. opts.signer         — async ({url, userAgent}) => {xBogus, signature, msToken?}
 *   2. opts.signerCommand  — shell command that prints JSON to stdout
 *      `{"x-bogus":"...", "signature":"...", "msToken":"..."}` (also accepts
 *      it wrapped under a `data` key). Receives <url> as $1, <userAgent> as $2.
 *   3. env TIKTOK_SIGNER_CMD — same as signerCommand but read from env.
 *   4. Bundled Playwright signer — falls back to lib/tiktok/signer-default.js,
 *      which spawns headless Chromium and evaluates the obfuscated TikTok JS
 *      bundles in lib/tiktok/vendor/.
 */
async function generateSignature({userAgent, url, signer, signerCommand}) {
    if (typeof signer === 'function') {
        return normalize(await signer({userAgent, url}));
    }

    const cmd = signerCommand || process.env.TIKTOK_SIGNER_CMD;
    if (cmd) return runSubprocessSigner(cmd, url, userAgent);

    const {defaultSign} = require('./signer-default');
    return normalize(await defaultSign({userAgent, url}));
}

function runSubprocessSigner(cmd, url, userAgent) {
    return new Promise((resolve, reject) => {
        const parts = cmd.split(/\s+/);
        const exe = parts[0];
        const args = [...parts.slice(1), url, userAgent];
        const proc = spawn(exe, args, {stdio: ['ignore', 'pipe', 'pipe']});
        const stdout = [], stderr = [];
        proc.stdout.on('data', b => stdout.push(b));
        proc.stderr.on('data', b => stderr.push(b));
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0) {
                return reject(new Error(`Signer exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
            }
            const text = Buffer.concat(stdout).toString('utf8').trim();
            try {
                const parsed = JSON.parse(text);
                resolve(normalize(parsed.data || parsed));
            } catch {
                reject(new Error(`Signer output not valid JSON: ${text.slice(0, 200)}`));
            }
        });
    });
}

function normalize(out) {
    if (!out) throw new Error('Empty signer response');
    const xBogus = out.xBogus || out['x-bogus'] || out.X_Bogus;
    const signature = out.signature || out._signature;
    if (!xBogus || !signature) {
        throw new Error(`Signer response missing x-bogus or signature: ${JSON.stringify(out)}`);
    }
    return {xBogus, signature, msToken: out.msToken || out.ms_token || null};
}

module.exports = {generateSignature};
