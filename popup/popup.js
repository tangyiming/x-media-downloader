const accountEl = document.getElementById("account");
const messageEl = document.getElementById("message");
const foundEl = document.getElementById("found");
const savedEl = document.getElementById("saved");
const alreadyEl = document.getElementById("already");
const failedEl = document.getElementById("failed");
const choiceButtons = [...document.querySelectorAll(".choices button")];
const resetBtn = document.getElementById("reset");

let tabId = null;
let running = false;
let holdText = "";
let holdUntil = 0;
let lastHandle = "";
let lastView = { mode: "download", scope: "all", phase: "idle" };

function isX(url) {
  return /^https:\/\/(x\.com|twitter\.com)\//.test(url || "");
}

function scopeOf(value) {
  return value === "photo" || value === "video" ? value : "all";
}

function render(status) {
  const view = status?.view || {};
  const downloads = status?.downloads || {};
  running = !!view.running;
  lastView = {
    mode: view.mode === "scan" ? "scan" : "download",
    scope: scopeOf(view.scope),
    phase: view.phase || "idle",
  };
  const usable = !!status;
  lastHandle = status?.onProfile && status.handle ? String(status.handle) : "";
  if (!status?.onProfile) {
    accountEl.textContent = "Not on a user profile";
  } else {
    accountEl.textContent = status.section === "media"
      ? `@${status.handle} · Media tab`
      : `@${status.handle} · Will switch to Media when you start`;
  }
  messageEl.textContent = Date.now() < holdUntil
    ? holdText
    : (view.message || "Open a profile, then download photos, videos, or all.");
  foundEl.textContent = String(view.found || 0);
  savedEl.textContent = String(downloads.completed || 0);
  alreadyEl.textContent = String(view.already || 0);
  failedEl.textContent = String(downloads.failed || 0);
  for (const button of choiceButtons) {
    const mode = button.dataset.mode === "scan" ? "scan" : "download";
    const scope = scopeOf(button.dataset.scope);
    const active = lastView.mode === mode && lastView.scope === scope;
    const labels = { photo: "Photos", video: "Videos", all: "All" };
    if (running && active) button.textContent = "Stop";
    else if (!running && lastView.phase === "paused" && active) button.textContent = "Resume";
    else button.textContent = labels[scope];
    button.disabled = !usable || (running && !active);
  }
  if (resetBtn) resetBtn.disabled = !lastHandle || running;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function pageCall(tabId, command) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name) => {
      const root = document.documentElement;
      if (!root) return "";
      const command = `${name}#${Date.now()}`;
      root.dataset.xMediaCmd = command;
      window.postMessage({ source: "x-media-dl", type: "command", command }, "*");
      root.dispatchEvent(new CustomEvent("x-media-dl-cmd", { bubbles: true, detail: command }));
      return root.dataset.xMediaState || "";
    },
    args: [command],
  });
  if (!injected?.result) return null;
  try {
    return JSON.parse(injected.result);
  } catch (err) {
    return null;
  }
}

async function refresh() {
  const tab = await activeTab();
  tabId = tab?.id ?? null;
  if (!tabId || !isX(tab.url)) {
    render({ onProfile: false, view: { message: "Open a user profile on x.com first." } });
    return;
  }
  try {
    const status = await pageCall(tabId, "status");
    if (!status) {
      render({
        onProfile: false,
        view: { message: "This page has not loaded the extension yet. Refresh the X tab, then try again." },
      });
      return;
    }
    let downloads = status.downloads || {};
    try {
      const latest = await chrome.runtime.sendMessage({ type: "GET_DOWNLOADS" });
      if (latest && typeof latest.completed === "number") downloads = latest;
    } catch (err) {
      /* Fall back to numbers already mirrored from the page */
    }
    render({ ...status, downloads });
  } catch (err) {
    render({
      onProfile: false,
      view: { message: "This page has not loaded the extension yet. Refresh the X tab, then try again." },
    });
  }
}

function hold(text) {
  holdText = text;
  holdUntil = Date.now() + 6000;
  messageEl.textContent = text;
}

async function runChoice(button) {
  const tab = await activeTab();
  if (!tab?.id || !isX(tab.url)) {
    hold("Open a user profile on x.com first.");
    return;
  }
  const mode = button.dataset.mode === "scan" ? "scan" : "download";
  const scope = scopeOf(button.dataset.scope);
  const active = running && lastView.mode === mode && lastView.scope === scope;
  for (const item of choiceButtons) item.disabled = true;
  button.textContent = active ? "Stopping…" : "Starting…";
  hold(active ? "Stopping…" : "Starting…");
  try {
    if (active) {
      await pageCall(tab.id, "stop");
      running = false;
      holdUntil = 0;
    } else {
      const current = await pageCall(tab.id, "status");
      if (!current?.hooked) {
        hold("Refresh this X page first, then start a batch download.");
        refresh();
        return;
      }
      if (!current.onProfile) {
        hold("Open a user profile first (URL like x.com/username).");
        refresh();
        return;
      }
      const command = `${mode === "scan" ? "scan" : "start"}:${scope}`;
      const started = await pageCall(tab.id, command);
      holdUntil = 0;
      if (started?.view?.message) messageEl.textContent = started.view.message;
    }
  } catch (err) {
    hold("Refresh this X page and try again.");
  }
  refresh();
}

for (const button of choiceButtons) {
  button.addEventListener("click", () => {
    runChoice(button).catch(() => {});
  });
}

document.getElementById("folder").addEventListener("click", () => {
  chrome.downloads.showDefaultFolder();
});

resetBtn.addEventListener("click", async () => {
  if (!lastHandle || running) return;
  const ok = window.confirm(
    `Clear @${lastHandle}'s download history, cursors, and album cache?\nFiles already on disk are not deleted. You can use Check for misses afterward to backfill photos or videos.`
  );
  if (!ok) return;
  resetBtn.disabled = true;
  hold("Resetting progress…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "RESET_PROGRESS", handle: lastHandle });
    if (result?.ok) hold(`Progress reset for @${lastHandle}. Use Check for misses with Videos or All.`);
    else hold("Reset failed. Reload the extension and try again.");
  } catch (err) {
    hold("Reset failed. Reload the extension and try again.");
  }
  refresh();
});

async function boot() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  } catch (err) {
    /* Background also opens access; failure here should not block the popup */
  }
  refresh();
  setInterval(refresh, 800);
}

boot();
