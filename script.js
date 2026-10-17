let W = 800, H = 500;
const $ = id => document.getElementById(id);
const stage = $("canvas");
const ctx = stage.getContext("2d");
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const CW = 14;                       // timeline cell width, matches --cw
const CORNERS = [[0, 0], [1, 0], [0, 1], [1, 1]];

// A layer's `frames` holds one canvas per frame. A keyframe's canvas is repeated
// for every frame of its span, so frames[i] === frames[i - 1] means "not a keyframe".
let layers = [];
let current = 0, layerIdx = 0;
let tool = "brush", player = null, drag = null;
let float = null;                    // floating selection / placed image, not yet drawn into its keyframe
let clipboard = null, library = [];
let past = [], future = [], dirty = false;
let unversioned = false;             // edits since the last version-history entry

const ID = () => ({ x: 0, y: 0, sx: 1, sy: 1, r: 0, a: 1 });

function canvas(w = W, h = H) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
}

const uid = () => Math.random().toString(36).slice(2, 12);     // stable names for multiplayer sync

function blank() {
    return Object.assign(canvas(), { id: uid(), empty: true, t: ID(), tween: false, ease: 0 });
}

function copyKey(k) {
    const c = blank();
    c.getContext("2d").drawImage(k, 0, 0);
    return Object.assign(c, { empty: k.empty, t: { ...k.t } });
}

const newLayer = name => ({ id: uid(), name, frames: [blank()], hidden: false, locked: false });
const L = () => layers[layerIdx];
const total = () => Math.max(1, ...layers.map(l => l.frames.length));
const isKey = (f, i) => i < f.length && f[i] !== f[i - 1];
const startOf = (f, i) => { while (i > 0 && f[i - 1] === f[i]) i--; return i; };
const endOf = (f, i) => { while (f[i + 1] === f[i]) i++; return i; };

function flash(msg) {
    $("status").textContent = msg;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => $("status").textContent = "", 2500);
}

// ---------- transforms & tweens ----------

function transformAt(f, i) {
    const k = f[i], s = startOf(f, i), e = endOf(f, i) + 1, next = f[e];
    if (!k.tween || !next || i === s) return k.t;
    let p = (i - s) / (e - s);
    p += (k.ease / 100) * p * (1 - p);       // +100 = ease out, -100 = ease in
    const o = {};
    for (const key in k.t) o[key] = k.t[key] + (next.t[key] - k.t[key]) * p;
    return o;
}

const matrix = t => new DOMMatrix()
    .translate(W / 2 + t.x, H / 2 + t.y).rotate(t.r).scale(t.sx, t.sy).translate(-W / 2, -H / 2);

function curT() {
    const f = L().frames;
    return current < f.length ? transformAt(f, current) : ID();
}

function withLocal(c, fn) {
    c.save();
    c.setTransform(matrix(curT()));
    fn(c);
    c.restore();
}

// ---------- rendering ----------

const tint = canvas(), tctx = tint.getContext("2d");

function onion(c, f, j, color) {
    if (j < 0 || j >= f.length) return;
    tctx.globalCompositeOperation = "copy";
    tctx.drawImage(f[j], 0, 0);
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, W, H);
    const t = transformAt(f, j);
    c.globalAlpha = 0.25 * t.a;
    c.setTransform(matrix(t));
    c.drawImage(tint, 0, 0);
}

function drawScene(c, i, live) {
    c.globalCompositeOperation = "source-over";
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = $("bgColor").value;
    c.fillRect(0, 0, W, H);
    for (let n = layers.length - 1; n >= 0; n--) {        // index 0 is the top layer
        const l = layers[n], f = l.frames;
        if (l.hidden || i >= f.length) continue;
        if (live && n === layerIdx && $("onion").checked && !player) {
            onion(c, f, i - 1, "#ff3030");
            onion(c, f, i + 1, "#20b040");
        }
        const t = transformAt(f, i);
        c.globalAlpha = t.a;
        c.setTransform(matrix(t));
        c.drawImage(f[i], 0, 0);
        if (live && float && float.k === f[i]) c.drawImage(float.c, float.x, float.y, float.w, float.h);
        c.globalAlpha = 1;
        c.setTransform(1, 0, 0, 1, 0, 0);
    }
}

function render(preview) {
    drawScene(ctx, current, true);
    if (float) withLocal(ctx, c => {
        const s = 1 / Math.abs(curT().sx);
        c.lineWidth = s;
        c.strokeStyle = "#4a9eff";
        c.setLineDash([4 * s, 3 * s]);
        c.strokeRect(float.x, float.y, float.w, float.h);
        c.setLineDash([]);
        c.fillStyle = "#fff";
        for (const [u, v] of CORNERS) {
            const x = float.x + u * float.w - 4 * s, y = float.y + v * float.h - 4 * s;
            c.fillRect(x, y, 8 * s, 8 * s);
            c.strokeRect(x, y, 8 * s, 8 * s);
        }
    });
    if (preview) withLocal(ctx, preview);
    placeCursors();
}

function drawTimeline() {
    const n = Math.max(total(), current + 1) + 30;

    const list = $("layerList");
    list.innerHTML = "";
    layers.forEach((l, li) => {
        const row = document.createElement("div");
        row.className = "lrow" + (li === layerIdx ? " active" : "");
        row.innerHTML = `<button class="eye"></button><button class="lock"></button><span></span>`;
        const [eye, lock] = row.querySelectorAll("button");
        eye.textContent = l.hidden ? "–" : "👁";
        eye.title = eye.ariaLabel = l.hidden ? "Show layer" : "Hide layer";
        lock.textContent = l.locked ? "🔒" : "·";
        lock.title = lock.ariaLabel = l.locked ? "Unlock layer" : "Lock layer";
        eye.onclick = e => { e.stopPropagation(); l.hidden = !l.hidden; done(); };
        lock.onclick = e => { e.stopPropagation(); l.locked = !l.locked; done(); };
        row.querySelector("span").textContent = l.name;
        row.title = "Double-click to rename";
        row.onclick = () => selectLayer(li);
        row.ondblclick = () => {
            const name = prompt("Layer name", l.name);
            if (name) { l.name = name; done(); }
        };
        list.append(row);
    });

    const grid = $("grid");
    grid.innerHTML = "";
    grid.style.width = n * CW + "px";
    const ruler = document.createElement("div");
    ruler.className = "ruler";
    for (let i = 0; i < n; i++) {
        const c = document.createElement("div");
        c.className = "rc" + (i === current ? " now" : "");
        c.dataset.i = i;
        if (i === 0 || i === current || (i + 1) % 5 === 0) c.textContent = i + 1;
        ruler.append(c);
    }
    grid.append(ruler);

    layers.forEach((l, li) => {
        const row = document.createElement("div"), f = l.frames;
        row.className = "row" + (li === layerIdx ? " active" : "");
        for (let i = 0; i < n; i++) {
            const c = document.createElement("div");
            let cls = "c";
            if (i < f.length) {
                const k = f[i];
                cls += isKey(f, i) ? (k.empty ? " key blank" : " key") : " span";
                if (f[i + 1] !== k) cls += " end";
                if (k.tween) cls += f[endOf(f, i) + 1] ? " tween" : " tween broken";
            }
            if (i % 5 === 4) cls += " five";
            if (li === layerIdx && i === current) cls += " sel";
            c.className = cls;
            c.dataset.i = i;
            c.dataset.l = li;
            row.append(c);
        }
        grid.append(row);
    });

    const ph = document.createElement("div");
    ph.className = "ph";
    ph.style.left = current * CW + CW / 2 + "px";
    grid.append(ph);

    const wrap = $("gridWrap"), x = current * CW;
    if (x < wrap.scrollLeft || x + CW > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = x - wrap.clientWidth / 2;
    $("counter").textContent = `${current + 1} / ${total()}`;
}

function showKeyProps() {
    const k = L().frames[current];
    $("keyProps").disabled = !k;
    if (!k) return;
    const r = v => Math.round(v * 10) / 10;
    $("kx").value = r(k.t.x);
    $("ky").value = r(k.t.y);
    $("ksx").value = r(k.t.sx * 100);
    $("ksy").value = r(k.t.sy * 100);
    $("kr").value = r(k.t.r);
    $("ka").value = r(k.t.a * 100);
    $("ktween").checked = k.tween;
    $("kease").value = k.ease;
}

function done() {
    render();
    drawTimeline();
    showKeyProps();
    sync();
}

function go(i) {
    dropFloat();
    const moved = i !== current;
    current = Math.max(0, i);
    done();
    if (moved) sendCursor();
}

function selectLayer(li) {
    if (li !== layerIdx) {
        dropFloat();
        layerIdx = li;
    }
    done();
}

// ---------- undo / redo ----------
// A snapshot stores the layer structure, every keyframe's properties, and the pixels
// of the one canvas about to be drawn on (if any).

function capture(pix) {
    return {
        layers: layers.map(l => ({ ...l, frames: [...l.frames] })),
        keys: [...new Set(layers.flatMap(l => l.frames))].map(k => [k, { ...k.t }, k.tween, k.ease, k.empty]),
        pix: pix && [pix, pix.getContext("2d").getImageData(0, 0, W, H)],
        current,
        layerIdx,
    };
}

function snapshot(pix) {
    past.push(capture(pix));
    if (pix) pending.add(pix);
    if (past.length > 30) past.shift();
    future = [];
    dirty = unversioned = true;
}

function swap(from, to) {
    const s = from.pop();
    if (!s) return;
    stop();
    float = drag = null;
    to.push(capture(s.pix && s.pix[0]));
    layers = s.layers;
    current = s.current;
    layerIdx = s.layerIdx;
    for (const [k, t, tween, ease, empty] of s.keys) Object.assign(k, { t: { ...t }, tween, ease, empty });
    if (s.pix) {
        s.pix[0].getContext("2d").putImageData(s.pix[1], 0, 0);
        pending.add(s.pix[0]);
    }
    go(current);
}

const undo = () => swap(past, future);
const redo = () => swap(future, past);

// ---------- drawing ----------

function local(e) {
    const r = stage.getBoundingClientRect();
    const X = (e.clientX - r.left) * W / r.width, Y = (e.clientY - r.top) * H / r.height;
    const p = matrix(curT()).inverse().transformPoint(new DOMPoint(X, Y));
    return { x: p.x, y: p.y, X, Y };     // x/y in keyframe space, X/Y in stage space
}

function editable() {
    const l = L();
    if (l.locked || l.hidden) {
        flash(`"${l.name}" is ${l.locked ? "locked" : "hidden"}`);
        return false;
    }
    return true;
}

// The keyframe that drawing at the current frame should go into; extends the layer if needed.
function targetKey() {
    const f = L().frames;
    if (current < f.length) {
        if (isKey(f, current) || !$("autoKey").checked) return f[current];
        // Auto keyframe: editing a later frame of a span splits it off into its own keyframe,
        // starting as a copy of what's shown there.
        const src = f[current], k = copyKey(src);
        Object.assign(k, { t: { ...transformAt(f, current) }, tween: src.tween, ease: src.ease });
        for (let m = current; f[m] === src; m++) f[m] = k;
        flash(`New keyframe at frame ${current + 1}`);
        return k;
    }
    const last = f[f.length - 1];
    while (f.length < current) f.push(last);
    const k = blank();
    f.push(k);
    return k;
}

function commit(k) {
    k.empty = false;
    done();
}

function style(c) {
    c.strokeStyle = $("stroke").value;
    c.fillStyle = $("fill").value;
    c.lineWidth = +$("size").value;
    c.lineCap = c.lineJoin = "round";
}

function stroke(k, a, b) {
    const c = k.getContext("2d");
    style(c);
    c.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    c.globalCompositeOperation = "source-over";
    render();
}

function shape(c, a, b, constrain) {
    let w = b.x - a.x, h = b.y - a.y;
    if (constrain && tool !== "line") {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = (Math.sign(w) || 1) * s;
        h = (Math.sign(h) || 1) * s;
    }
    style(c);
    c.beginPath();
    if (tool === "line") {
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
    } else if (tool === "rect") {
        c.rect(a.x, a.y, w, h);
    } else {
        c.ellipse(a.x + w / 2, a.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    }
    if (tool !== "line" && $("fillShapes").checked) c.fill();
    c.stroke();
}

function floodFill(k, p) {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const c = k.getContext("2d");
    const img = c.getImageData(0, 0, W, H), d = img.data;
    const seen = new Uint8Array(W * H);
    const hex = $("fill").value;
    const color = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(255);
    const t = d.slice((y * W + x) * 4, (y * W + x) * 4 + 4);
    // ponytail: summed-channel tolerance so antialiased edges get filled; tweak 96 if it leaks or leaves halos
    const near = k => Math.abs(d[k] - t[0]) + Math.abs(d[k + 1] - t[1]) +
                      Math.abs(d[k + 2] - t[2]) + Math.abs(d[k + 3] - t[3]) < 96;

    const stack = [y * W + x];
    while (stack.length) {
        const i = stack.pop();
        if (seen[i] || !near(i * 4)) continue;
        seen[i] = 1;
        d.set(color, i * 4);
        const px = i % W;
        if (px > 0) stack.push(i - 1);
        if (px < W - 1) stack.push(i + 1);
        if (i >= W) stack.push(i - W);
        if (i < W * (H - 1)) stack.push(i + W);
    }
    c.putImageData(img, 0, 0);
}

function addText(p) {
    const text = prompt("Text:");
    if (!text) return;
    snapshot(L().frames[current]);
    const k = targetKey(), c = k.getContext("2d");
    c.font = `${+$("size").value * 3}px system-ui, sans-serif`;
    c.fillStyle = $("stroke").value;
    c.textBaseline = "top";
    c.fillText(text, p.x, p.y);
    commit(k);
}

function pickColor(p, toFill) {
    drawScene(tctx, current, false);
    const d = tctx.getImageData(Math.floor(p.X), Math.floor(p.Y), 1, 1).data;
    const hex = "#" + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, "0")).join("");
    $(toFill ? "fill" : "stroke").value = hex;
    flash(`${toFill ? "Fill" : "Stroke"} set to ${hex}`);
}

function transformDown(p) {
    snapshot();
    const k = targetKey(), t0 = { ...k.t };
    const cx = W / 2 + t0.x, cy = H / 2 + t0.y;
    drag = {
        move(q, e) {
            if (e.shiftKey) {
                k.t.r = t0.r + (Math.atan2(q.Y - cy, q.X - cx) - Math.atan2(p.Y - cy, p.X - cx)) * 180 / Math.PI;
            } else {
                k.t.x = t0.x + q.X - p.X;
                k.t.y = t0.y + q.Y - p.Y;
            }
            render();
            showKeyProps();
        },
        up: done,
    };
}

// ---------- selection / floating objects ----------

function dropFloat() {
    if (!float) return;
    const f = float;
    float = null;
    f.k.getContext("2d").drawImage(f.c, f.x, f.y, f.w, f.h);
    f.k.empty = false;
    pending.add(f.k);
}

function cutFloat(x, y, w, h) {
    x = Math.floor(x);
    y = Math.floor(y);
    w = Math.ceil(w);
    h = Math.ceil(h);
    snapshot(L().frames[current]);
    const k = targetKey();
    const c = canvas(w, h);
    c.getContext("2d").drawImage(k, x, y, w, h, 0, 0, w, h);
    k.getContext("2d").clearRect(x, y, w, h);
    float = { k, c, x, y, w, h, ar: w / h };
    done();
}

// Put an image/canvas on the stage as a floating object, centered and scaled to fit.
function place(src) {
    if (!editable()) return;
    stop();
    setTool("select");
    dropFloat();
    snapshot(L().frames[current]);
    const k = targetKey();
    const c = canvas(src.width, src.height);
    c.getContext("2d").drawImage(src, 0, 0);
    const s = Math.min(1, W * 0.9 / src.width, H * 0.9 / src.height);
    const w = src.width * s, h = src.height * s;
    const mid = matrix(curT()).inverse().transformPoint(new DOMPoint(W / 2, H / 2));
    float = { k, c, x: mid.x - w / 2, y: mid.y - h / 2, w, h, ar: w / h };
    done();
}

function selectDown(p) {
    if (float) {
        const hs = 8 / Math.abs(curT().sx);
        const hit = CORNERS.find(([u, v]) =>
            Math.abs(p.x - (float.x + u * float.w)) < hs && Math.abs(p.y - (float.y + v * float.h)) < hs);
        if (hit) {
            const ox = float.x + (1 - hit[0]) * float.w, oy = float.y + (1 - hit[1]) * float.h;
            drag = {
                move(q, e) {
                    let w = q.x - ox, h = q.y - oy;
                    if (!e.shiftKey) {           // keep aspect ratio unless Shift
                        if (Math.abs(w) / float.ar > Math.abs(h)) h = (Math.sign(h) || 1) * Math.abs(w) / float.ar;
                        else w = (Math.sign(w) || 1) * Math.abs(h) * float.ar;
                    }
                    float.x = Math.min(ox, ox + w);
                    float.y = Math.min(oy, oy + h);
                    float.w = Math.max(1, Math.abs(w));
                    float.h = Math.max(1, Math.abs(h));
                    render();
                },
                up() {},
            };
            return;
        }
        if (p.x >= float.x && p.x <= float.x + float.w && p.y >= float.y && p.y <= float.y + float.h) {
            const dx = p.x - float.x, dy = p.y - float.y;
            drag = { move(q) { float.x = q.x - dx; float.y = q.y - dy; render(); }, up() {} };
            return;
        }
        dropFloat();
        done();
    }
    if (current >= L().frames.length) return;
    drag = {
        move: q => render(c => {
            c.setLineDash([5, 4]);
            c.lineWidth = 1;
            c.strokeStyle = "#000";
            c.strokeRect(p.x, p.y, q.x - p.x, q.y - p.y);
        }),
        up(q) {
            const w = Math.abs(q.x - p.x), h = Math.abs(q.y - p.y);
            if (w > 2 && h > 2) cutFloat(Math.min(p.x, q.x), Math.min(p.y, q.y), w, h);
            else render();
        },
    };
}

function copySel() {
    const k = L().frames[current];
    const src = float || (k && { c: k, w: W, h: H });
    if (!src) return;
    clipboard = canvas(Math.round(src.w), Math.round(src.h));
    clipboard.getContext("2d").drawImage(src.c, 0, 0, clipboard.width, clipboard.height);
    flash(float ? "Copied selection" : "Copied frame");
}

function clearSel() {
    if (!float) return;
    float = null;
    done();
}

function cut() {
    if (!float) return flash("Select something first (V)");
    copySel();
    clearSel();
}

const paste = () => clipboard ? place(clipboard) : flash("Clipboard is empty");

function selectAll() {
    if (!editable() || current >= L().frames.length) return;
    setTool("select");
    dropFloat();
    cutFloat(0, 0, W, H);
}

function deselect() {
    dropFloat();
    done();
}

// ---------- stage pointer ----------

stage.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    document.activeElement.blur();
    stop();
    const p = local(e);
    if (tool === "eyedropper") return pickColor(p, e.shiftKey);
    if (!editable()) return;
    if (tool === "text") return addText(p);
    stage.setPointerCapture(e.pointerId);
    if (tool === "select") return selectDown(p);
    dropFloat();
    if (tool === "transform") return transformDown(p);

    snapshot(L().frames[current]);
    const k = targetKey();
    if (tool === "fill") {
        floodFill(k, p);
        commit(k);
    } else if (tool === "brush" || tool === "eraser") {
        let last = p;
        stroke(k, p, p);
        drag = { move(q) { stroke(k, last, q); last = q; }, up: () => commit(k) };
    } else {
        drag = {
            move: (q, e) => render(c => shape(c, p, q, e.shiftKey)),
            up(q, e) { shape(k.getContext("2d"), p, q, e.shiftKey); commit(k); },
        };
    }
});

stage.addEventListener("pointermove", e => drag && drag.move(local(e), e));

function pointerEnd(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.up(local(e), e);
}
stage.addEventListener("pointerup", pointerEnd);
stage.addEventListener("pointercancel", pointerEnd);

// Ctrl/⌘ + scroll or trackpad pinch: smooth zoom, scaled by how far you scroll.
$("stageWrap").addEventListener("wheel", e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const d = Math.max(-50, Math.min(50, e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
    setZoom(stage.getBoundingClientRect().width / W * Math.exp(-d * 0.004));    // one mouse notch ≈ 18%
}, { passive: false });

// ---------- frames & layers ----------

function frameOp(fn) {
    return () => {
        if (L().locked) return flash(`"${L().name}" is locked`);
        stop();
        dropFloat();
        snapshot();
        fn(L().frames);
        go(current);
    };
}

// F5: extend the span under the playhead (or extend the layer up to it).
function insertFrame(f) {
    if (current < f.length) f.splice(current, 0, f[current]);
    else while (f.length <= current) f.push(f[f.length - 1]);
}

function removeFrame(f) {
    if (current >= f.length) return;
    f.splice(current, 1);
    if (!f.length) f.push(blank());
}

// F6 / F7: new keyframe here (or right after, if already on a keyframe).
function insertKey(f, isBlank) {
    const j = isKey(f, current) ? current + 1 : current;
    const src = f[Math.min(j, f.length) - 1];
    const k = isBlank ? blank() : copyKey(src);
    if (j < f.length && f[j] === f[j - 1]) {
        for (let m = j; f[m] === src; m++) f[m] = k;     // split the span
    } else {
        while (f.length < j) f.push(src);
        f.splice(j, 0, k);
    }
    current = j;
}

// Shift+F6: turn a keyframe back into frames of the previous keyframe.
function clearKey(f) {
    if (current === 0 || !isKey(f, current)) return;
    const k = f[current], prev = f[current - 1];
    for (let m = current; f[m] === k; m++) f[m] = prev;
}

function setTween(on) {
    const f = L().frames, k = f[current];
    if (!k) return;
    snapshot();
    k.tween = on;
    done();
    if (on && !f[endOf(f, current) + 1]) flash("Add a keyframe after this span to finish the tween (F6)");
}

function editKey(fn) {
    const k = L().frames[current];
    if (!k) return;
    snapshot();
    fn(k);
    done();
}

function addLayer() {
    snapshot();
    layers.splice(layerIdx, 0, newLayer("Layer " + (layers.length + 1)));
    go(current);
}

function deleteLayer() {
    if (layers.length === 1) return flash("Can't delete the only layer");
    snapshot();
    dropFloat();
    layers.splice(layerIdx, 1);
    layerIdx = Math.min(layerIdx, layers.length - 1);
    go(current);
}

function moveLayer(d) {
    const j = layerIdx + d;
    if (j < 0 || j >= layers.length) return;
    snapshot();
    [layers[j], layers[layerIdx]] = [layers[layerIdx], layers[j]];
    layerIdx = j;
    done();
}

// ---------- playback ----------

const fps = () => Math.min(60, Math.max(1, +$("fps").value || 12));

function play() {
    if (player) return stop();
    dropFloat();
    if (current >= total() - 1) current = 0;
    $("playBtn").textContent = "⏸";
    $("playBtn").ariaLabel = "Stop";
    player = setInterval(() => {
        if (current + 1 < total()) go(current + 1);
        else if ($("loop").checked) go(0);
        else stop();
    }, 1000 / fps());
    go(current);
}

function stop() {
    if (!player) return;
    clearInterval(player);
    player = null;
    $("playBtn").textContent = "▶";
    $("playBtn").ariaLabel = "Play";
    render();
}

const nav = i => { stop(); go(Math.min(i, total() - 1)); };

// ---------- zoom ----------

const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

function applyZoom() {
    const z = $("zoom").value;
    $("stageWrap").classList.toggle("fit", z === "fit");
    stage.style.width = z === "fit" ? "" : W * z + "px";
    stage.style.height = z === "fit" ? "" : H * z + "px";
}

function setZoom(z) {
    const sel = $("zoom");
    if (z !== "fit") z = Math.min(8, Math.max(0.1, z));
    let opt = [...sel.options].find(o => o.value === String(z));
    if (!opt) {
        opt = $("zoomCustom");
        opt.value = z;
        opt.textContent = Math.round(z * 100) + "%";
        opt.hidden = false;
    }
    sel.value = opt.value;
    applyZoom();
}

function zoomStep(dir) {
    const cur = stage.getBoundingClientRect().width / W;
    const z = dir > 0 ? ZOOMS.find(v => v > cur + 0.01) : [...ZOOMS].reverse().find(v => v < cur - 0.01);
    if (z) setZoom(z);
}

// ---------- library & import ----------

function libItem(name, src) {
    const c = canvas(src.width, src.height);
    c.getContext("2d").drawImage(src, 0, 0);
    const s = Math.min(1, 80 / src.width, 80 / src.height);
    const th = canvas(Math.max(1, src.width * s), Math.max(1, src.height * s));
    th.getContext("2d").drawImage(src, 0, 0, th.width, th.height);
    return { name, c, thumb: th.toDataURL() };
}

function drawLibrary() {
    const box = $("library");
    box.innerHTML = library.length ? "" : '<p class="hint">Import images here, drag them onto the stage, or paste them. Click an item to place it.</p>';
    library.forEach((it, i) => {
        const row = document.createElement("div");
        row.className = "libitem";
        row.innerHTML = `<button class="place" title="Place on stage"><img alt=""><span></span></button><button title="Remove from library" aria-label="Remove from library">✕</button>`;
        row.querySelector("img").src = it.thumb;
        row.querySelector("span").textContent = it.name;
        const [placeBtn, delBtn] = row.querySelectorAll("button");
        placeBtn.onclick = () => place(it.c);
        delBtn.onclick = () => { library.splice(i, 1); drawLibrary(); };
        box.append(row);
    });
}

async function importFiles(files, toStage) {
    for (const file of files) {
        if (file.name.endsWith(".json")) return openProject(file);
        if (!file.type.startsWith("image/")) continue;
        try {
            const it = libItem(file.name, await createImageBitmap(file));
            library.push(it);
            if (toStage) place(it.c);
        } catch {
            flash(`Couldn't read ${file.name}`);
        }
    }
    drawLibrary();
}

let importToStage = true;
function pickImages(toStage) {
    importToStage = toStage;
    $("imgInput").click();
}

$("imgInput").onchange = e => { importFiles([...e.target.files], importToStage); e.target.value = ""; };

const wrap = $("stageWrap");
wrap.addEventListener("dragover", e => { e.preventDefault(); wrap.classList.add("dragover"); });
wrap.addEventListener("dragleave", () => wrap.classList.remove("dragover"));
wrap.addEventListener("drop", e => {
    e.preventDefault();
    wrap.classList.remove("dragover");
    importFiles([...e.dataTransfer.files], true);
});

document.addEventListener("paste", e => {
    if (e.target.matches("input, textarea")) return;
    e.preventDefault();
    const files = [...e.clipboardData.files].filter(f => f.type.startsWith("image/"));
    if (files.length) importFiles(files, true);
    else paste();
});

// ---------- file ----------

function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function reset(newLayers) {
    stop();
    float = drag = null;
    layers = newLayers;
    current = layerIdx = 0;
    past = [];
    future = [];
    dirty = false;
    stage.width = tint.width = W;
    stage.height = tint.height = H;
    applyZoom();
    drawLibrary();
    go(0);
}

function projectData() {
    dropFloat();
    const keys = [...new Set(layers.flatMap(l => l.frames))];
    const index = new Map(keys.map((k, i) => [k, i]));
    const project = {
        version: 2,
        w: W,
        h: H,
        fps: fps(),
        bg: $("bgColor").value,
        library: library.map(it => ({ name: it.name, src: it.c.toDataURL() })),
        keys: keys.map(k => ({ src: k.empty ? null : k.toDataURL(), t: k.t, tween: k.tween, ease: k.ease })),
        layers: layers.map(l => ({ name: l.name, hidden: l.hidden, locked: l.locked, frames: l.frames.map(k => index.get(k)) })),
    };
    return project;
}

function save() {
    const project = projectData();
    download(new Blob([JSON.stringify(project)], { type: "application/json" }), "animation.json");
    dirty = false;
    done();
    saveVersion("Saved to file", false, project);
}

const loadImg = src => new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = src;
});

async function openProject(file) {
    if (dirty && !confirm("Open this project? Unsaved work will be lost.")) return;
    try {
        await loadProject(JSON.parse(await file.text()));
    } catch {
        alert("Couldn't open that file. Is it a Motionly .json project?");
    }
}

async function loadProject(p) {
    const oldW = W, oldH = H;
    try {
        if (p.frames) {             // version 1: a flat list of frames
            p.keys = p.frames.map(src => ({ src }));
            p.layers = [{ name: "Layer 1", frames: p.keys.map((_, i) => i) }];
        }
        W = p.w || 800;
        H = p.h || 500;
        const keys = await Promise.all(p.keys.map(async d => {
            const k = blank();
            if (d.src) {
                k.getContext("2d").drawImage(await loadImg(d.src), 0, 0);
                k.empty = false;
            }
            return Object.assign(k, { t: { ...ID(), ...d.t }, tween: !!d.tween, ease: d.ease || 0 });
        }));
        const ls = p.layers.map(l => ({
            id: uid(), name: l.name, hidden: !!l.hidden, locked: !!l.locked, frames: l.frames.map(i => keys[i]),
        }));
        if (!ls.length || ls.some(l => !l.frames.length || l.frames.some(k => !k))) throw new Error("bad layers");
        library = await Promise.all((p.library || []).map(async d => libItem(d.name, await loadImg(d.src))));
        $("fps").value = p.fps || 12;
        $("bgColor").value = p.bg || "#ffffff";
        reset(ls);
    } catch (e) {
        W = oldW;
        H = oldH;
        throw e;
    }
}

function docDialog(isNew) {
    const d = $("docDlg");
    $("docTitle").textContent = isNew ? "New Document" : "Document Settings";
    $("dW").value = W;
    $("dH").value = H;
    $("dFps").value = fps();
    $("dBg").value = $("bgColor").value;
    d.returnValue = "";
    d.onclose = () => {
        if (d.returnValue !== "ok") return;
        if (isNew && dirty && !confirm("Start a new animation? Unsaved work will be lost.")) return;
        const w = Math.min(4000, Math.max(16, +$("dW").value || W));
        const h = Math.min(4000, Math.max(16, +$("dH").value || H));
        $("fps").value = $("dFps").value;
        $("bgColor").value = $("dBg").value;
        if (isNew) {
            W = w;
            H = h;
            library = [];
            reset([newLayer("Layer 1")]);
        } else if (w !== W || h !== H) {
            resizeDoc(w, h);
        } else {
            render();
        }
    };
    d.showModal();
}

// Changes stage size, keeping artwork anchored top-left. Clears undo history.
function resizeDoc(w, h) {
    dropFloat();
    const keys = [...new Set(layers.flatMap(l => l.frames))];
    W = w;
    H = h;
    const map = new Map(keys.map(k => {
        const n = blank();
        n.getContext("2d").drawImage(k, 0, 0);
        return [k, Object.assign(n, { empty: k.empty, t: k.t, tween: k.tween, ease: k.ease })];
    }));
    reset(layers.map(l => ({ ...l, frames: l.frames.map(k => map.get(k)) })));
}

// ---------- export ----------

function exportPNG() {
    dropFloat();
    const c = canvas();
    drawScene(c.getContext("2d"), current, false);
    c.toBlob(b => download(b, `frame-${current + 1}.png`));
}

function exportSheet() {
    dropFloat();
    const n = total(), cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const sheet = canvas(cols * W, rows * H), sctx = sheet.getContext("2d");
    const tmp = canvas(), tmpCtx = tmp.getContext("2d");
    for (let i = 0; i < n; i++) {
        drawScene(tmpCtx, i, false);
        sctx.drawImage(tmp, (i % cols) * W, Math.floor(i / cols) * H);
    }
    sheet.toBlob(b => b ? download(b, "spritesheet.png") : alert("Sprite sheet is too large for this browser. Try fewer frames or a smaller stage."));
}

async function exportVideo() {
    stop();
    dropFloat();
    const type = ["video/webm", "video/mp4"].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!type) return alert("Your browser can't record video.");
    const out = canvas(), octx = out.getContext("2d");
    const rec = new MediaRecorder(out.captureStream(fps()), { mimeType: type });
    const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => download(new Blob(chunks, { type }), "animation." + type.split("/")[1]);

    flash("Exporting video…");
    rec.start();
    for (let i = 0; i < total(); i++) {
        drawScene(octx, i, false);
        await new Promise(r => setTimeout(r, 1000 / fps()));
    }
    rec.stop();
    flash("Video exported");
}

// ---------- tools ----------

const TOOLS = [
    ["select", "⬉", "Selection — drag to select, drag corners to resize", "V"],
    ["transform", "⤧", "Free Transform — drag to move keyframe, Shift+drag to rotate", "Q"],
    ["brush", "✎", "Brush", "B"],
    ["eraser", "⌫", "Eraser", "E"],
    ["line", "╱", "Line", "L"],
    ["rect", "▭", "Rectangle — Shift for square", "R"],
    ["ellipse", "◯", "Oval — Shift for circle", "O"],
    ["text", "T", "Text", "T"],
    ["fill", "◧", "Paint Bucket", "K"],
    ["eyedropper", "⌖", "Eyedropper — Shift-click picks fill", "I"],
];
const CURSORS = { select: "default", transform: "move", text: "text" };

function setTool(t) {
    if (t !== "select" && float) deselect();
    tool = t;
    stage.style.cursor = CURSORS[t] || "crosshair";
    document.querySelectorAll("#tools button").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
}

for (const [id, icon, name, key] of TOOLS) {
    const b = document.createElement("button");
    b.dataset.tool = id;
    b.textContent = icon;
    b.title = `${name} (${key})`;
    b.ariaLabel = name;
    b.onclick = () => setTool(id);
    $("tools").append(b);
}

// ---------- menus & shortcuts ----------

const check = id => $(id).checked ? "✓ " : "";
const toggle = id => { $(id).checked = !$(id).checked; render(); };

const frameItems = [
    ["Insert Frame", "F5", frameOp(insertFrame)],
    ["Remove Frame", "Shift+F5", frameOp(removeFrame)],
    ["Insert Keyframe", "F6", frameOp(f => insertKey(f, false))],
    ["Insert Blank Keyframe", "F7", frameOp(f => insertKey(f, true))],
    ["Clear Keyframe", "Shift+F6", frameOp(clearKey)],
    "-",
    ["Create Classic Tween", "", () => setTween(true)],
    ["Remove Tween", "", () => setTween(false)],
];

const menus = {
    File: [
        ["New…", "", () => docDialog(true)],
        ["Open…", "Mod+O", () => $("fileInput").click()],
        ["Save", "Mod+S", save],
        "-",
        ["Import to Stage…", "", () => pickImages(true)],
        ["Import to Library…", "", () => pickImages(false)],
        "-",
        ["Export Video", "", exportVideo],
        ["Export Frame as PNG", "", exportPNG],
        ["Export Sprite Sheet", "", exportSheet],
    ],
    Edit: [
        ["Undo", "Mod+Z", undo],
        ["Redo", "Mod+Shift+Z", redo],
        "-",
        ["Cut", "Mod+X", cut],
        ["Copy", "Mod+C", copySel],
        ["Paste", "Mod+V", paste],
        ["Clear", "Delete", clearSel],
        "-",
        ["Select All", "Mod+A", selectAll],
        ["Deselect", "Escape", deselect],
    ],
    Insert: [
        ["New Layer", "", addLayer],
        ["Delete Layer", "", deleteLayer],
        "-",
        ...frameItems,
    ],
    Modify: [
        ["Document…", "", () => docDialog(false)],
        "-",
        ["Flip Horizontal", "", () => editKey(k => k.t.sx *= -1)],
        ["Flip Vertical", "", () => editKey(k => k.t.sy *= -1)],
        ["Reset Transform", "", () => editKey(k => k.t = ID())],
    ],
    View: [
        ["Zoom In", "Mod+=", () => zoomStep(1)],
        ["Zoom Out", "Mod+-", () => zoomStep(-1)],
        ["Fit Stage", "Mod+0", () => setZoom("fit")],
        ["100%", "Mod+1", () => setZoom(1)],
        "-",
        [() => check("onion") + "Onion Skin", "", () => toggle("onion")],
    ],
    Control: [
        ["Play / Stop", "Enter", play],
        ["Test Movie", "Mod+Enter", play],
        "-",
        ["First Frame", "Home", () => nav(0)],
        ["Previous Frame", ",", () => nav(current - 1)],
        ["Next Frame", ".", () => nav(current + 1)],
        ["Last Frame", "End", () => nav(total() - 1)],
        "-",
        [() => check("loop") + "Loop Playback", "", () => toggle("loop")],
    ],
};

const pretty = key => key.replace("Mod+", isMac ? "⌘" : "Ctrl+").replace("Shift+", isMac ? "⇧" : "Shift+");
const menuEl = $("menu");
let openTop = null;

function showMenu(items, x, y, top) {
    menuEl.innerHTML = "";
    for (const it of items) {
        if (it === "-") {
            menuEl.append(document.createElement("hr"));
            continue;
        }
        const [label, key, fn] = it;
        const b = document.createElement("button");
        b.innerHTML = "<span></span><kbd></kbd>";
        b.firstChild.textContent = typeof label === "function" ? label() : label;
        b.lastChild.textContent = pretty(key);
        b.onclick = () => { hideMenu(); fn(); };
        menuEl.append(b);
    }
    menuEl.hidden = false;
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(0, Math.min(x, innerWidth - r.width - 4)) + "px";
    menuEl.style.top = Math.max(0, Math.min(y, innerHeight - r.height - 4)) + "px";
    document.querySelectorAll(".top").forEach(t => t.classList.toggle("open", t === top));
    openTop = top;
}

function hideMenu() {
    menuEl.hidden = true;
    document.querySelectorAll(".top").forEach(t => t.classList.remove("open"));
    openTop = null;
}

for (const [name, items] of Object.entries(menus)) {
    const b = document.createElement("button");
    b.className = "top";
    b.textContent = name;
    const open = () => { const r = b.getBoundingClientRect(); showMenu(items, r.left, r.bottom, b); };
    b.onclick = () => openTop === b ? hideMenu() : open();
    b.onmouseenter = () => openTop && openTop !== b && open();
    $("menus").append(b);
}

document.addEventListener("pointerdown", e => {
    if (!menuEl.contains(e.target) && !e.target.closest(".top")) hideMenu();
});

const keymap = {};
for (const items of Object.values(menus)) {
    for (const it of items) if (it !== "-" && it[1]) keymap[it[1]] = it[2];
}
delete keymap["Mod+V"];                  // handled by the paste event so images from other apps work
keymap["Mod+Y"] = redo;
keymap["Backspace"] = clearSel;
for (const [id, , , key] of TOOLS) keymap[key] = () => setTool(id);

document.addEventListener("keydown", e => {
    if (document.querySelector("dialog[open]")) return;
    if (e.target.matches("input:not([type=checkbox]):not([type=color]), select, textarea")) return;
    if (e.target.matches("button") && (e.key === "Enter" || e.key === " ")) return;
    const mod = e.ctrlKey || e.metaKey;

    if (e.key.startsWith("Arrow") && !mod) {    // nudge selection, or keyframe with Free Transform
        const d = e.shiftKey ? 10 : 1;
        const dx = { ArrowLeft: -d, ArrowRight: d }[e.key] || 0, dy = { ArrowUp: -d, ArrowDown: d }[e.key] || 0;
        if (float) {
            float.x += dx;
            float.y += dy;
            render();
        } else if (tool === "transform" && !L().locked) {
            editKey(k => { k.t.x += dx; k.t.y += dy; });
        } else return;
        e.preventDefault();
        return;
    }

    const key = e.key === "+" ? "=" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const id = (mod ? "Mod+" : "") + (e.shiftKey ? "Shift+" : "") + key;
    const fn = keymap[id];
    if (!fn || e.altKey) return;
    e.preventDefault();
    hideMenu();
    fn();
});

// ---------- panel wiring ----------

document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
    document.querySelectorAll(".tab").forEach(o => {
        o.classList.toggle("active", o === t);
        $(o.dataset.tab).hidden = o !== t;
    });
});

$("keyProps").onchange = () => editKey(k => {
    k.t = {
        x: +$("kx").value || 0,
        y: +$("ky").value || 0,
        sx: (+$("ksx").value || 100) / 100,
        sy: (+$("ksy").value || 100) / 100,
        r: +$("kr").value || 0,
        a: Math.min(100, Math.max(0, +$("ka").value)) / 100,
    };
    k.tween = $("ktween").checked;
    k.ease = Math.min(100, Math.max(-100, +$("kease").value || 0));
});

$("size").oninput = () => $("sizeOut").textContent = $("size").value;
$("bgColor").oninput = () => render();
$("bgColor").onchange = sync;
$("onion").onchange = () => render();
$("fps").onchange = () => { sync(); if (player) { stop(); play(); } };
$("zoom").onchange = applyZoom;
$("fileInput").onchange = e => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ""; };
$("importLibBtn").onclick = () => pickImages(false);

$("firstBtn").onclick = () => nav(0);
$("prevBtn").onclick = () => nav(current - 1);
$("playBtn").onclick = play;
$("nextBtn").onclick = () => nav(current + 1);
$("lastBtn").onclick = () => nav(total() - 1);
$("addLayerBtn").onclick = addLayer;
$("delLayerBtn").onclick = deleteLayer;
$("upBtn").onclick = () => moveLayer(-1);
$("downBtn").onclick = () => moveLayer(1);

function cellAt(e) {
    const c = e.target.closest("[data-i]");
    if (!c) return false;
    stop();
    if (c.dataset.l) layerIdx = +c.dataset.l;
    go(+c.dataset.i);
    return true;
}

$("grid").onclick = cellAt;
$("grid").oncontextmenu = e => {
    e.preventDefault();
    if (cellAt(e)) showMenu(frameItems, e.clientX, e.clientY);
};
stage.oncontextmenu = e => {
    e.preventDefault();
    showMenu(menus.Edit, e.clientX, e.clientY);
};

addEventListener("beforeunload", e => { if (dirty) e.preventDefault(); });

// ---------- multiplayer ----------
// Changes are sent as deltas: only the document settings, layers and keyframes whose JSON
// differs from what peers already have, plus PNGs of keyframes whose pixels changed.
// So people editing different layers or keyframes at the same time don't overwrite each other.
// The host relays every change to all guests, and echoes structural changes back to the
// sender too, so everyone ends up applying conflicting edits in the host's order.
// ponytail: pixels are last write wins per keyframe, so two people drawing on the same keyframe
// at the same moment can lose a stroke. Undo is local and can revert others' edits.

let net = null;                      // { peer, conns, host, code, ready }
let applying = Promise.resolve();
const known = new Set();             // keyframe ids whose pixels every peer already has
const pending = new Set();           // keyframe canvases whose pixels changed since the last sync
const sent = { doc: "", layers: new Map(), keys: new Map() };    // JSON every peer already has

const docJSON = () => JSON.stringify({ w: W, h: H, fps: fps(), bg: $("bgColor").value, order: layers.map(l => l.id) });
const layerJSON = l => JSON.stringify({ name: l.name, hidden: l.hidden, locked: l.locked, frames: l.frames.map(k => k.id) });
const keyJSON = k => JSON.stringify({ t: k.t, tween: k.tween, ease: k.ease });
const isEmpty = o => !Object.keys(o).length;

function delta(all) {
    const m = { layers: {}, keys: {}, pix: {} };
    const doc = docJSON();
    if (all || doc !== sent.doc) m.doc = sent.doc = doc;
    for (const l of layers) {
        const j = layerJSON(l);
        if (all || j !== sent.layers.get(l.id)) sent.layers.set(l.id, m.layers[l.id] = j);
    }
    for (const k of new Set(layers.flatMap(l => l.frames))) {
        const j = keyJSON(k);
        if (all || j !== sent.keys.get(k.id)) sent.keys.set(k.id, m.keys[k.id] = j);
        if (!k.empty && (all || pending.has(k) || !known.has(k.id))) {
            m.pix[k.id] = k.toDataURL();
            known.add(k.id);
        }
    }
    pending.clear();
    return m;
}

function broadcast(m, except) {
    for (const c of net.conns) if (c !== except && c.open) c.send(m);
}

function sync() {
    if (!net || !net.conns.length) return pending.clear();
    const m = delta(false);
    if (m.doc || !isEmpty(m.layers) || !isEmpty(m.keys) || !isEmpty(m.pix)) broadcast(m);
}

function receive(m, from) {
    if (m.from) {                        // cursor
        if (net.host) broadcast(m, from);
        return showCursor(m);
    }
    if (net.host) {
        broadcast(m, from);
        if (m.doc || !isEmpty(m.layers) || !isEmpty(m.keys)) from.send({ ...m, pix: {} });     // echo, see above
    }
    applying = applying.then(() => applyState(m)).catch(() => flash("Couldn't apply a change from another user"));
}

async function applyState(m) {
    const imgs = await Promise.all(Object.entries(m.pix).map(async ([id, src]) => [id, await loadImg(src)]));
    if (m.full) {
        past = [];
        future = [];
        float = drag = null;
        pending.clear();
        dirty = false;
    }
    const doc = m.doc && JSON.parse(m.doc);
    if (doc && (doc.w !== W || doc.h !== H)) {
        W = doc.w;
        H = doc.h;
        stage.width = tint.width = W;
        stage.height = tint.height = H;
        float = null;
        applyZoom();
    }

    const keyMap = new Map();
    for (const ls of [layers, ...past.map(h => h.layers), ...future.map(h => h.layers)]) {
        for (const l of ls) for (const k of l.frames) keyMap.set(k.id, k);
    }
    for (const [id, j] of Object.entries(m.keys)) {
        let k = keyMap.get(id);
        if (!k || k.width !== W || k.height !== H) keyMap.set(id, k = Object.assign(blank(), { id }));
        const d = JSON.parse(j);
        Object.assign(k, { t: d.t, tween: d.tween, ease: d.ease });
        sent.keys.set(id, j);
    }
    for (const [id, img] of imgs) {
        const k = keyMap.get(id);
        if (!k) continue;
        const c = k.getContext("2d");
        c.clearRect(0, 0, W, H);
        c.drawImage(img, 0, 0);
        k.empty = false;
        known.add(id);
    }

    const layerMap = new Map(layers.map(l => [l.id, l]));
    for (const [id, j] of Object.entries(m.layers)) {
        const d = JSON.parse(j), frames = d.frames.map(kid => keyMap.get(kid));
        if (frames.some(k => !k)) continue;
        const l = layerMap.get(id) || { id };
        layerMap.set(id, Object.assign(l, { name: d.name, hidden: d.hidden, locked: d.locked, frames }));
        sent.layers.set(id, j);
    }
    if (doc) {
        const order = doc.order.map(id => layerMap.get(id)).filter(Boolean);
        if (order.length) layers = order;
        $("fps").value = doc.fps;
        $("bgColor").value = doc.bg;
        sent.doc = m.doc;
    }
    layerIdx = Math.min(layerIdx, layers.length - 1);
    done();
}

function newPeer(id) {
    if (!window.Peer) {
        alert("Couldn't load the multiplayer library. Check your internet connection.");
        return null;
    }
    const peer = new Peer(id);
    peer.on("error", e => {
        alert(e.type === "peer-unavailable" ? "No session found with that code."
            : e.type === "unavailable-id" ? "That code is already in use. Try hosting again."
            : "Connection problem: " + e.message);
        leave();
    });
    return peer;
}

function hostSession() {
    const code = Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");
    const peer = newPeer("motionly-" + code);
    if (!peer) return;
    net = { peer, conns: [], host: true, code, ready: false };
    peer.on("open", () => { net.ready = true; showShare(); });
    peer.on("connection", c => {
        c.on("open", () => {
            net.conns.push(c);
            c.send({ ...delta(true), full: true });
            flash("Someone joined");
            showShare();
        });
        c.on("data", m => receive(m, c));
        c.on("close", () => {
            if (!net) return;
            net.conns = net.conns.filter(o => o !== c);
            const gone = { from: c.peer, cursor: null };
            showCursor(gone);
            broadcast(gone);
            flash("Someone left");
            showShare();
        });
    });
    showShare();
}

function joinSession(code) {
    code = code.trim().toUpperCase();
    if (!code) return;
    if (dirty && !confirm("Joining replaces your current animation with the shared one. Continue?")) return;
    const peer = newPeer();
    if (!peer) return;
    net = { peer, conns: [], host: false, code, ready: false };
    peer.on("open", () => {
        const c = peer.connect("motionly-" + code, { reliable: true });
        c.on("open", () => {
            net.conns.push(c);
            net.ready = true;
            flash("Joined session " + code);
            showShare();
        });
        c.on("data", m => receive(m, c));
        c.on("close", () => {
            if (net) flash("Disconnected from the session");
            leave();
        });
    });
    showShare();
}

function leave() {
    if (!net) return;
    const n = net;
    net = null;
    n.peer.destroy();
    known.clear();
    sent.doc = "";
    sent.layers.clear();
    sent.keys.clear();
    for (const c of cursors.values()) c.el.remove();
    cursors.clear();
    showShare();
}

function showShare() {
    $("netOff").hidden = !!net;
    $("netOn").hidden = !net;
    $("shareBtn").classList.toggle("live", !!net && net.ready);
    if (!net) {
        $("shareBtn").textContent = "Share";
        return;
    }
    const people = net.conns.length;
    $("shareBtn").textContent = !net.ready ? "Connecting…" : net.host ? `● Live · ${people + 1}` : "● Live";
    $("codeOut").textContent = net.code;
    $("netInfo").textContent = !net.ready ? "Connecting…"
        : net.host ? `${people} ${people === 1 ? "person has" : "people have"} joined. Send the code to invite others.`
        : "Connected. Edits sync live.";
}

$("shareBtn").onclick = () => { showShare(); $("shareDlg").showModal(); };
$("hostBtn").onclick = hostSession;
$("joinBtn").onclick = () => joinSession($("joinCode").value);
$("joinCode").onkeydown = e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    joinSession($("joinCode").value);
};
$("copyCodeBtn").onclick = () => navigator.clipboard.writeText(net.code).then(() => flash("Code copied"));
$("leaveBtn").onclick = leave;
addEventListener("pagehide", leave);

// ---------- live cursors ----------

const cursors = new Map();           // peer id -> { el, x, y, f }
let myPos = null, lastCursorSent = 0;

function myName() {
    return $("myName").value.trim() || "Guest";
}

function colorOf(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 80% 55%)`;
}

function sendCursor() {
    if (!net || !net.conns.length) return;
    broadcast({ from: net.peer.id, name: myName(), cursor: myPos && { x: myPos.X, y: myPos.Y, f: current } });
}

function showCursor(m) {
    let c = cursors.get(m.from);
    if (!m.cursor) {
        if (c) c.el.remove();
        cursors.delete(m.from);
        return;
    }
    if (!c) {
        const el = document.createElement("div");
        el.className = "cursor";
        el.style.color = colorOf(m.from);
        el.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 1l13 7-6 1.5L6 16z" fill="currentColor" stroke="#fff" stroke-width="1.2"/></svg><span></span>`;
        document.body.append(el);
        cursors.set(m.from, c = { el });
    }
    Object.assign(c, m.cursor);
    c.el.lastChild.textContent = `${m.name} · F${m.cursor.f + 1}`;
    c.el.lastChild.style.background = colorOf(m.from);
    placeCursors();
}

function placeCursors() {
    if (!cursors.size) return;
    const r = stage.getBoundingClientRect();
    for (const c of cursors.values()) {
        c.el.style.transform = `translate(${r.left + c.x * r.width / W}px, ${r.top + c.y * r.height / H}px)`;
        c.el.classList.toggle("away", c.f !== current);     // dimmed when they're on another frame
    }
}

stage.addEventListener("pointermove", e => {
    myPos = local(e);
    if (Date.now() - lastCursorSent < 40) return;     // ~25 updates a second
    lastCursorSent = Date.now();
    sendCursor();
});
stage.addEventListener("pointerleave", () => { myPos = null; sendCursor(); });
$("stageWrap").addEventListener("scroll", placeCursors);
addEventListener("resize", placeCursors);

try { $("myName").value = localStorage.getItem("motionly-name") || ""; } catch {}
if (!$("myName").value) $("myName").value = "Guest " + Math.floor(Math.random() * 90 + 10);
$("myName").onchange = () => {
    try { localStorage.setItem("motionly-name", myName()); } catch {}
    sendCursor();
};

// ---------- version history ----------
// Versions are stored in this browser (IndexedDB), so they survive reloads but aren't shared.
// Metadata and thumbnails are kept apart from the full project data so listing stays cheap.

const db = new Promise((ok, fail) => {
    const r = indexedDB.open("motionly", 1);
    r.onupgradeneeded = () => {
        r.result.createObjectStore("meta", { keyPath: "id", autoIncrement: true });
        r.result.createObjectStore("data");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
});

async function idb(mode, fn) {
    const tx = (await db).transaction(["meta", "data"], mode);
    const req = fn(tx);
    return new Promise((ok, fail) => {
        tx.oncomplete = () => ok(req && req.result);
        tx.onerror = tx.onabort = () => fail(tx.error);
    });
}

async function saveVersion(name, auto = false, data = projectData()) {
    const full = canvas(), th = canvas(160, Math.max(1, Math.round(160 * H / W)));
    drawScene(full.getContext("2d"), current, false);
    th.getContext("2d").drawImage(full, 0, 0, th.width, th.height);
    const meta = { name, auto, time: Date.now(), thumb: th.toDataURL("image/jpeg", 0.7), frames: total(), layers: layers.length };
    try {
        await idb("readwrite", tx => {
            const r = tx.objectStore("meta").add(meta);
            r.onsuccess = () => tx.objectStore("data").put(data, r.result);
            return r;
        });
        unversioned = false;
        const autos = (await idb("readonly", tx => tx.objectStore("meta").getAll())).filter(v => v.auto);
        for (const v of autos.slice(0, -30)) await deleteVersion(v.id);     // keep the 30 newest autosaves
        drawVersions();
    } catch {
        flash("Couldn't save version (browser storage may be full)");
    }
}

const deleteVersion = id => idb("readwrite", tx => {
    tx.objectStore("meta").delete(id);
    tx.objectStore("data").delete(id);
});

async function restoreVersion(v) {
    if (!confirm(`Restore "${v.name}"? Your current work will be saved as a version first.`)) return;
    stop();
    await saveVersion(`Before restoring "${v.name}"`, true);
    try {
        await loadProject(await idb("readonly", tx => tx.objectStore("data").get(v.id)));
        flash(`Restored "${v.name}"`);
    } catch {
        alert("Couldn't restore that version.");
    }
}

async function drawVersions() {
    const box = $("versions");
    let list = [];
    try { list = await idb("readonly", tx => tx.objectStore("meta").getAll()); } catch {}
    box.innerHTML = list.length ? "" : '<p class="hint">No versions yet.</p>';
    for (const v of list.reverse()) {
        const row = document.createElement("div");
        row.className = "version" + (v.auto ? " auto" : "");
        row.innerHTML = `<img alt=""><div><strong></strong><small></small></div><button>Restore</button><button title="Delete version" aria-label="Delete version">✕</button>`;
        row.querySelector("img").src = v.thumb;
        row.querySelector("strong").textContent = v.name;
        row.querySelector("small").textContent = `${new Date(v.time).toLocaleString()} · ${v.frames} frames`;
        const [restoreBtn, delBtn] = row.querySelectorAll("button");
        restoreBtn.onclick = () => restoreVersion(v);
        delBtn.onclick = async () => {
            if (!confirm(`Delete "${v.name}"?`)) return;
            await deleteVersion(v.id);
            drawVersions();
        };
        box.append(row);
    }
}

$("saveVersionBtn").onclick = () => {
    const name = prompt("Name this version:", "Version " + new Date().toLocaleTimeString());
    if (name) saveVersion(name);
};
setInterval(() => { if (unversioned && !float && !drag) saveVersion("Autosave", true); }, 5 * 60 * 1000);
drawVersions();

setTool("brush");
reset([newLayer("Layer 1")]);
