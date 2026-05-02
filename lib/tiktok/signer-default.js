/**
 * Default TikTok signer.
 *
 * Launches headless Chromium via playwright-core (system Chrome) and evaluates
 * the three reverse-engineered TikTok JS bundles in ./vendor/ to compute the
 * X-Bogus + _signature pair required by /project/post/.
 *
 * Requires `playwright-core` to be installed and a system Chrome present. If
 * you don't want this dependency, pass `opts.signer` or `opts.signerCommand`.
 */
const path = require('path');

const SCRIPT_DIR = path.join(__dirname, 'vendor');
const SCRIPTS = ['signer.js', 'webmssdk.js', 'xbogus.js'];
const NAVIGATE_URL = 'https://www.tiktok.com/@rihanna?lang=en';

let chromiumImpl = null;
function loadChromium() {
    if (chromiumImpl) return chromiumImpl;
    try {
        chromiumImpl = require('playwright-core').chromium;
    } catch {
        throw new Error(
            'playwright-core is required for the default TikTok signer. ' +
            'Install it (`npm i playwright-core`) or pass opts.signer / opts.signerCommand.'
        );
    }
    return chromiumImpl;
}

async function defaultSign({userAgent, url}) {
    const chromium = loadChromium();
    const browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
    });

    try {
        const context = await browser.newContext({
            bypassCSP: true,
            userAgent,
            ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();

        await page.route('**/*', route => {
            const t = route.request().resourceType();
            return t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet'
                ? route.abort()
                : route.continue();
        });

        await page.goto(NAVIGATE_URL, {waitUntil: 'domcontentloaded', timeout: 30_000});
        for (const name of SCRIPTS) await page.addScriptTag({path: path.join(SCRIPT_DIR, name)});

        const result = await page.evaluate(
            ([targetUrl, ua]) => {
                if (typeof window.byted_acrawler?.sign !== 'function') {
                    throw new Error('byted_acrawler.sign not found after script injection');
                }
                if (typeof window.generateBogus !== 'function') {
                    throw new Error('generateBogus not found after script injection');
                }
                const signature = window.byted_acrawler.sign({url: targetUrl});
                const signedUrl = targetUrl + '&_signature=' + signature;
                const queryString = new URL(signedUrl).searchParams.toString();
                const bogus = window.generateBogus(queryString, ua);
                return {signature, 'x-bogus': bogus};
            },
            [url, userAgent]
        );

        return {xBogus: result['x-bogus'], signature: result.signature, msToken: null};
    } finally {
        await browser.close();
    }
}

module.exports = {defaultSign};
