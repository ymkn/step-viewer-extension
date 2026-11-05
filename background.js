chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});

// Markdown Viewer 方式の自動起動: 対応拡張子のファイルへナビゲートされたら
// ビューアタブへ振り替える。file:// には拡張の「ファイルのURLへのアクセス」
// 許可が別途必要（chrome://extensions → 詳細）。
const OPENABLE = /\.(step|stp|iges|igs|brep)$/i;
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  let u;
  try { u = new URL(details.url); } catch { return; }
  if (!["file:", "http:", "https:"].includes(u.protocol)) return;
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  if (!OPENABLE.test(path)) return;
  const viewer = chrome.runtime.getURL("viewer.html") + "?url=" + encodeURIComponent(details.url);
  chrome.tabs.update(details.tabId, { url: viewer });
});
