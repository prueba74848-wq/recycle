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

  async function postReply(message, content, blob, filename) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({
      content,
      message_reference: { message_id: message.id, channel_id: message.channel_id, fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
    }));
    const fname = filename || "result.zip";
    const type = /\.txt$/i.test(fname) ? "text/plain" : "application/zip";
    // Blob.type is read-only in React Native, so wrap the data in a new typed Blob.
    let file = blob;
    try { file = new Blob([blob], { type }); } catch (_) {}
    try { file.name = fname; } catch (_) {
      try { Object.defineProperty(file, "name", { value: fname, configurable: true }); } catch (__) {}
    }
    form.append("files[0]", file);
    const res = await fetch(`${API_BASE}/channels/${message.channel_id}/messages`, {
      method: "POST",
      headers: { Authorization: getToken() },     // your own session, like other client plugins
      body: form,
    });
    if (!res.ok) throw new Error("Discord said HTTP " + res.status);
  }

  async function runTask(message, task) {
    const urls = attachmentUrls(message);
    if (!urls.length) return showToast("This message has no attachments");
    if (busy.has(message.id)) return showToast("Already working on this message");
    busy.add(message.id);
    try {
      const job = Math.random().toString(36).slice(2) + Date.now().toString(36);
      showToast(`${task.label.replace(" & reply", "")}: opening PS4 Save Tool…`);
      if (!(await openApp(deepLink("run", urls, `op=${task.op}&job=${job}`), urls))) return;

      // The app does the work, then returns to Discord. Poll its local bridge for the result.
      const started = Date.now();
      let state = null, reached = false, misses = 0;
      while (Date.now() - started < 10 * 60 * 1000) {
        await sleep(2000);
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

      const fr = await fetch(`${APP}/file?id=${job}`);
      if (!fr.ok) {
        let body = "";
        try { body = await fr.text(); } catch (_) {}
        throw new Error(`couldn't get the result from the app (HTTP ${fr.status}: ${body.slice(0, 120)})`);
      }
      const blob = await fr.blob();
      await postReply(message, String(state.summary || "Done").slice(0, 1900), blob, state.name);
      showToast("Replied with the finished files");
    } catch (e) {
      showToast("PS4 Save Tool: " + (e?.message ?? e));
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
          for (const t of TASKS) {
            extra.push(makeRow("PS4: " + t.label, "ic_share_ios", () => { hide(); runTask(message, t); }, "ps4st-" + t.op));
          }
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
