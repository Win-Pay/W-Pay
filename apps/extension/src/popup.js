/* global chrome */

const apiInput = /** @type {HTMLInputElement} */ (document.getElementById("api"));
const numberInput = /** @type {HTMLInputElement} */ (document.getElementById("number"));
const lookupButton = /** @type {HTMLButtonElement} */ (document.getElementById("lookup"));
const result = /** @type {HTMLElement} */ (document.getElementById("result"));

/** @param {string} stroops */
function formatAmount(stroops) {
  try {
    const value = BigInt(stroops);
    const digits = value.toString().padStart(8, "0");
    const whole = digits.slice(0, -7);
    const fraction = digits.slice(-7).replace(/0+$/, "");
    return `${whole}${fraction ? `.${fraction}` : ""}`;
  } catch {
    return String(stroops);
  }
}

/** @param {Node | null} node */
function render(node) {
  result.replaceChildren();
  if (node) result.appendChild(node);
}

/**
 * @param {string} text
 * @param {string} className
 */
function message(text, className) {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return element;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(["apiUrl", "webUrl", "pendingInvoice"]);
  apiInput.value = stored.apiUrl || "";
  numberInput.value = stored.pendingInvoice || "";
  if (stored.pendingInvoice) {
    await chrome.storage.local.remove("pendingInvoice");
    await lookup();
  }
}

/** Host access is optional; request exactly the configured API origin on first use.
 * @param {string} apiUrl
 */
async function ensureHostPermission(apiUrl) {
  let origin;
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    throw new Error("Enter a valid API URL, for example https://api.your-domain.com");
  }
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) throw new Error(`Access to ${origin} was not granted.`);
}

async function lookup() {
  const apiUrl = apiInput.value.trim().replace(/\/$/, "");
  const number = numberInput.value.trim().toUpperCase();
  if (!apiUrl || !number) {
    render(message("Enter an API URL and invoice number.", "error"));
    return;
  }
  lookupButton.disabled = true;
  render(message("Looking up…", "muted"));
  try {
    await ensureHostPermission(apiUrl);
    await chrome.storage.local.set({ apiUrl });
    const response = await fetch(`${apiUrl}/v1/invoices/public/${encodeURIComponent(number)}`);
    if (!response.ok) {
      render(message(`Invoice not found (HTTP ${response.status}).`, "error"));
      return;
    }
    const invoice = await response.json();
    const card = document.createElement("div");
    card.className = "card";
    const title = document.createElement("div");
    title.className = "muted";
    title.textContent = invoice.number;
    const amount = document.createElement("div");
    amount.className = "amount";
    amount.textContent = formatAmount(invoice.amount);
    const status = document.createElement("div");
    status.className = "muted";
    status.textContent = `Status: ${invoice.status} · due ${new Date(invoice.dueAt).toLocaleDateString()}`;
    card.append(title, amount, status);

    if (invoice.status === "OPEN") {
      const copy = document.createElement("button");
      copy.className = "secondary";
      copy.textContent = "Copy checkout link";
      copy.addEventListener("click", async () => {
        const stored = await chrome.storage.local.get(["webUrl"]);
        const webUrl = (stored.webUrl || "https://wpay-web.vercel.app").replace(/\/$/, "");
        await navigator.clipboard.writeText(`${webUrl}/?invoice=${encodeURIComponent(invoice.number)}`);
        copy.textContent = "Copied";
      });
      card.appendChild(copy);
    }
    render(card);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    render(message(`Request failed: ${detail}`, "error"));
  } finally {
    lookupButton.disabled = false;
  }
}

lookupButton.addEventListener("click", () => void lookup());
numberInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void lookup();
});

void loadSettings();
