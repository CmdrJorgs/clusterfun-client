---
name: clusterfun-testlobby-verify
description: "Drive a ClusterFun game live in the serverless Test Lobby using headless Chrome + the browser-use CLI, to prove a game actually plays (not just that tests pass). Use to verify/QA/smoke-test a game end to end, screenshot the presenter, or reproduce a gameplay bug. Covers launching the CDP browser, navigating the lobby, synthesizing pointer/drawing input, uploading a photo via CDP, and asserting on canvas pixels."
---

# Verifying a ClusterFun game in the Test Lobby

The Test Lobby (`npm start` with `.env.dev`) runs one presenter + four clients + a virtual
in-memory server on a single page — no relay, no phones. "If it works in the Test Lobby, it
works on the server." This skill drives that page with a real headless browser so you can
confirm a game's core loop and screenshot the shared screen.

This machine's `browser-use` is the **browser-harness** build, invoked as
`uvx browser-use@latest` with a **Python heredoc** (NOT the `browser-use open/click/state`
subcommands in the global browser-use skill — those are a different, older CLI). Helpers like
`new_tab`, `wait_for_load`, `js`, `cdp`, `capture_screenshot` are pre-imported inside the
heredoc.

## 1. Launch the dev server + a CDP browser

```bash
# Dev server (Test Lobby at :3000). Run in the background; wait for it.
cp -n src/secrets.ts.template src/secrets.ts   # build/start needs it
BROWSER=none npm start &                        # or your harness's background runner
# poll until up:
for i in $(seq 1 60); do curl -sf -o /dev/null http://localhost:3000 && break; sleep 2; done

# The browser-use daemon needs a Chrome exposing a CDP port. Launch an isolated one
# (binary may be google-chrome / google-chrome-stable / chromium):
google-chrome --headless=new --remote-debugging-port=9333 \
  --user-data-dir="$SCRATCH/chrome-profile" --no-first-run --disable-gpu about:blank &
sleep 2

# Point browser-use at it (every heredoc call needs this env var):
export BU_CDP_WS=$(curl -s http://localhost:9333/json/version \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['webSocketDebuggerUrl'])")
```

## 2. The heredoc pattern (and the one big gotcha)

```bash
uvx browser-use@latest <<'PY'
new_tab("http://localhost:3000")
wait_for_load()
print(page_info())        # {'url':..,'title':'🐴 ClusterFun.tv DEV ...'}
PY
```

- **`js()` shares ONE global scope across every call.** A bare `const x = ...` at the top
  level throws `Identifier 'x' has already been declared` on the next call. **Wrap every
  multi-statement snippet in an IIFE** and `return` the value:
  `js("(() => { const b = ...; return b ? 'ok' : 'no'; })()")`.
- Prefer `js(...)` DOM queries over screenshots for control flow; screenshot only to eyeball
  layout/imagery. Read text with `js("document.body.innerText")`.
- Raw CDP: `cdp("Domain.method", key=value)`.

## 3. Navigate the lobby → running game

Buttons are found by their text. The flow is: pick the game tile → **Play now ▸** → **Join
game →** (each click adds one client) → the game's own start button.

```bash
uvx browser-use@latest <<'PY'
import time
def clickText(substr):
    return js(f"""(() => {{
      const b = Array.from(document.querySelectorAll('button, [class*=card], [class*=tile], *'))
        .find(e => (e.textContent||'').trim() === {substr!r} || (e.textContent||'').includes({substr!r}));
      if (!b) return 'MISS:' + {substr!r};
      (b.closest('button,[class*=card],[class*=tile]') || b).click(); return 'ok';
    }})()""")
print(clickText("EITtris"))        # the game's displayName from gamesList*/LobbyPresentation
time.sleep(1); print(clickText("Play now"))
time.sleep(2); print(clickText("Join game"))     # one player joins
time.sleep(2); print(clickText("Start"))         # the game's start button — text varies per game
time.sleep(2)
print(js("Array.from(document.querySelectorAll('canvas')).map(c=>c.id+' '+c.width+'x'+c.height).join('\\n')"))
PY
```

Join more clients by clicking **Join game** again. The presenter canvas and each client's
canvas all live on the one page. **Canvas ids are game-specific — always enumerate them with
the snippet above rather than guessing a name.**

## 4. Synthesize input

**Drawing / dragging on a canvas** — dispatch PointerEvents with a fixed `pointerId`:

```bash
uvx browser-use@latest <<'PY'
js("""(() => {
  const canvas = document.querySelector('canvas');   // pick the right one from the enumeration above
  const rect = canvas.getBoundingClientRect();
  const pt = (fx, fy) => ({ x: rect.left + fx*rect.width, y: rect.top + fy*rect.height });
  const path = [];
  for (let i=0;i<=20;i++){ const a=i/20*Math.PI*2; path.push(pt(0.5+0.2*Math.cos(a), 0.45+0.28*Math.sin(a))); }
  const fire = (t,p) => canvas.dispatchEvent(new PointerEvent(t, {
    bubbles:true, cancelable:true, pointerId:7, pointerType:'touch', clientX:p.x, clientY:p.y, isPrimary:true }));
  fire('pointerdown', path[0]);
  for (const p of path.slice(1)) fire('pointermove', p);
  fire('pointerup', path[path.length-1]);
})()""")
PY
```

If a component calls `setPointerCapture`, guard it in the source with try/catch — synthetic
pointerIds can throw `NotFoundError`.

**Uploading a photo** (the camera's file-pick fallback; headless has no real camera). Make a
test image once, then set it on the file input via CDP:

```bash
python3 -c "from PIL import Image; im=Image.new('RGB',(800,600)); px=im.load()
[px.__setitem__((x,y),(x*255//800,y*255//600,128)) for y in range(600) for x in range(800)]
im.save('$SCRATCH/testphoto.jpg',quality=85)"
```

```bash
uvx browser-use@latest <<'PY'
doc = cdp("DOM.getDocument")
node = cdp("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector="input[type=file]")
cdp("DOM.setFileInputFiles", files=["<SCRATCH>/testphoto.jpg"], nodeId=node["nodeId"])
PY
```

## 5. Assert on the result

Confirm something actually painted by counting non-background pixels on the presenter canvas:

```bash
uvx browser-use@latest <<'PY'
print(js("""(() => {
  const c = document.querySelector('canvas');   // the presenter canvas, from the enumeration above
  const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let n=0; for (let i=0;i<d.length;i+=4){ if (Math.abs(d[i]-20)>30||Math.abs(d[i+1]-24)>30||Math.abs(d[i+2]-29)>30) n++; }
  return 'painted px: ' + n;
})()"""))
PY
```

Screenshot the shared screen and view it:

```bash
uvx browser-use@latest <<'PY'
print(capture_screenshot())   # prints a path, e.g. ~/.config/browser-harness/tmp/shot.png
PY
```

Then `Read` that PNG path to see it. Also check for join/error banners
(`document.body.innerText`) and that live per-player fields update (a stale count often means
the MobX `makeObservable` trap — see the clusterfun-new-game skill).

## 6. Teardown

```bash
pkill -f "remote-debugging-port=9333"   # stop the CDP Chrome
# stop the background dev server via your harness (TaskStop / kill the npm start job)
```

## Checklist for "this game really plays"

- [ ] Client joins; presenter shows it in the gathering list.
- [ ] Host start button advances presenter + clients to the playing state.
- [ ] The core input (tap/draw/type/photo) round-trips and the presenter re-renders it.
- [ ] A second client can join **mid-game** (no "could not join" banner).
- [ ] Refresh the presenter and a client mid-game — both resume (checkpoint restore).
- [ ] Per-player UI (scores/counts/colors) updates live.
