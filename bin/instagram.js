#!/usr/bin/env node
const path = require('path');
const {instagram} = require('..');
const {parseArgs} = require('./_args');

function help() {
    process.stdout.write(`social-publish-instagram — pure-HTTP Instagram Reels publisher

Usage:
  social-publish-instagram --video=<path> --caption=<text> --cookies=<source>

Required:
  --video      Absolute path to the video file (mp4, vertical 9:16 recommended)
  --caption    Reel caption text
  --cookies    Cookie source: file path | "name=value; ..." string | JSON

Optional:
  --app-id              x-ig-app-id header (default 936619743392459)
  --session-id          web session id (auto-generated if omitted)
  --configure-retries   Transcode poll attempts (default 10)
  --quiet               Disable progress logs

Required cookies: sessionid, csrftoken (mid + ds_user_id strongly recommended)
`);
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h || !args.video || !args.caption || !args.cookies) {
        help();
        process.exit(args.help || args.h ? 0 : 1);
    }
    try {
        const result = await instagram.publishReel({
            videoPath: path.resolve(args.video),
            caption: args.caption,
            cookies: args.cookies,
            appId: args['app-id'],
            sessionId: args['session-id'],
            configureRetries: args['configure-retries'] ? parseInt(args['configure-retries'], 10) : undefined,
            logger: args.quiet ? false : true,
        });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (err) {
        process.stderr.write(`[instagram] FAILED: ${err.message}\n`);
        if (err.stack) process.stderr.write(err.stack + '\n');
        process.exit(1);
    }
})();
