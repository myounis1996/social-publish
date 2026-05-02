const fs = require('fs');

/**
 * Universal cookie loader.
 *
 * Accepts any of:
 *   - Cookie header string:  "name=value; name2=value2"
 *   - Playwright / Cookie-Editor array: [{name, value, domain?, ...}, ...]
 *   - Plain object:          {name: value, ...}
 *   - Netscape cookies.txt   (tab-separated, lines starting with '# Netscape ...')
 *   - Buffer of any of the above (decoded as utf-8)
 *   - Path to a file containing any of the above (auto-detected)
 *
 * Returns a small jar object:
 *   {
 *     get(name)        -> string | null
 *     set(name, value) -> void
 *     has(name)        -> boolean
 *     delete(name)     -> void
 *     array()          -> [{name, value}, ...]
 *     object()         -> {name: value, ...}
 *     toString()       -> "name=value; ..."
 *     get jar          -> "name=value; ..."
 *   }
 *
 * Optionally pass {filterDomain: 'tiktok.com'} to keep only cookies whose
 * `domain` field includes that substring (only relevant for array inputs).
 */
function loadCookies(input, options = {}) {
    if (input == null) {
        throw new Error('loadCookies: input is required (string, array, object, Buffer, or file path)');
    }

    let raw = input;

    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');

    if (typeof raw === 'string' && looksLikePath(raw) && fs.existsSync(raw)) {
        raw = fs.readFileSync(raw, 'utf8');
    }

    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { raw = JSON.parse(trimmed); } catch { /* keep as string */ }
        } else if (looksLikeNetscape(trimmed)) {
            raw = parseNetscape(trimmed);
        }
    }

    const map = new Map();

    if (typeof raw === 'string') {
        for (const part of raw.split(/;\s*|\r?\n/)) {
            const idx = part.indexOf('=');
            if (idx <= 0) continue;
            const name = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (name) map.set(name, value);
        }
    } else if (Array.isArray(raw)) {
        for (const c of raw) {
            if (!c || !c.name) continue;
            if (options.filterDomain && c.domain && !String(c.domain).includes(options.filterDomain)) continue;
            map.set(c.name, c.value);
        }
    } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) map.set(k, String(v));
    } else {
        throw new Error('loadCookies: unsupported input format');
    }

    return makeJar(map);
}

function makeJar(map) {
    return {
        get(name) { return map.has(name) ? map.get(name) : null; },
        set(name, value) { map.set(name, String(value)); },
        has(name) { return map.has(name); },
        delete(name) { map.delete(name); },
        array() { return [...map.entries()].map(([name, value]) => ({name, value})); },
        object() { return Object.fromEntries(map.entries()); },
        toString() { return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
        get jar() { return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    };
}

function looksLikePath(s) {
    if (s.length > 1024) return false;
    if (s.includes('\n') || s.includes(';')) return false;
    return /[\\/]/.test(s) || /\.(json|txt|cookies?)$/i.test(s);
}

function looksLikeNetscape(s) {
    return /^# Netscape HTTP Cookie File/m.test(s) || /^[^#\s]+\t(TRUE|FALSE)\t/m.test(s);
}

function parseNetscape(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const f = line.split('\t');
        if (f.length < 7) continue;
        out.push({domain: f[0], name: f[5], value: f[6]});
    }
    return out;
}

/**
 * Throws if any of `names` is missing from the jar. Use to fail fast on
 * platform-required cookies before kicking off a long upload.
 */
function requireCookies(jar, names, platform = 'platform') {
    const missing = names.filter(n => !jar.get(n));
    if (missing.length) {
        throw new Error(
            `Missing required ${platform} cookies: ${missing.join(', ')}. ` +
            `Export them from a logged-in browser session.`
        );
    }
}

module.exports = {loadCookies, requireCookies};
