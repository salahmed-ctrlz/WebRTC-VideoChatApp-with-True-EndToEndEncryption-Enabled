# Private Meet

Self-hosted group video meetings where the server never sees your video, audio, chat or even who is talking. No accounts, no build step, one small Node process.

Start a meeting, send the link, talk. Up to six people by default, with screen sharing and chat.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000. Cameras only work on `localhost` or over HTTPS, so put it behind TLS when you deploy it (see below).

Or with Docker:

```bash
docker build -t private-meet .
docker run -p 3000:3000 -e TRUST_PROXY=1 private-meet
```

## How it works

Every meeting link looks like this:

```
https://meet.example.com/#ROOMID.SECRET
```

The browser sends `ROOMID` to the server so it can group people into a room. `SECRET` sits after the `#`, which browsers never put in a request, so the server never receives it. Everything else is derived from that secret in the browser:

- **Signalling.** Offers, answers, ICE candidates, display names, mute state and chat are sealed with AES-GCM before they leave your device. The server relays opaque blobs. Each message is bound to the room and to its sender and recipient, so the relay can't re-address, re-attribute or edit it, and it can't swap the DTLS fingerprints in an offer to sit in the middle of a call.
- **Media.** Audio and video go directly between participants (a mesh). On top of the normal DTLS-SRTP, every encoded frame is encrypted in a worker with a key derived per sender from the room secret. Frames that fail to authenticate are dropped, never decoded.
- **Safety code.** A short code derived from the secret is shown in the lobby and in the room. Read it out to confirm everyone holds the same key.

The People panel shows, per participant, whether their frames are actually being decrypted.

### What it does not protect

- Anyone with the link can join. Treat it like a password. There are no per-user identities; names are whatever people type.
- The server can see that a room exists, how many connections it has, IP addresses, and message sizes and timing.
- Participants can see each other's IP addresses, as with any peer-to-peer call.
- If someone leaves, the key doesn't change. Start a new meeting if a link leaks.
- You trust whoever serves the JavaScript, as with any web app. Self-host it for that reason.
- A few bytes at the start of each frame (1 for audio, 3 or 10 for video) stay readable because the RTP packetiser needs them. They are authenticated but not secret.

### Limits

- It is a mesh: every person sends their video to every other person. That is fine for small groups and gets heavy past six or eight. `MAX_PEERS` sets the cap; bitrate drops automatically as people join.
- Video uses VP8, because the frame encryption keeps the VP8 header bytes readable. Other codecs aren't offered.
- Needs a browser with encoded transforms (`RTCRtpScriptTransform`): current Chrome and Edge, Firefox 117+, Safari 15.4+. Browsers without it are blocked by default (`requireFrameEncryption` in `brand.json`). I develop and test against Chromium; the other two follow the standard API but get less testing.
- Default ICE servers are public STUN only. People behind strict NATs or corporate firewalls need a TURN server (below).

## Make it yours

Everything visible is configured in `brand.json`. Point `BRAND_FILE` at a different file to keep it outside the repo.

```json
{
  "name": "Acme Calls",
  "tagline": "Calls for the Acme team.",
  "logo": "/logo.svg",
  "accent": "#5b5bd6",
  "theme": "system",
  "links": [{ "label": "Terms", "url": "https://acme.example/terms" }],
  "credit": null,
  "features": { "chat": true, "screenShare": true, "raiseHand": true },
  "requireFrameEncryption": true,
  "strings": { "newMeeting": "Start a call" }
}
```

| Field | Meaning |
| --- | --- |
| `name`, `tagline` | Page title, header and landing headline |
| `logo` | Path or URL of an image. Empty uses a generic mark. Put local files in `public/` |
| `accent` | Hex colour for buttons and highlights. Text colour on top of it is picked for contrast |
| `theme` | `system`, `light` or `dark` default. Users can still toggle |
| `links` | Footer links |
| `credit` | `{ "text", "url" }` shown bottom right, or `null` to hide it |
| `features` | Turn chat, screen sharing and raise hand on or off |
| `requireFrameEncryption` | `false` lets unsupported browsers in with transport encryption only. The room shows a warning |
| `strings` | Override any UI text. Keys are in `public/js/strings.js` |

For deeper changes the front end is plain ES modules in `public/` and the styles are CSS variables at the top of `public/css/app.css`.

## Configuration

Set through environment variables (see `.env.example`):

| Variable | Default | |
| --- | --- | --- |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | |
| `MAX_PEERS` | `6` | People per meeting (2 to 16) |
| `ALLOWED_ORIGINS` | same origin | Comma-separated list for the signalling socket |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy so client IPs and HTTPS are read from `X-Forwarded-*` |
| `ICE_SERVERS` | public STUN | JSON array that replaces the default STUN list |
| `TURN_URLS`, `TURN_SECRET` | none | TURN with short-lived credentials generated per request |
| `BRAND_FILE` | `./brand.json` | |

The server also applies a strict Content-Security-Policy, rate-limits every connection, caps connections per IP and rooms in total, and checks the `Origin` of WebSocket upgrades.

## Deploying

Any host that runs Node and supports WebSockets works. You need HTTPS.

- **Render**: `render.yaml` is included for the free web service tier.
- **Docker behind Caddy**: a two-line Caddyfile gives you automatic certificates:

  ```
  meet.example.com {
    reverse_proxy private-meet:3000
  }
  ```

### TURN

STUN is enough for most home and mobile networks. For the rest, run [coturn](https://github.com/coturn/coturn) with `use-auth-secret` and `static-auth-secret=<secret>`, then set:

```
TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
TURN_SECRET=<secret>
```

The server hands each browser credentials that expire after six hours, so the secret never reaches the client.

## Development

```bash
npm run dev      # restart on change
npm test         # crypto, frame encryption and relay tests, no browser needed
```

`test/e2e.mjs` drives three real Chromium instances through a meeting with a fake camera: media flowing and decrypting, chat, mute, screen share, a wrong-key outsider, leaving, and a phone-sized layout. It needs Playwright:

```bash
npm i -D playwright && npx playwright install chromium
node test/e2e.mjs
```

## Background

This started as a Master's thesis project on end-to-end encryption in WebRTC video streaming at Badji Mokhtar University, Annaba. Version 2 is a rewrite.

## License

MIT. See [LICENSE](LICENSE).

Built by [salaheddinemedkour.me](https://salaheddinemedkour.me).
