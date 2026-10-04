# wall-screen

Controls what's shown on the greenscreen wall panel in the stream. OBS loads `/display` as a browser source, StreamFX corner pin warps it onto the wall, and you change the content from any browser (phone included) at `/control`.

A **default video** always loops on the wall. Anything else (an image, a promo video, a web page, text) shows on top of it. When that's cleared, or a "play once" video finishes, the wall goes back to the default.

## Running it

Needs Node.js 18 or newer (https://nodejs.org). No `npm install` needed: there are no dependencies.

```powershell
cd wall-screen
node server.js
```

With options:

```powershell
$env:PORT = "3000"; $env:CONTROL_KEY = "pick-a-secret"; node server.js
```

On start it prints the display and control URLs for `localhost` and every LAN IP. Open the control URL on your phone (same Wi-Fi) to drive the wall.

Other environment variables, all optional:

- `DATA_DIR`: where `media/`, `state.json`, `rundowns.json` and `asrun.csv` live (default: next to `server.js`). Give each instance its own to run several walls from one copy of the code.
- `HOST`: the address to listen on (default `0.0.0.0`, every interface). Set `127.0.0.1` behind a reverse proxy.
- `PUBLIC_URL`: the address the server is reached at from outside, e.g. `https://wall.example.com`. The control panel then shows `<PUBLIC_URL>/display` as the OBS URL.
- `MAX_UPLOAD_MB`: largest upload accepted (default `2048`).

- `media/` holds uploaded images and videos. You can also copy files in directly.
- `state.json` holds the current state, so a restart comes back showing the same thing.
- If `CONTROL_KEY` is set, open the control page as `/control?key=pick-a-secret`. `/display`, `/events`, `/media` and `/api/ended` never need the key, so OBS needs no credentials.

## The control panel

It works like a vision mixer, built for a laptop or desktop.

- **PREVIEW (green)** is only on your screen. Click a rundown row or library item to cue it there, then scrub or check it.
- **PROGRAM (red)** is what's on the wall. It follows OBS's playback position.
- **TAKE** (Space) cuts Preview to air. **AUTO** (Enter) dissolves at the **Rate** you pick.
- After a take, Preview rolls on to the next rundown row. For anything not from the rundown, Preview and Program swap, so a second TAKE undoes the first.
- **FTB** (B) fades to black in one press. It flashes while the wall is black, and pressing it again fades back up to what was on air. **SAFE** returns to the default loop and needs a second press.
- A TAKE, AUTO or FTB button flashes white when the server has the press. The second click of a double-click is ignored, so a habitual double-click doesn't take and immediately take back.
- **↑ / ↓** cue the previous or next rundown row. **Esc** cancels an armed button. **Lock** ignores all clicks and keys until you unlock.

### Rundowns

- Each rundown is a saved running order, one per show. They live in `rundowns.json` on the server.
- Every row can have:
  - **Hold (s):** end after N seconds.
  - **Loop / Once** (videos only).
  - **Sound / Muted** (videos only, muted by default).
  - **AF (auto-follow):** when this row ends, take whatever is in Preview, normally the next row.
- A row "ends" when a play-once video finishes or its hold time runs out. With AF off it goes back to the default loop.
- Edits to a row that's cued or on air apply immediately.
- The countdown under PROGRAM shows time remaining (amber at 10s, red at 5s) and what happens next, or elapsed time for open-ended items.

### Status and logs

- The top bar shows whether OBS's display is connected. If it says 2 or more, close any extra `/display` tabs.
- A red banner appears if OBS can't play a file. Library cards also flag files the browser can't decode (HEVC/ProRes).
- Every take is written to `asrun.csv` (download it from the as-run panel).
- Use one control tab per browser: Chrome allows only 6 connections to the server, and each monitor uses some of them.
- Switcher buttons (TAKE, AUTO, FTB, SAFE, cueing, Program settings) are sent over a WebSocket at `/ws`, which doesn't share that limit, so a press is never held up behind the monitors. A press that still reaches the server more than 1.5 seconds after the click is ignored and the panel asks you to press again, so a backlog can never fire a string of takes.
- The **Server** light in the top bar is green when both the page's live updates and its button connection are up. Amber with "commands not connected", plus a banner, means an older `server.js` is still running: restart it.
- The display keeps each file it plays in memory after first use (files up to 300 MB), so takes never wait on the network, and it keeps whatever just went off air ready, so TAKE can swap straight back.

## OBS setup

1. Add a **Browser** source.
2. URL: `http://localhost:3000/display`
3. Width `1920`, Height `1080`.
4. Untick **Shutdown source when not visible** and **Refresh browser when scene becomes active**.
5. Apply the StreamFX **corner pin** filter to this source and line it up with the wall.

The source's bounds never change (it's always 1920x1080, whatever is showing), so the pin only needs setting once. The display reconnects by itself after a server restart, and reloads itself when the display page is updated, so OBS never needs a manual refresh. (Displays from before this feature need one last refresh: Properties > **Refresh cache of current page**.)

### Audio

Videos (and screen shares) are silent on the wall unless you turn their sound on: the **Sound** column in the rundown, or the **Muted / Sound** switch under Preview (before the take) or Program (live, without restarting the video). Sound fades in and out with AUTO dissolves. The default loop, images and the control page's monitors are always silent.

To get the wall's sound in OBS, tick **Control audio via OBS** on the browser source. It then appears as its own channel in OBS's audio mixer, where you set its level and filters. Without the tick, the sound goes straight to your desktop audio.

Web pages aren't muted by the wall, so a page or embed that plays sound will be heard. Add `mute=1` to YouTube embed links to keep them silent.

Stream Deck: add `&audio=1` to a `/api/show` URL to take a video with sound, or call `/api/show?audio=0` / `?audio=1` to switch the on-air video's sound.

## Screen sharing

Any computer with Chrome or Edge can put its screen on the wall through the same OBS browser source.

1. Open `/share` on the computer to share from (add `?key=…` if you set a key). On the streaming PC, **Share this computer** in the control panel's **Screen shares** panel opens it in a new window.
2. Give it a name, click **Share screen** and pick a tab, window or whole screen in Chrome's picker.
3. It appears under **Screen shares** in the control panel. **Cue** puts it in Preview; then TAKE or AUTO as usual. FTB, SAFE, dissolves, Fit/Fill and the as-run log all work with it.

- **+ Screen share** under the rundown adds a row that shows whichever share started last, so a rundown can hold a "screen" slot before anyone is sharing. **+ Rundown** on a share adds a row for that share.
- Keep the share tab open. Stopping (the page's button, Chrome's own "Stop sharing" bar, or closing the tab) takes the wall back to the default loop.
- **Share something else** switches what's shared without dropping off the wall.
- Video settings on the share page (saved per computer):
  - **Output** 1080p30 / 1080p60 / 720p30 / 720p60: the size and frame rate sent to OBS (larger sources are downscaled; nothing is upscaled).
  - **Bitrate**: Auto is 10 / 16 / 6 / 9 Mbps for those formats. The stream starts at this rate and won't drop below half of it, so it's sharp straight away; the floor assumes a local network or a solid connection.
  - **Codec**: Auto uses the first of H.264, VP9, AV1 the sharing computer can encode in hardware, else VP8 in software.
  - **Under load**: what gives way if the encoder or network can't keep up. The default holds resolution and frame rate and lets the picture soften instead.
  - **Content**: the encoder hint, Detail (text, UI) or Motion (video, games).
  - The live stats line shows capture fps against sent fps, resolution, codec, bitrate against target, and "limited by: cpu/bandwidth" when the encoder is held back.
- Share a single window or tab, not the whole screen, on the streaming PC, or the wall ends up showing OBS inside itself.

**Sound.** With **Share sound too** ticked, Chrome's picker offers the sound as well: a **tab** always can, the **whole screen** can on Windows (tick "Share system audio"), a **window** can't. The share page says "With sound" or "No sound". A share goes on the wall muted, like a video: turn it on with the **Muted / Sound** switch under Preview or Program, or the Sound button on its rundown row. It reaches OBS the same way as video sound (see Audio above), in stereo, and only the OBS display gets it; the control panel's monitors stay silent.

On the streaming PC, share a tab's sound rather than system audio: system audio there includes whatever OBS and the desktop play, which would echo back into the stream.

The video goes straight from the sharing browser to OBS (WebRTC); the server only passes on the few messages that set up the connection, so a share keeps playing even through a server restart. The OBS display gets full quality; the control panel's monitors get a small copy.

### Sharing from another computer

Chrome only allows screen sharing on `https://` pages or on `localhost`, so a laptop opening `http://192.168.x.x:3000/share` gets an error. Either:

- Open it through an https link, e.g. the Cloudflare quick tunnel below: `https://<random>.trycloudflare.com/share?key=…`. The video itself still goes directly over your network.
- Or, on that laptop only, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://<server-ip>:3000`, enable it and relaunch Chrome.

Both computers need to reach each other directly (same network, or ordinary home/office internet). Very locked-down networks that block WebRTC won't connect.

## Video format tips

- **H.264 MP4** or **VP9 WebM**, 1080p. Avoid HEVC/H.265 and ProRes `.mov` files, which OBS's browser can't decode.
- The browser source is 1920x1080, so anything bigger is scaled down to that and only costs CPU. Above about 4096x2304, graphics cards can't decode H.264, so the CPU does all of it.
- The control panel's monitors show such oversized videos, or any video they can't keep up with, as a still frame (Preview has Play to try anyway). The wall still plays them.
- Keep loops short (10 to 30 seconds), and cut on a matching frame so the loop is seamless.
- A reasonable ffmpeg encode: `ffmpeg -i in.mov -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -an out.mp4`

## Web pages

Pick **Web page** in "Show a URL" (or use `?page=` from a Stream Deck). Bare domains like `example.com` become `https://example.com`. Only `http(s)` URLs are accepted.

Many sites refuse to be embedded (Google, the main YouTube site, lots of social and casino sites) and show a blank or "refused to connect" panel. YouTube **embed** links (`https://www.youtube.com/embed/<id>?autoplay=1&mute=1`) and your own dashboards usually work. For a site that blocks embedding, add a second OBS browser source with the same corner pin.

## Running as a service on Windows

**NSSM** (https://nssm.cc):

```powershell
nssm install wall-screen "C:\Program Files\nodejs\node.exe" "C:\path\to\wall-screen\server.js"
nssm set wall-screen AppDirectory "C:\path\to\wall-screen"
nssm set wall-screen AppEnvironmentExtra CONTROL_KEY=pick-a-secret PORT=3000
nssm start wall-screen
```

**pm2**:

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
$env:CONTROL_KEY = "pick-a-secret"; pm2 start server.js --name wall-screen
pm2 save
```

## Remote control with Cloudflare Tunnel

**Set `CONTROL_KEY` first.** Without it, anyone with the link can change your wall.

Quick tunnel (temporary URL):

```powershell
cloudflared tunnel --url http://localhost:3000
```

Then open `https://<random>.trycloudflare.com/control?key=pick-a-secret`. For a fixed hostname, create a named tunnel in the Cloudflare dashboard that points to `http://localhost:3000`. OBS should keep using `http://localhost:3000/display`.

## Stream Deck

Use the **Website** action (tick "GET request in background") or a "System: Open" / HTTP request plugin with these URLs. Add `&key=pick-a-secret` if you set a key.

Switcher buttons:

| Button | URL |
| --- | --- |
| TAKE (cut) | `http://localhost:3000/api/take` |
| AUTO (dissolve) | `http://localhost:3000/api/auto` |
| Cue next / previous row | `http://localhost:3000/api/next`, `/api/prev` |
| Cue row 3 | `http://localhost:3000/api/cue?n=3` |
| Cue a file in Preview | `http://localhost:3000/api/preview?file=promo.mp4&loop=0` |
| Fade to black (press again to fade back up) | `http://localhost:3000/api/ftb` |
| SAFE (default loop) | `http://localhost:3000/api/safe` |

Straight to air (skips Preview):

| Button | URL |
| --- | --- |
| Back to default | `http://localhost:3000/api/show?type=default` |
| Blank | `http://localhost:3000/api/show?type=blank` |
| Promo, play once | `http://localhost:3000/api/show?file=promo.mp4&loop=0` |
| Promo, looping | `http://localhost:3000/api/show?file=promo.mp4` |
| Logo image | `http://localhost:3000/api/show?file=logo.png&fit=contain` |
| Image from URL | `http://localhost:3000/api/show?url=https://example.com/a.png&type=image` |
| Web page | `http://localhost:3000/api/show?page=https://example.com` |
| Text | `http://localhost:3000/api/show?text=Welcome%20in!` |
| Latest screen share | `http://localhost:3000/api/show?type=screen` |
| Fit change only | `http://localhost:3000/api/show?fit=contain` |
| Change default | `http://localhost:3000/api/default?file=betbolt-loop.mp4` |

## API

| Method | Path | Key | Purpose |
| --- | --- | --- | --- |
| GET | `/display` | no | Display page |
| GET | `/control` | yes | Control page |
| GET | `/events` | no | Server-Sent Events state stream |
| GET | `/api/state` | no | Current state |
| GET | `/media/<file>` | no | Media files (Range supported) |
| GET | `/api/info` | yes | OBS display URL (localhost and LAN) |
| GET | `/api/media` | yes | Media list, newest first |
| GET/POST | `/api/take`, `/api/auto` | yes | Preview to air, cut or dissolve |
| GET/POST | `/api/ftb`, `/api/safe` | yes | Fade to black / back to default loop |
| GET/POST | `/api/next`, `/api/prev`, `/api/cue?n=` | yes | Cue a rundown row in Preview |
| POST | `/api/preview` | yes | `{item}` or `{clear: true}` |
| GET | `/api/preview` | yes | Same query params as `GET /api/show` |
| POST | `/api/settings` | yes | `{autoMs}` AUTO dissolve length |
| GET | `/api/rundowns` | yes | All rundowns |
| POST | `/api/rundowns` | yes | `{action: create/rename/delete/activate/save, ...}` |
| GET | `/api/asrun`, `/api/asrun.csv` | yes | As-run log (recent / full CSV) |
| POST | `/api/show` | yes | `{type, src, loop, fit, bg, text}`, straight to air; partial updates allowed |
| GET | `/api/show` | yes | `?file=`, `?url=&type=`, `?page=`, `?text=`, `?type=`, plus `&loop=0`, `&fit=`, `&bg=` |
| POST | `/api/default` | yes | `{ "src": "/media/x.mp4" }`, or `""` to clear |
| GET | `/api/default` | yes | `?file=x.mp4` |
| POST | `/api/ended` | no | Called by the display when a play-once video ends |
| POST | `/api/position` | no | The display reports video position each second; the control-page preview (`/display?preview=1`) follows it |
| POST | `/api/upload` | yes | Raw body, `X-Filename` header (URI-encoded) |
| GET | `/share` | yes | Screen share page |
| GET | `/screen.js` | no | Screen share script used by the pages |
| POST | `/api/rtc` | no* | Screen share connection setup from a viewer page (*watching a share that isn't on air or cued needs the key) |
| DELETE | `/api/media?name=` | yes | Delete a file |
