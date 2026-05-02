# social-publish

> ⚠️ **Educational / research project — noncommercial use only.** This package
> documents how the Instagram and TikTok web upload pipelines work, implemented
> in plain Node.js for learning, debugging, and personal automation of **your
> own** account. It is **not** a bulk uploader, scraper, or growth tool, and
> commercial use is prohibited by the [license](./LICENSE). See
> [Acceptable use](#acceptable-use) below.

A reference implementation of the Instagram Reels and TikTok web video upload
flows in pure Node.js (stdlib only). Authenticates with the same session
cookies your browser uses — no third-party services involved.

> This project is **not** published to npm and is not intended to be. Clone
> it from GitHub and use it locally.

### Install

```bash
git clone https://github.com/myounis1996/social-publish.git
cd social-publish

# Optional — only needed for the bundled TikTok signer:
npm install playwright-core
```

No other Node dependencies. Requires:

- **Node.js 18+**
- **ffmpeg** + **ffprobe** on PATH (Instagram cover-frame extraction + metadata
  probing; not needed for TikTok)

## Acceptable use

By using this code you agree that:

- You will only publish to **accounts you own** or are explicitly authorized
  to manage.
- You will respect the
  [Instagram Terms of Use](https://help.instagram.com/581066165581870) and
  [TikTok Terms of Service](https://www.tiktok.com/legal/page/row/terms-of-service/en),
  including their rate limits, content policies, and rules on automation.
- You will **not** use it for spam, fake engagement, mass-account farming,
  impersonation, harassment, or any activity prohibited by the platforms.
- You will not redistribute or resell the package as a "growth" / "bot" tool.

The author provides this as-is for **educational purposes only** and accepts
no liability for misuse, account suspensions, or any other consequences. If
you intend to publish at scale, use the official
[Instagram Graph API](https://developers.facebook.com/docs/instagram-api/) or
[TikTok Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started/)
instead.

---

## Quick start

From within the cloned repo:

```js
const {instagram, tiktok} = require('./'); // or require('/abs/path/to/social-publish')

await instagram.publishReel({
    videoPath: '/abs/path/clip.mp4',
    caption: 'Hello world #demo',
    cookies: './instagram-cookies.json',
});

await tiktok.publishVideo({
    videoPath: '/abs/path/clip.mp4',
    description: 'Hello world #fyp',
    cookies: './tiktok-cookies.json',
});
```

CLIs (run directly with `node`):

```bash
node bin/instagram.js --video=clip.mp4 --caption="hi #demo" --cookies=ig.json
node bin/tiktok.js    --video=clip.mp4 --description="hi #fyp" --cookies=tt.json
```

---

## Cookies — every format

The `cookies` field accepts **any** of these — auto-detected:

| Form | Example |
|------|---------|
| Header string | `'sessionid=abc; csrftoken=xyz'` |
| Plain object | `{sessionid: 'abc', csrftoken: 'xyz'}` |
| Playwright / Cookie-Editor array | `[{name:'sessionid', value:'abc', domain:'.instagram.com'}, ...]` |
| File path → JSON | `'./cookies.json'` (object **or** array inside) |
| File path → header | `'./cookies.txt'` containing `name=value; ...` |
| File path → Netscape | `'./cookies.txt'` (`# Netscape HTTP Cookie File`) |
| Buffer | `fs.readFileSync('./cookies.json')` |

Required cookies:

- **Instagram** — `sessionid`, `csrftoken`
- **TikTok** — `sessionid`, `tt-target-idc` (`msToken` recommended)

You can also use the loader directly:

```js
const {loadCookies} = require('social-publish');
const jar = loadCookies('./cookies.json');
jar.get('sessionid');     // → "abc..."
jar.set('foo', 'bar');
jar.toString();           // → "sessionid=abc; foo=bar"
jar.array();              // → [{name, value}, ...]
```

---

## Instagram — `instagram.publishReel(opts)`

Uploads + publishes a Reel via `i.instagram.com/rupload_igvideo` →
`/api/v1/media/configure_to_clips/`.

| Option | Required | Default | Notes |
|--------|----------|---------|-------|
| `videoPath` | ✅ | — | Absolute path to mp4 (vertical 9:16 best) |
| `caption` | ✅ | — | Reel caption text |
| `cookies` | ✅ | — | Any format above |
| `appId` | | `936619743392459` | `x-ig-app-id` header |
| `sessionId` | | random | Web session id |
| `configureRetries` | | `10` | Poll attempts while transcoding |
| `logger` | | `true` | `false` to silence, or a `{info, warn, error}` object |

Returns `{url, code, mediaId, response}`.

---

## TikTok — `tiktok.publishVideo(opts)`

Full pipeline: project create → AWS-SigV4 `ApplyUploadInner` → chunked upload
(5 MiB / chunk, CRC32 per chunk) → `CommitUploadInner` → `/project/post/`.

| Option | Required | Default | Notes |
|--------|----------|---------|-------|
| `videoPath` | ✅ | — | Absolute path to mp4 |
| `description` | ✅ | — | ≤ 2200 chars |
| `cookies` | ✅ | — | Any format above |
| `scheduleSeconds` | | `0` | 900..864 000; 0 = post now |
| `visibilityType` | | `0` | 0 public, 1 private |
| `allowComment` / `allowDuet` / `allowStitch` | | `1` | 0 or 1 |
| `verifyHashtags` | | `true` | Resolve canonical name via challenge/sug |
| `signer` | | — | `async ({url, userAgent}) => {xBogus, signature, msToken?}` |
| `signerCommand` | | env `TIKTOK_SIGNER_CMD` | Shell cmd printing JSON to stdout |
| `userAgent` | | Chrome 120 | |
| `logger` / `debug` | | `true` / `false` | |

Returns `{success, videoId, creationId, projectId, scheduledFor, response}`.

#### X-Bogus / `_signature`

The publish endpoint requires two reverse-engineered values. Three options:

1. **Bundled signer (default)** — headless Chrome via `playwright-core` evaluates
   the obfuscated TikTok bundles in `lib/tiktok/vendor/`. Adds ~2s/publish.
2. **Custom function** — `opts.signer = async ({url, userAgent}) => ({xBogus, signature})`.
3. **Subprocess** — `opts.signerCommand = 'node ./vendor/tiktok-signature/browser.js'`
   (or `TIKTOK_SIGNER_CMD` env). Receives `<url>` `<userAgent>` as argv, prints
   `{"x-bogus":"...", "signature":"...", "msToken":"..."}` (optionally wrapped
   in `data`).

Hashtags become clickable because the publisher emits `markup_text` with
`<h id="N">#tag</h>` wrappers and matching `text_extra` entries (Unicode-aware,
so Arabic / CJK tags work).

---

## Project layout

```
social-publish/
├── index.js                 # public exports
├── lib/
│   ├── shared/
│   │   ├── http.js          # https.request wrapper (no chunked TE)
│   │   ├── cookies.js       # universal cookie loader
│   │   └── logger.js        # tiny logger shim
│   ├── instagram/
│   │   └── index.js         # publishReel()
│   └── tiktok/
│       ├── index.js         # publishVideo()
│       ├── aws-sigv4.js     # SigV4 for the VOD Top API
│       ├── signer.js        # pluggable X-Bogus adapter
│       ├── signer-default.js  # Playwright-based default signer
│       └── vendor/          # signer.js, webmssdk.js, xbogus.js
├── bin/
│   ├── instagram.js         # CLI
│   ├── tiktok.js            # CLI
│   └── _args.js             # tiny argv parser
└── examples/
    ├── instagram.js
    └── tiktok.js
```

---

## Limitations / notes

- Cookies expire — refresh from a logged-in browser when uploads start failing
  with 401/403. Don't paper over auth failures with auto-retry loops.
- Instagram publish requires `ffmpeg` + `ffprobe`; TikTok publish doesn't.
- TikTok `@user` mentions post as text; `user_id` is empty unless resolved
  upstream.
- 5xx responses are surfaced as exceptions and not retried — by design. If you
  hit them repeatedly, slow down rather than building tighter retry loops.
- Both platforms detect and rate-limit unusual upload patterns. If you're
  publishing more than a handful of videos a day, switch to the official APIs.

## License

[PolyForm Noncommercial 1.0.0](./LICENSE) — free for personal, research,
educational, and other noncommercial use. **Commercial use is not permitted.**
You may not use this code (or any derivative of it) as part of a product or
service offered for a fee, ad-supported, or otherwise commercial.

The license covers the code only; it does not grant any right to violate
Instagram's or TikTok's terms. See [Acceptable use](#acceptable-use).
