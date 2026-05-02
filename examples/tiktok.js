/**
 * Minimal TikTok example. Run with:
 *   node examples/tiktok.js
 *
 * Edit VIDEO_PATH / DESCRIPTION / cookie source below before running.
 *
 * TikTok publish needs an X-Bogus signer. By default this falls back to the
 * bundled headless-Chromium signer (requires `npm i playwright-core`). To use
 * your own signer, pass `signer` (function) or `signerCommand` (shell cmd).
 */
const path = require('path');
const {tiktok} = require('..');

const VIDEO_PATH = path.resolve(__dirname, '..','sample.mp4');
const COOKIES_PATH = path.resolve(__dirname, '..','tiktok-cookies.json');
const DESCRIPTION = 'Hello from social-publish #fyp';

(async () => {
    const result = await tiktok.publishVideo({
        videoPath: VIDEO_PATH,
        description: DESCRIPTION,

        // Pick whichever cookie source you have:
        cookies: COOKIES_PATH,
        // cookies: 'sessionid=...; tt-target-idc=useast2a; msToken=...',
        // cookies: [{name: 'sessionid', value: '...'}, ...],

        visibilityType: 1,         // 0 public, 1 private
        allowComment: 1,
        allowDuet: 0,
        allowStitch: 0,
        // signerCommand: 'node ./vendor/tiktok-signature/browser.js',
    });
    console.log(result);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
