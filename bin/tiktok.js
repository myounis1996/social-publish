#!/usr/bin/env node
const path = require('path');
const {tiktok} = require('..');
const {parseArgs} = require('./_args');

function help() {
    process.stdout.write(`social-publish-tiktok — pure-HTTP TikTok video publisher

Usage:
  social-publish-tiktok --video=<path> --description=<text> --cookies=<source>

Required:
  --video        Absolute path to the video file (mp4)
  --description  Caption (≤ 2200 chars, supports #tags and @mentions)
  --cookies      Cookie source: file path | "name=value; ..." string | JSON

Optional:
  --user-agent          Override the default UA
  --schedule-seconds    Delay before publish (900..864000); 0 = immediate
  --visibility          0 = public, 1 = private (default 0)
  --allow-comment       0|1 (default 1)
  --allow-duet          0|1 (default 1)
  --allow-stitch        0|1 (default 1)
  --no-verify-hashtags  Skip the challenge/sug lookup
  --signer-command      Shell cmd printing {x-bogus, signature, msToken} JSON
                        (also reads TIKTOK_SIGNER_CMD env)
  --debug               Dump SigV4 canonical request to stderr
  --quiet               Disable progress logs

Required cookies: sessionid, tt-target-idc (msToken recommended)
`);
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h || !args.video || !args.description || !args.cookies) {
        help();
        process.exit(args.help || args.h ? 0 : 1);
    }
    try {
        const result = await tiktok.publishVideo({
            videoPath: path.resolve(args.video),
            description: args.description,
            cookies: args.cookies,
            userAgent: args['user-agent'],
            scheduleSeconds: parseInt(args['schedule-seconds'] || '0', 10),
            visibilityType: parseInt(args.visibility || '0', 10),
            allowComment: parseInt(args['allow-comment'] || '1', 10),
            allowDuet: parseInt(args['allow-duet'] || '1', 10),
            allowStitch: parseInt(args['allow-stitch'] || '1', 10),
            verifyHashtags: !args['no-verify-hashtags'],
            signerCommand: args['signer-command'],
            debug: !!args.debug,
            logger: args.quiet ? false : true,
        });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (err) {
        process.stderr.write(`[tiktok] FAILED: ${err.message}\n`);
        if (err.stack) process.stderr.write(err.stack + '\n');
        process.exit(1);
    }
})();
