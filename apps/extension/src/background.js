// MV3 service worker. Keeps the configured API URL available to the popup and
// adds a context-menu shortcut for selected invoice numbers.
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["apiUrl", "webUrl"]);
  const defaults = {
    apiUrl: stored.apiUrl || "",
    webUrl: stored.webUrl || "https://wpay-web.vercel.app",
  };
  await chrome.storage.local.set(defaults);

  chrome.contextMenus.create({
    id: "wpay-lookup",
    title: "Look up W-Pay invoice \"%s\"",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "wpay-lookup" || !info.selectionText) return;
  const number = info.selectionText.trim().toUpperCase();
  await chrome.storage.local.set({ pendingInvoice: number });
  await chrome.action.openPopup?.();
});
