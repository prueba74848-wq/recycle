(function (exports, patcher, metro, common, utils, assets, toasts, ui) {
  "use strict";

  const { before, after } = patcher;
  const { findByProps } = metro;
  const { React, ReactNative } = common;
  const { findInReactTree } = utils;
  const { getAssetIDByName } = assets;
  const { showToast } = toasts;
  const { Forms } = ui.components ?? {};

  const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
  const Clipboard = ReactNative.Clipboard ?? findByProps("setString")?.Clipboard ?? findByProps("setString");

  let unpatchSheet = null;

  // Fresh attachment links straight from the message (cdn.discordapp.com, signed).
  function attachmentUrls(message) {
    const list = message?.attachments ?? [];
    return list.map((a) => a?.url).filter((u) => typeof u === "string" && u.startsWith("http"));
  }

  function buildDeepLink(urls) {
    return "ps4savetool://open?" + urls.map((u) => "u=" + encodeURIComponent(u)).join("&");
  }

  async function sendToApp(message) {
    const urls = attachmentUrls(message);
    if (!urls.length) return showToast("This message has no attachments");
    try {
      await ReactNative.Linking.openURL(buildDeepLink(urls));
    } catch (e) {
      // App not installed / link blocked: fall back to copying the links.
      try { Clipboard.setString(urls.join("\n")); } catch (_) {}
      showToast("PS4 Save Tool not found. Links copied: paste them in the app's link box");
    }
  }

  function copyLinks(message) {
    const urls = attachmentUrls(message);
    if (!urls.length) return showToast("This message has no attachments");
    Clipboard.setString(urls.join("\n"));
    showToast(`Copied ${urls.length} link(s)`);
  }

  function makeRow(label, iconName, onPress, key) {
    const icon = getAssetIDByName(iconName) ?? getAssetIDByName("ic_link");
    if (Forms?.FormRow) {
      return React.createElement(Forms.FormRow, {
        key, label,
        leading: React.createElement(Forms.FormRow.Icon, { source: icon }),
        onPress,
      });
    }
    return null;
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
          const a = makeRow("Send to PS4 Save Tool", "ic_share_ios", () => { hide(); sendToApp(message); }, "ps4st-send");
          const b = makeRow("Copy save file links", "ic_link", () => { hide(); copyLinks(message); }, "ps4st-copy");
          if (a) rows.splice(0, 0, a);
          if (b) rows.splice(1, 0, b);
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
})({}, vendetta.patcher, vendetta.metro, vendetta.metro.common, vendetta.utils, vendetta.ui.assets, vendetta.ui.toasts, vendetta.ui);
