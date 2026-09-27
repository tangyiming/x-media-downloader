const accountEl = document.getElementById("account");
const messageEl = document.getElementById("message");
const foundEl = document.getElementById("found");
const savedEl = document.getElementById("saved");
const alreadyEl = document.getElementById("already");
const failedEl = document.getElementById("failed");
const choiceButtons = [...document.querySelectorAll(".choices button")];

let tabId = null;
let running = false;
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
  const usable = !!status?.onProfile || running;
  if (!status?.onProfile) {
    accountEl.textContent = "当前不是用户主页";
  } else {
    accountEl.textContent = status.section === "media"
      ? `@${status.handle} · 媒体页`
      : `@${status.handle} · 开始后会切到媒体页`;
  }
  messageEl.textContent = view.message || "打开用户主页后选择下照片、下视频，或全部。";
  foundEl.textContent = String(view.found || 0);
  savedEl.textContent = String(downloads.completed || 0);
  alreadyEl.textContent = String(view.already || 0);
  failedEl.textContent = String(downloads.failed || 0);
  for (const button of choiceButtons) {
    const mode = button.dataset.mode === "scan" ? "scan" : "download";
    const scope = scopeOf(button.dataset.scope);
    const active = lastView.mode === mode && lastView.scope === scope;
    const labels = { photo: "照片", video: "视频", all: "全部" };
    if (running && active) button.textContent = "停止";
    else if (!running && lastView.phase === "paused" && active) button.textContent = "继续";
    else button.textContent = labels[scope];
    button.disabled = !usable || (running && !active);
  }
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
      root.dataset.xMediaCmd = name;
      root.dispatchEvent(new CustomEvent("x-media-dl-cmd", { bubbles: true, detail: name }));
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
    render({ onProfile: false, view: { message: "请先打开 x.com 上的用户主页。" } });
    return;
  }
  try {
    const status = await pageCall(tabId, "status");
    if (!status) {
      render({
        onProfile: false,
        view: { message: "这个页面还没有载入插件。请刷新该 X 页面后再开始。" },
      });
      return;
    }
    let downloads = status.downloads || {};
    try {
      const latest = await chrome.runtime.sendMessage({ type: "GET_DOWNLOADS" });
      if (latest && typeof latest.completed === "number") downloads = latest;
    } catch (err) {
      /* 用页面上已经记下的数字 */
    }
    render({ ...status, downloads });
  } catch (err) {
    render({
      onProfile: false,
      view: { message: "这个页面还没有载入插件。请刷新该 X 页面后再开始。" },
    });
  }
}

async function runChoice(button) {
  const tab = await activeTab();
  if (!tab?.id || !isX(tab.url)) return;
  const mode = button.dataset.mode === "scan" ? "scan" : "download";
  const scope = scopeOf(button.dataset.scope);
  const active = running && lastView.mode === mode && lastView.scope === scope;
  for (const item of choiceButtons) item.disabled = true;
  try {
    if (active) {
      button.textContent = "正在停止…";
      await pageCall(tab.id, "stop");
      running = false;
      refresh();
      return;
    }
    const current = await pageCall(tab.id, "status");
    if (!current?.hooked) {
      render({
        onProfile: true,
        view: { message: "请先刷新这个页面，再开始。这样从第一次加载就能拿到媒体。" },
      });
      return;
    }
    const command = `${mode === "scan" ? "scan" : "start"}:${scope}`;
    await pageCall(tab.id, command);
  } catch (err) {
    messageEl.textContent = "请刷新这个 X 页面后再试。";
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

async function boot() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  } catch (err) {
    /* 后台脚本也会放开，这里失败不挡住弹窗 */
  }
  refresh();
  setInterval(refresh, 800);
}

boot();
