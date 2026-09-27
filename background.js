function allowPageAccess() {
  const level = { accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" };
  try {
    const pending = chrome.storage?.session?.setAccessLevel(level);
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch (err) {
    /* 没有 session 存储时，内容脚本仍只走消息，不直接读写存储 */
  }
}

allowPageAccess();
chrome.runtime.onInstalled.addListener(allowPageAccess);
chrome.runtime.onStartup.addListener(allowPageAccess);

const MAX_ACTIVE = 2;
const doneCache = new Map();
const activeMeta = new Map();

let queue = [];
let active = 0;
let completed = 0;
let failed = 0;
let stopped = false;
let generation = 0;
let pumping = false;
let downloadStats = { completed: 0, failed: 0, queued: 0, active: 0, updatedAt: 0 };

function folderName(handle) {
  const name = String(handle || "").replace(/[^A-Za-z0-9_]/g, "");
  return name || "x-account";
}

const reservedPaths = new Map();

function reservePath(url, filename) {
  const queue = reservedPaths.get(url);
  if (queue) queue.push(filename);
  else reservedPaths.set(url, [filename]);
}

function takePath(url) {
  const queue = reservedPaths.get(url);
  if (!queue?.length) return "";
  const filename = queue.shift();
  if (!queue.length) reservedPaths.delete(url);
  return filename;
}

function cancelPath(url, filename) {
  const queue = reservedPaths.get(url);
  if (!queue) return;
  const index = queue.lastIndexOf(filename);
  if (index >= 0) queue.splice(index, 1);
  if (!queue.length) reservedPaths.delete(url);
}

function accountPath(handle, filename) {
  return `${folderName(handle)}/${safeFilename(filename)}`;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const wanted = takePath(item.url) || takePath(item.finalUrl);
  if (!wanted) return;
  suggest({ filename: wanted, conflictAction: "uniquify" });
});

function allowedDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "pbs.twimg.com" || parsed.hostname === "video.twimg.com");
  } catch (err) {
    return false;
  }
}

async function loadDone(handle) {
  if (doneCache.has(handle)) return doneCache.get(handle);
  const storageKey = `done:${handle}`;
  const stored = await chrome.storage.local.get(storageKey);
  const set = new Set(stored[storageKey] || []);
  doneCache.set(handle, set);
  return set;
}

const cursorCache = new Map();

function newerTweet(nextId, prevId) {
  if (!/^\d{6,}$/.test(nextId || "")) return false;
  if (!/^\d{6,}$/.test(prevId || "")) return true;
  try {
    return BigInt(nextId) > BigInt(prevId);
  } catch (err) {
    return nextId > prevId;
  }
}

async function loadCursor(handle, view) {
  const cacheKey = `${handle}:${view}`;
  if (cursorCache.has(cacheKey)) return cursorCache.get(cacheKey);
  const storageKey = `cursor:${handle}:${view}`;
  const stored = await chrome.storage.local.get(storageKey);
  const cursor = stored[storageKey]?.tweetId ? stored[storageKey] : null;
  cursorCache.set(cacheKey, cursor);
  return cursor;
}

async function noteCursor(handle, item) {
  if (item?.trackCursor === false) return;
  const view = item?.view === "video" ? "video" : "photo";
  const tweetId = String(item?.tweetId || "");
  if (!/^\d{6,}$/.test(tweetId)) return;
  const current = await loadCursor(handle, view);
  if (current?.tweetId && !newerTweet(tweetId, current.tweetId)) return;
  const next = { tweetId, created: item?.created || "", at: Date.now() };
  cursorCache.set(`${handle}:${view}`, next);
  chrome.storage.local.set({ [`cursor:${handle}:${view}`]: next }).catch(() => {});
}

const persistTimers = new Map();

function schedulePersist(handle) {
  clearTimeout(persistTimers.get(handle));
  persistTimers.set(
    handle,
    setTimeout(() => {
      const set = doneCache.get(handle);
      if (!set) return;
      chrome.storage.local.set({ [`done:${handle}`]: [...set] }).catch(() => {});
    }, 800)
  );
}

function publishStats() {
  downloadStats = {
    completed,
    failed,
    queued: queue.length,
    active,
    updatedAt: Date.now(),
  };
}

function pump() {
  if (pumping) return;
  pumping = true;
  while (active < MAX_ACTIVE && queue.length) {
    const index = stopped ? queue.findIndex((entry) => entry.solo) : 0;
    if (index < 0) break;
    const entry = queue.splice(index, 1)[0];
    active += 1;
    launch(entry);
  }
  pumping = false;
  publishStats();
}

function launch(entry) {
  beginDownload(entry)
    .then((downloadId) => {
      if (downloadId != null) return;
      active = Math.max(0, active - 1);
      if (entry.generation !== generation) {
        publishStats();
        return;
      }
      if (stopped && !entry.solo) {
        queue.unshift(entry);
        publishStats();
        return;
      }
      if (!entry.viaBlob) {
        entry.viaBlob = true;
        queue.unshift(entry);
      } else {
        failed += 1;
      }
      publishStats();
      pump();
    })
    .catch(() => {
      active = Math.max(0, active - 1);
      if (entry.generation === generation) failed += 1;
      publishStats();
      pump();
    });
}

async function beginDownload(entry) {
  if ((stopped && !entry.solo) || entry.generation !== generation) return null;
  let url = entry.item.url;
  if (!allowedDownloadUrl(url)) return null;
  if (entry.viaBlob) {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok || stopped || entry.generation !== generation) return null;
    entry.blobUrl = URL.createObjectURL(await response.blob());
    url = entry.blobUrl;
  }
  if ((stopped && !entry.solo) || entry.generation !== generation) {
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
    return null;
  }
  const filename = accountPath(entry.handle, entry.item.filename);
  reservePath(url, filename);
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url, filename, conflictAction: "uniquify", saveAs: false },
      (id) => {
        if (chrome.runtime.lastError || id == null) {
          cancelPath(url, filename);
          if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
          resolve(null);
          return;
        }
        activeMeta.set(id, entry);
        resolve(id);
      }
    );
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  handleDelta(delta).catch(() => {});
});

async function handleDelta(delta) {
  const entry = activeMeta.get(delta.id);
  if (!entry || !delta.state) return;
  const state = delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;

  activeMeta.delete(delta.id);
  if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  if (entry.generation !== generation) return;

  active = Math.max(0, active - 1);
  if (entry.localFile) {
    if (state === "complete") {
      const done = await loadDone(entry.handle);
      done.add(entry.item.key);
      schedulePersist(entry.handle);
      await noteCursor(entry.handle, entry.item);
      completed += 1;
    } else if (!stopped) {
      failed += 1;
    }
    publishStats();
    pump();
    return;
  }
  if (state === "complete") {
    const done = await loadDone(entry.handle);
    done.add(entry.item.key);
    schedulePersist(entry.handle);
    await noteCursor(entry.handle, entry.item);
    completed += 1;
  } else if (stopped && !entry.solo) {
    queue.unshift(entry);
  } else if (stopped && delta.error?.current === "USER_CANCELED") {
    /* 点停止时取消的单条下载不再自动重下 */
  } else {
    const reason = delta.error?.current || "";
    if (reason === "USER_CANCELED") {
      queue.unshift(entry);
    } else if (!entry.viaBlob) {
      entry.viaBlob = true;
      queue.unshift(entry);
    } else {
      failed += 1;
    }
  }
  publishStats();
  pump();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "stream-file") return;
  const chunks = [];
  let meta = null;
  let aborted = false;
  port.onMessage.addListener((message) => {
    if (message?.type === "start") {
      meta = { ...message, generation };
      return;
    }
    if (message?.type === "chunk" && message.buffer) {
      chunks.push(message.buffer);
      return;
    }
    if (message?.type === "abort") {
      aborted = true;
      chunks.length = 0;
      return;
    }
    if (message?.type === "end" && meta && !aborted) finishStream(meta, chunks).catch(() => {});
  });
});

async function finishStream(meta, chunks) {
  if ((stopped && !meta.solo) || meta.generation !== generation || !chunks.length) return;
  const handle = folderName(meta.handle);
  const done = await loadDone(handle);
  if (done.has(meta.key)) return;
  const blob = new Blob(chunks, { type: meta.ext === "mp4" ? "video/mp4" : "video/mp2t" });
  chunks.length = 0;
  const blobUrl = URL.createObjectURL(blob);
  const filename = accountPath(handle, meta.filename);
  reservePath(blobUrl, filename);
  active += 1;
  publishStats();
  chrome.downloads.download(
    { url: blobUrl, filename, conflictAction: "uniquify", saveAs: false },
    (id) => {
      if (chrome.runtime.lastError || id == null) {
        cancelPath(blobUrl, filename);
        URL.revokeObjectURL(blobUrl);
        active = Math.max(0, active - 1);
        failed += 1;
        publishStats();
        pump();
        return;
      }
      activeMeta.set(id, {
        handle,
        item: {
          key: meta.key,
          filename: meta.filename,
          tweetId: meta.tweetId || "",
          created: meta.created || "",
          view: "video",
          trackCursor: meta.trackCursor !== false,
        },
        blobUrl,
        generation: meta.generation,
        viaBlob: true,
        localFile: true,
      });
    }
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_DOWNLOADS") {
    sendResponse(downloadStats);
    return;
  }
  if (message?.type === "ENQUEUE") {
    enqueue(message.handle, message.items || []).then(sendResponse);
    return true;
  }
  if (message?.type === "STOP") {
    stopped = true;
    for (const id of activeMeta.keys()) chrome.downloads.cancel(id);
    publishStats();
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "RESUME_DOWNLOADS") {
    stopped = false;
    publishStats();
    pump();
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "GET_CURSOR") {
    const handle = folderName(message.handle);
    Promise.all([loadCursor(handle, "photo"), loadCursor(handle, "video")]).then(([photo, video]) => {
      sendResponse({ photo, video });
    });
    return true;
  }
  if (message?.type === "COMMIT_CURSOR") {
    noteCursor(folderName(message.handle), message).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "HAS_DONE") {
    loadDone(folderName(message.handle)).then((done) => {
      sendResponse({ ok: true, done: (message.keys || []).filter((key) => done.has(key)) });
    });
    return true;
  }
  if (message?.type === "RESET_JOB") {
    generation += 1;
    stopped = false;
    queue = [];
    active = 0;
    completed = 0;
    failed = 0;
    for (const id of [...activeMeta.keys()]) chrome.downloads.cancel(id);
    activeMeta.clear();
    publishStats();
    sendResponse({ ok: true });
  }
});

async function enqueue(handle, items) {
  const safeHandle = folderName(handle);
  const done = await loadDone(safeHandle);
  const alreadyKeys = [];
  for (const item of items) {
    if (!item?.key || !item.filename || !allowedDownloadUrl(item.url)) continue;
    const inFlight = queue.some((entry) => entry.item.key === item.key) || [...activeMeta.values()].some((entry) => entry.item.key === item.key);
    if (inFlight) continue;
    if (done.has(item.key)) {
      alreadyKeys.push(item.key);
      continue;
    }
    queue.push({
      handle: safeHandle,
      item: {
        key: item.key,
        url: item.url,
        filename: safeFilename(item.filename),
        tweetId: item.tweetId || "",
        created: item.created || "",
        view: item.view === "video" ? "video" : "photo",
        trackCursor: item.trackCursor !== false,
      },
      viaBlob: false,
      solo: item.solo === true,
      generation,
    });
  }
  if (!stopped || items.some((item) => item?.solo)) pump();
  else publishStats();
  return { ok: true, alreadyKeys };
}

function safeFilename(name) {
  const cleaned = String(name || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || "media.bin";
}
