(function (exports, patcher, metro, utils, assets, toasts, ui) {
  "use strict";

  const { before, after } = patcher;
  const { findByProps, findByStoreName } = metro;
  const { findInReactTree } = utils;
  const { getAssetIDByName } = assets;
  const { showToast } = toasts;
  const { Forms } = ui.components ?? {};

  // Same way the AutoReact plugin resolves things: through the metro registry.
  const React = findByProps("createElement", "useState");
  const RN = findByProps("View", "Text", "StyleSheet");
  const TokenStore = findByStoreName("UserAuthTokenStore") || findByStoreName("AuthenticationStore");
  const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
  const Clipboard = RN.Clipboard ?? findByProps("setString")?.Clipboard ?? findByProps("setString");

  const APP = "http://127.0.0.1:38417";          // the PS4 Save Tool app's local bridge
  const API_BASE = "https://discord.com/api/v9";
  const TASKS = [
    { op: "resign", label: "Resign & reply" },
    { op: "decrypt", label: "Decrypt & reply" },
    { op: "encrypt", label: "Encrypt & reply" },
    { op: "encrypt_keep_psn", label: "Encrypt (keep PSN) & reply" },
    { op: "sfo", label: "Read param.sfo & reply" },
    { op: "reregion", label: "Reregion & reply" },
    { op: "qc", label: "Quick codes & reply" },
  ];

  let unpatchSheet = null;
  const busy = new Set();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getToken() {
    const ts = TokenStore;
    return ts.getToken ? ts.getToken() : ts.token;
  }

  function attachmentUrls(message) {
    return (message?.attachments ?? []).map((a) => a?.url).filter((u) => typeof u === "string" && u.startsWith("http"));
  }

  function deepLink(kind, urls, extra) {
    const q = urls.map((u) => "u=" + encodeURIComponent(u)).join("&");
    return `ps4savetool://${kind}?${q}${extra ? "&" + extra : ""}`;
  }

  async function openApp(link, urls) {
    try {
      await RN.Linking.openURL(link);
      return true;
    } catch (e) {
      try { Clipboard.setString(urls.join("\n")); } catch (_) {}
      showToast("PS4 Save Tool not found. Links copied");
      return false;
    }
  }

  // ---- helpers: React Native can't read Blobs as ArrayBuffer, so go through base64.
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_LOOKUP = (() => { const m = new Uint8Array(256); for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; return m; })();

  function base64ToBytes(b64) {
    let len = b64.length;
    while (len > 0 && (b64.charCodeAt(len - 1) === 61 || b64.charCodeAt(len - 1) < 33)) len--;
    const out = new Uint8Array(Math.floor((len * 3) / 4));
    let o = 0, i = 0;
    for (; i + 3 < len; i += 4) {
      const n = (B64_LOOKUP[b64.charCodeAt(i)] << 18) | (B64_LOOKUP[b64.charCodeAt(i + 1)] << 12) |
                (B64_LOOKUP[b64.charCodeAt(i + 2)] << 6) | B64_LOOKUP[b64.charCodeAt(i + 3)];
      out[o++] = n >> 16; out[o++] = (n >> 8) & 255; out[o++] = n & 255;
    }
    const rest = len - i;
    if (rest === 2) {
      const n = (B64_LOOKUP[b64.charCodeAt(i)] << 18) | (B64_LOOKUP[b64.charCodeAt(i + 1)] << 12);
      out[o++] = n >> 16;
    } else if (rest === 3) {
      const n = (B64_LOOKUP[b64.charCodeAt(i)] << 18) | (B64_LOOKUP[b64.charCodeAt(i + 1)] << 12) | (B64_LOOKUP[b64.charCodeAt(i + 2)] << 6);
      out[o++] = n >> 16; out[o++] = (n >> 8) & 255;
    }
    return out.subarray(0, o);
  }

  function blobToBytes(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error("couldn't read the downloaded file"));
      fr.onload = () => {
        const s = String(fr.result);
        resolve(base64ToBytes(s.slice(s.indexOf(",") + 1)));
      };
      fr.readAsDataURL(blob);
    });
  }

  function utf8(s) {
    const bin = unescape(encodeURIComponent(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  const LAST_UP = { size: 0, read: 0, post: 0, fast: "" };

  async function postReply(message, content, blob, filename) {
    const fname = filename || "result.zip";
    const type = /\.txt$/i.test(fname) ? "text/plain" : "application/zip";
    const payload = JSON.stringify({
      content,
      message_reference: { message_id: message.id, channel_id: message.channel_id, fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
    });
    const url = `${API_BASE}/channels/${message.channel_id}/messages`;
    const errors = [];

    // Fast path: FormData with the Blob (sent natively, no byte copying in JS). The reply's attachment size is
    // checked against the real size; on a mismatch the message is deleted and the slow, exact path is used.
    try {
      const tP0 = Date.now();
      const form = new FormData();
      form.append("payload_json", payload);
      let file = blob;
      try { file = new Blob([blob], { type }); } catch (_) {}
      try { file.name = fname; } catch (_) {}
      form.append("files[0]", file);
      const res = await fetch(url, { method: "POST", headers: { Authorization: getToken() }, body: form });
      LAST_UP.post = Date.now() - tP0; LAST_UP.read = 0; LAST_UP.size = blob.size || 0;
      const t = await res.text();
      if (res.ok) {
        let m = null; try { m = JSON.parse(t); } catch (_) {}
        const got = m?.attachments?.[0]?.size;
        if (got && blob.size && got === blob.size) return;
        try { await fetch(`${url}/${m?.id}`, { method: "DELETE", headers: { Authorization: getToken() } }); } catch (_) {}
        throw new Error(`size mismatch (${got} vs ${blob.size})`);
      }
      throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
    } catch (e) {
      errors.push("formdata: " + (e?.message ?? e));
      LAST_UP.fast = String(e?.message ?? e).slice(0, 80);
    }

    // Exact path: build the multipart body by hand (works without Blob support in FormData).
    try {
      const tR0 = Date.now();
      const bytes = await blobToBytes(blob);
      LAST_UP.size = bytes.length; LAST_UP.read = Date.now() - tR0;
      const boundary = "----ps4st" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const body = concat([
        utf8(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${payload}\r\n`),
        utf8(`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${fname}"\r\nContent-Type: ${type}\r\n\r\n`),
        bytes,
        utf8(`\r\n--${boundary}--\r\n`),
      ]);
      const tP0 = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: getToken(), "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
      });
      LAST_UP.post = Date.now() - tP0;
      if (res.ok) return;
      let t = ""; try { t = await res.text(); } catch (_) {}
      throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
    } catch (e) {
      errors.push("manual: " + (e?.message ?? e));
    }

    throw new Error("upload failed. " + errors.join(" | "));
  }

  // Show a short toast AND copy the full error to the clipboard (toasts vanish too fast).
  function reportError(stage, e) {
    const full = `PS4 Save Tool [${stage}]: ${e?.message ?? e}${e?.stack ? "\n" + String(e.stack).slice(0, 700) : ""}`;
    try { Clipboard.setString(full); } catch (_) {}
    showToast(`PS4 Save Tool error (${stage}). Full text copied to clipboard`);
  }

  async function runTask(message, task) {
    const urls = attachmentUrls(message);
    if (!urls.length) return showToast("This message has no attachments");
    if (busy.has(message.id)) return showToast("Already working on this message");
    busy.add(message.id);
    let stage = "open";
    const T0 = Date.now();
    let tApp = 0, tDl = 0;
    try {
      const job = Math.random().toString(36).slice(2) + Date.now().toString(36);
      showToast(`${task.label.replace(" & reply", "")}: opening PS4 Save Tool…`);
      if (!(await openApp(deepLink("run", urls, `op=${task.op}&job=${job}`), urls))) return;

      stage = "poll";
      // The app does the work, then returns to Discord. Poll its local bridge for the result.
      const started = Date.now();
      let state = null, reached = false, misses = 0;
      while (Date.now() - started < 10 * 60 * 1000) {
        await sleep(700);
        try {
          const r = await fetch(`${APP}/status?id=${job}`);
          if (r.ok) {
            reached = true;
            state = await r.json();
            if (state.state !== "running") break;
          }
        } catch (e) {
          misses++;
          if (!reached && misses > 20) {
            showToast("Can't reach the app from Discord. Open the tool in the app and save the files");
            return;
          }
        }
      }
      if (!state || state.state === "running") return showToast("PS4 Save Tool took too long");
      if (state.state === "error") return showToast("PS4 Save Tool: " + state.error);

      tApp = Date.now();
      stage = "download";
      const fr = await fetch(`${APP}/file?id=${job}`);
      if (!fr.ok) {
        let body = "";
        try { body = await fr.text(); } catch (_) {}
        throw new Error(`couldn't get the result from the app (HTTP ${fr.status}: ${body.slice(0, 120)})`);
      }
      const blob = await fr.blob();
      tDl = Date.now();
      stage = "upload";
      await postReply(message, `**${task.label.replace(" & reply", "")}**\n${String(state.summary || "Done")}`.slice(0, 1900), blob, state.name);
      const sec = (a, b) => ((b - a) / 1000).toFixed(1) + "s";
      showToast(`Replied with the finished files (app ${sec(T0, tApp)}, download ${sec(tApp, tDl)}, upload ${sec(tDl, Date.now())}: read ${(LAST_UP.read / 1000).toFixed(1)}s, send ${(LAST_UP.post / 1000).toFixed(1)}s, ${Math.round(LAST_UP.size / 1024)} KB${LAST_UP.fast ? "; fast path failed: " + LAST_UP.fast : ""})`);
    } catch (e) {
      reportError(stage, e);
    } finally {
      busy.delete(message.id);
    }
  }

  function makeRow(label, iconName, onPress, key) {
    const icon = getAssetIDByName(iconName) ?? getAssetIDByName("ic_link");
    if (!Forms?.FormRow) return null;
    return React.createElement(Forms.FormRow, {
      key, label,
      leading: React.createElement(Forms.FormRow.Icon, { source: icon }),
      onPress,
    });
  }

  function onLoad() {
    unpatchSheet = before("openLazy", LazyActionSheet, ([component, sheetKey, props]) => {
      const message = props?.message;
      if (sheetKey !== "MessageLongPressActionSheet" || !message) return;
      if (!attachmentUrls(message).length) return;

      component.then((instance) => {
        const unpatch = after("default", instance, (_, tree) => {
          React.useEffect(() => () => { unpatch(); }, []);
          const rows = findInReactTree(tree, (x) => Array.isArray(x) && x.length && x[0]?.type?.name === "ButtonRow")
                    ?? findInReactTree(tree, (x) => Array.isArray(x) && x.length && x[0]?.props?.label);
          if (!rows) return;
          const hide = () => LazyActionSheet.hideActionSheet();
          const extra = [];
          // forEach gives every row its own copy of the task (a plain loop variable got shared).
          TASKS.forEach(function (task) {
            const op = task.op;
            const label = task.label;
            extra.push(makeRow("PS4: " + label, "ic_share_ios", function () { hide(); runTask(message, { op: op, label: label }); }, "ps4st-" + op));
          });
          extra.push(makeRow("PS4: open in app (more tools)", "ic_link", () => {
            hide();
            const urls = attachmentUrls(message);
            openApp(deepLink("open", urls), urls);
          }, "ps4st-open"));
          extra.push(makeRow("PS4: copy file links", "ic_link", () => {
            hide();
            const urls = attachmentUrls(message);
            Clipboard.setString(urls.join("\n"));
            showToast(`Copied ${urls.length} link(s)`);
          }, "ps4st-copy"));
          rows.splice(0, 0, ...extra.filter(Boolean));
        });
      });
    });
  }

  function onUnload() {
    if (unpatchSheet) unpatchSheet();
    unpatchSheet = null;
  }

  exports.default = { onLoad, onUnload };
  Object.defineProperty(exports, "__esModule", { value: true });
  return exports;
})({}, vendetta.patcher, vendetta.metro, vendetta.utils, vendetta.ui.assets, vendetta.ui.toasts, vendetta.ui);
