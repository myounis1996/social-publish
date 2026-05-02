/**
 * Minimal Instagram example. Run with:
 *   node examples/instagram.js
 *
 * Edit VIDEO_PATH / CAPTION / cookie source below before running.
 */
const path = require('path');
const {instagram} = require('..');

const VIDEO_PATH = path.resolve(__dirname, '..', 'sample.mp4');
const COOKIES_PATH = path.resolve(__dirname, '..','instagram-cookies.json');

const CAPTION = 'Hello from social-publish 👋 #demo';

(async () => {
    const result = await instagram.publishReel({
        videoPath: VIDEO_PATH,
        caption: CAPTION,

        // Pick whichever cookie source you have:
        cookies: COOKIES_PATH,
        // cookies: 'sessionid=...; csrftoken=...; mid=...; ds_user_id=...',
        // cookies: [{name: 'sessionid', value: '...'}, ...],
        // cookies: {sessionid: '...', csrftoken: '...'},
    });
    console.log(result);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
