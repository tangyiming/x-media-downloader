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
chrome.runtime.onInstalled.addListener((details) => {
  allowPageAccess();
  if (details.reason !== "update") return;
  chrome.storage.local.get(null).then((stored) => {
    const keys = Object.keys(stored || {}).filter((key) => key.startsWith("cursor:"));
    if (keys.length) chrome.storage.local.remove(keys).catch(() => {});
    cursorCache.clear();
  }).catch(() => {});
});
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

let phoneMode = /Android/i.test(globalThis.navigator?.userAgent || "");
try {
  chrome.runtime.getPlatformInfo((info) => {
    if (chrome.runtime.lastError || !info) return;
    phoneMode = info.os === "android";
  });
} catch (err) {
  /* 继续用 UA 判断 */
}

const reservedPaths = new Map();

function reservePath(url, filename, conflictAction = "uniquify") {
  const queue = reservedPaths.get(url);
  const entry = { filename, conflictAction };
  if (queue) queue.push(entry);
  else reservedPaths.set(url, [entry]);
}

function takePath(url) {
  const queue = reservedPaths.get(url);
  if (!queue?.length) return null;
  const entry = queue.shift();
  if (!queue.length) reservedPaths.delete(url);
  return entry;
}

function cancelPath(url, filename) {
  const queue = reservedPaths.get(url);
  if (!queue) return;
  const index = queue.findLastIndex((entry) => entry.filename === filename);
  if (index >= 0) queue.splice(index, 1);
  if (!queue.length) reservedPaths.delete(url);
}

function phoneDownload() {
  return phoneMode;
}

function accountPath(handle, filename) {
  const folder = folderName(handle);
  const file = safeFilename(filename);
  return phoneDownload() ? `${folder}_${file}` : `${folder}/${file}`;
}

function canCreateObjectURL() {
  try {
    return typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  } catch (err) {
    return false;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    let part = "";
    for (let j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j]);
    binary += part;
  }
  return btoa(binary);
}

/** MV3 service worker 可能没有 createObjectURL；小文件改走 data URL。 */
async function blobToDownloadUrl(blob) {
  if (canCreateObjectURL()) return { url: URL.createObjectURL(blob), revoke: true };
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length > 1_800_000) {
    throw new Error("文件过大，当前环境无法中转下载");
  }
  const type = blob.type || "application/octet-stream";
  return { url: `data:${type};base64,${bytesToBase64(bytes)}`, revoke: false };
}

function revokeDownloadUrl(url, revoke) {
  if (!revoke || !url) return;
  try {
    URL.revokeObjectURL(url);
  } catch (err) {
    /* SW 上可能没有 revokeObjectURL */
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const wanted = takePath(item.url) || takePath(item.finalUrl);
  if (wanted) {
    suggest({ filename: wanted.filename, conflictAction: wanted.conflictAction || "uniquify" });
    return;
  }
  suggest();
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
    const converted = await blobToDownloadUrl(await response.blob());
    entry.blobUrl = converted.url;
    entry.blobRevoke = converted.revoke;
    url = entry.blobUrl;
  }
  if ((stopped && !entry.solo) || entry.generation !== generation) {
    revokeDownloadUrl(entry.blobUrl, entry.blobRevoke);
    return null;
  }
  const filename = accountPath(entry.handle, entry.item.filename);
  reservePath(url, filename, "uniquify");
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url, filename, conflictAction: "uniquify", saveAs: false },
      (id) => {
        if (chrome.runtime.lastError || id == null) {
          cancelPath(url, filename);
          revokeDownloadUrl(entry.blobUrl, entry.blobRevoke);
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
  revokeDownloadUrl(entry.blobUrl, entry.blobRevoke === true);
  if (entry.albumWrite) {
    const waiter = albumWaiters.get(delta.id);
    if (waiter) {
      albumWaiters.delete(delta.id);
      waiter.resolve(
        state === "complete"
          ? { ok: true }
          : { ok: false, error: delta.error?.current || "图集下载被中断" }
      );
    }
    publishStats();
    pump();
    return;
  }
  if (entry.generation !== generation) return;

  active = Math.max(0, active - 1);
  if (entry.localFile) {
    if (state === "complete") {
      const done = await loadDone(entry.handle);
      done.add(entry.item.key);
      schedulePersist(entry.handle);
      await noteCursor(entry.handle, entry.item);
      completed += 1;
      upsertAlbumMedia(entry.handle, entry.item).catch(() => {});
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
    upsertAlbumMedia(entry.handle, entry.item).catch(() => {});
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
  if (done.has(meta.key) && !meta.solo) return;
  const blob = new Blob(chunks, { type: meta.ext === "mp4" ? "video/mp4" : "video/mp2t" });
  chunks.length = 0;
  let converted;
  try {
    converted = await blobToDownloadUrl(blob);
  } catch (err) {
    failed += 1;
    publishStats();
    pump();
    return;
  }
  const blobUrl = converted.url;
  const filename = accountPath(handle, meta.filename);
  reservePath(blobUrl, filename, "uniquify");
  upsertAlbumMedia(handle, {
    key: meta.key,
    filename: meta.filename,
    tweetId: meta.tweetId || "",
    created: meta.created || "",
    text: meta.text || "",
    kind: "video",
    view: "video",
  }).catch(() => {});
  active += 1;
  publishStats();
  chrome.downloads.download(
    { url: blobUrl, filename, conflictAction: "uniquify", saveAs: false },
    (id) => {
      if (chrome.runtime.lastError || id == null) {
        cancelPath(blobUrl, filename);
        revokeDownloadUrl(blobUrl, converted.revoke);
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
          text: meta.text || "",
          view: "video",
          kind: "video",
          trackCursor: meta.trackCursor !== false,
        },
        blobUrl,
        blobRevoke: converted.revoke,
        generation: meta.generation,
        viaBlob: true,
        localFile: true,
        solo: meta.solo === true,
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
    enqueue(message.handle, message.items || [])
      .then((result) => {
        try {
          sendResponse(result);
        } catch (err) {
          /* 频道已关闭时下载仍会继续 */
        }
      })
      .catch(() => {
        try {
          sendResponse({ ok: false, error: "enqueue_failed" });
        } catch (err) {
          /* ignore */
        }
      });
    return true;
  }
  if (message?.type === "FLUSH_ALBUM") {
    flushAlbum(folderName(message.handle))
      .then((result) => sendResponse(result && typeof result === "object" ? result : { ok: !!result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err || "图集导出失败") }));
    return true;
  }
  if (message?.type === "NOTE_ALBUM") {
    const handle = folderName(message.handle);
    const items = Array.isArray(message.items) ? message.items : [];
    Promise.all(items.map((item) => upsertAlbumMedia(handle, item)))
      .then(() => {
        if (message.flush) return flushAlbum(handle);
        scheduleAlbumExport(handle);
        return { ok: true };
      })
      .then((result) => sendResponse(result && typeof result === "object" ? result : { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err || "图集更新失败") }));
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
  if (message?.type === "CLEAR_CURSOR") {
    const handle = folderName(message.handle);
    const views = message.view ? [message.view] : ["photo", "video"];
    for (const view of views) {
      cursorCache.delete(`${handle}:${view}`);
      chrome.storage.local.remove(`cursor:${handle}:${view}`).catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "RESET_PROGRESS") {
    resetProgress(message.handle).then(sendResponse).catch(() => sendResponse({ ok: false }));
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
  const albumJobs = [];
  for (const item of items) {
    if (!item?.key || !item.filename) continue;
    if (!allowedDownloadUrl(item.url)) continue;
    const force = item.solo === true;
    const inFlight = queue.some((entry) => entry.item.key === item.key) || [...activeMeta.values()].some((entry) => entry.item?.key === item.key);
    if (inFlight && !force) {
      albumJobs.push(upsertAlbumMedia(safeHandle, item));
      continue;
    }
    if (!force && done.has(item.key)) {
      alreadyKeys.push(item.key);
      albumJobs.push(upsertAlbumMedia(safeHandle, item));
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
        text: item.text || "",
        view: item.view === "video" ? "video" : "photo",
        trackCursor: item.trackCursor !== false,
        kind: item.kind === "video" ? "video" : "photo",
      },
      viaBlob: false,
      solo: force,
      generation,
    });
    albumJobs.push(upsertAlbumMedia(safeHandle, item));
  }
  // 先开泵再记图集，避免单条下载等 upsert 时消息通道超时
  if (!stopped || items.some((item) => item?.solo)) pump();
  else publishStats();
  if (albumJobs.length) {
    Promise.all(albumJobs).catch(() => {});
  }
  return { ok: true, alreadyKeys };
}

const albumCache = new Map();
const albumTimers = new Map();
const albumChains = new Map();
const albumFlushChains = new Map();
const albumWaiters = new Map();

async function loadAlbum(handle) {
  if (albumCache.has(handle)) return albumCache.get(handle);
  const storageKey = `album:${handle}`;
  const stored = await chrome.storage.local.get(storageKey);
  const album = stored[storageKey] && typeof stored[storageKey] === "object"
    ? stored[storageKey]
    : { handle, posts: {} };
  if (!album.posts || typeof album.posts !== "object") album.posts = {};
  album.handle = handle;
  albumCache.set(handle, album);
  return album;
}

async function saveAlbum(handle, album) {
  albumCache.set(handle, album);
  await chrome.storage.local.set({ [`album:${handle}`]: album });
}

function upsertAlbumMedia(handle, item) {
  const safeHandle = folderName(handle);
  const prev = albumChains.get(safeHandle) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => writeAlbumMedia(safeHandle, item));
  albumChains.set(safeHandle, next);
  return next;
}

async function writeAlbumMedia(handle, item) {
  const safeHandle = folderName(handle);
  const filename = safeFilename(item?.filename || "");
  if (!item?.key || !filename) return;
  let tweetId = String(item?.tweetId || "");
  if (!/^\d{6,}$/.test(tweetId)) {
    const matched = filename.match(/_(\d{6,})_\d+\./);
    tweetId = matched?.[1] || "";
  }
  if (!/^\d{6,}$/.test(tweetId)) return;
  const album = await loadAlbum(safeHandle);
  const post = album.posts[tweetId] || { created: "", text: "", media: [] };
  if (!Array.isArray(post.media)) post.media = [];
  let changed = false;
  if (item.created && item.created !== post.created) {
    post.created = item.created;
    changed = true;
  }
  const text = String(item.text || "").trim();
  if (text && text !== post.text) {
    post.text = text;
    changed = true;
  }
  const kind = item.kind === "video" || item.kind === "stream" || item.view === "video" ? "video" : "photo";
  const existing = post.media.find((entry) => entry.key === item.key);
  if (existing) {
    if (existing.filename !== filename || existing.kind !== kind) {
      existing.filename = filename;
      existing.kind = kind;
      changed = true;
    }
  } else {
    post.media.push({ key: item.key, filename, kind });
    changed = true;
  }
  if (!changed) return;
  album.posts[tweetId] = post;
  await saveAlbum(safeHandle, album);
  await chrome.storage.local.set({ [`albumDirty:${safeHandle}`]: Date.now() });
}

function scheduleAlbumExport(handle) {
  const safeHandle = folderName(handle);
  clearTimeout(albumTimers.get(safeHandle));
  albumTimers.set(
    safeHandle,
    setTimeout(() => {
      flushAlbum(safeHandle).catch(() => {});
    }, 1500)
  );
}

function waitAlbumDownload(id, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!albumWaiters.has(id)) return;
      albumWaiters.delete(id);
      try {
        chrome.downloads.cancel(id);
      } catch (err) {
        /* ignore */
      }
      const entry = activeMeta.get(id);
      if (entry) {
        activeMeta.delete(id);
        if (entry.blobUrl) {
          try {
            URL.revokeObjectURL(entry.blobUrl);
          } catch (err) {
            /* SW 上可能没有 revokeObjectURL */
          }
        }
      }
      resolve({ ok: false, error: "写出图集超时" });
    }, timeoutMs);
    albumWaiters.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
    });
  });
}

async function flushAlbum(handle) {
  const safeHandle = folderName(handle);
  clearTimeout(albumTimers.get(safeHandle));
  albumTimers.delete(safeHandle);
  const prev = albumFlushChains.get(safeHandle) || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    let pending = albumChains.get(safeHandle);
    if (pending) {
      try {
        await pending;
      } catch (err) {
        /* ignore */
      }
    }
    pending = albumChains.get(safeHandle);
    if (pending) {
      try {
        await pending;
      } catch (err) {
        /* ignore */
      }
    }
    const dirtyKey = `albumDirty:${safeHandle}`;
    const stored = await chrome.storage.local.get(dirtyKey);
    if (!stored[dirtyKey]) {
      const album = await loadAlbum(safeHandle);
      const hasPosts = Object.keys(album.posts || {}).length > 0;
      return {
        ok: true,
        skipped: true,
        reason: hasPosts ? "unchanged" : "empty",
      };
    }
    return exportAlbum(safeHandle);
  });
  albumFlushChains.set(
    safeHandle,
    job.then(
      () => {},
      () => {}
    )
  );
  return job;
}

async function resetProgress(handle) {
  const safeHandle = folderName(handle);
  doneCache.delete(safeHandle);
  albumCache.delete(safeHandle);
  albumChains.delete(safeHandle);
  albumFlushChains.delete(safeHandle);
  clearTimeout(albumTimers.get(safeHandle));
  albumTimers.delete(safeHandle);
  cursorCache.delete(`${safeHandle}:photo`);
  cursorCache.delete(`${safeHandle}:video`);
  await chrome.storage.local.remove([
    `done:${safeHandle}`,
    `album:${safeHandle}`,
    `albumDirty:${safeHandle}`,
    `cursor:${safeHandle}:photo`,
    `cursor:${safeHandle}:video`,
  ]);
  return { ok: true };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function albumMediaSrc(handle, filename) {
  const file = safeFilename(filename);
  return phoneDownload() ? `${folderName(handle)}_${file}` : file;
}

function formatAlbumDate(created) {
  if (!created) return "";
  const date = new Date(created);
  if (Number.isNaN(date.getTime())) return String(created);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
}

function renderAlbum(handle, album) {
  const posts = Object.entries(album.posts || {})
    .filter(([, post]) => Array.isArray(post.media) && post.media.length)
    .sort((a, b) => {
      try {
        return BigInt(b[0]) > BigInt(a[0]) ? 1 : -1;
      } catch (err) {
        return String(b[0]).localeCompare(String(a[0]));
      }
    });
  const articles = posts.map(([tweetId, post]) => {
    const mediaHtml = post.media.map((entry) => {
      const src = escapeHtml(albumMediaSrc(handle, entry.filename));
      if (entry.kind === "video") {
        return `<video controls preload="metadata" src="${src}"></video>`;
      }
      return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="" loading="lazy"></a>`;
    }).join("");
    const text = String(post.text || "").trim();
    const textHtml = text
      ? `<p class="text">${escapeHtml(text).replace(/\n/g, "<br>")}</p>`
      : `<p class="text muted">这条没有文案</p>`;
    const when = formatAlbumDate(post.created);
    return `<article id="t${escapeHtml(tweetId)}">
  <header>
    <time>${escapeHtml(when || tweetId)}</time>
    <span class="id">${escapeHtml(tweetId)}</span>
  </header>
  ${textHtml}
  <div class="media">${mediaHtml}</div>
</article>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@${escapeHtml(handle)} 图集</title>
<style>
  :root {
    color-scheme: light;
    --bg: #eef2f4;
    --card: #ffffff;
    --ink: #15202b;
    --muted: #5b6b79;
    --line: #d7dee5;
    --accent: #0b6e4f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 16px/1.6 "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Segoe UI", sans-serif;
    color: var(--ink);
    background:
      linear-gradient(180deg, #f7fafb 0%, var(--bg) 48%, #e8eef2 100%);
  }
  main {
    width: min(760px, calc(100% - 32px));
    margin: 0 auto;
    padding: 40px 0 80px;
  }
  .hero {
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--line);
  }
  .hero h1 {
    margin: 0 0 8px;
    font-size: clamp(28px, 5vw, 40px);
    letter-spacing: 0.01em;
  }
  .hero p {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }
  article {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 20px;
    margin: 0 0 18px;
  }
  article header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    font-size: 13px;
    color: var(--muted);
  }
  .id { opacity: 0.72; }
  .text {
    margin: 0 0 16px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .text.muted { color: var(--muted); }
  .media {
    display: grid;
    gap: 12px;
  }
  img, video {
    display: block;
    width: 100%;
    max-height: 720px;
    object-fit: contain;
    background: #e4ebf0;
    border-radius: 12px;
  }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <div class="hero">
    <h1>@${escapeHtml(handle)}</h1>
    <p>共 ${posts.length} 条 · 和这个文件同目录的图片、视频会显示在下面</p>
  </div>
  ${articles || "<p class=\"text muted\">还没有可展示的媒体。</p>"}
</main>
</body>
</html>`;
}

/** UTF-8 → base64；TextEncoder 会把不成对的 surrogate 换成 U+FFFD，避免 encodeURIComponent 抛 URI malformed。 */
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(String(str || ""));
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    let part = "";
    for (let j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j]);
    binary += part;
  }
  return btoa(binary);
}

/** MV3 service worker 没有 URL.createObjectURL，图集用 base64 data URL 交给 downloads。 */
function albumHtmlToDataUrl(html) {
  return "data:text/html;base64," + toBase64Utf8(html);
}

async function exportAlbum(handle) {
  const safeHandle = folderName(handle);
  const album = await loadAlbum(safeHandle);
  if (!Object.keys(album.posts || {}).length) {
    return { ok: false, error: "还没有可写入图集的媒体记录（请先成功下载至少一条，或确认检查漏下已扫到帖子）" };
  }
  for (const [id, entry] of [...activeMeta.entries()]) {
    if (!(entry.albumWrite && entry.handle === safeHandle)) continue;
    const waiter = albumWaiters.get(id);
    if (waiter) {
      albumWaiters.delete(id);
      waiter.resolve({ ok: false, error: "被新的图集导出替换" });
    }
    try {
      chrome.downloads.cancel(id);
    } catch (err) {
      /* ignore */
    }
    activeMeta.delete(id);
    if (entry.blobUrl) {
      try {
        URL.revokeObjectURL(entry.blobUrl);
      } catch (err) {
        /* SW 上可能没有 revokeObjectURL */
      }
    }
  }

  const html = renderAlbum(safeHandle, album);
  const filename = accountPath(safeHandle, "album.html");
  let dataUrl;
  try {
    dataUrl = albumHtmlToDataUrl(html);
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "图集内容编码失败") };
  }
  if (dataUrl.length > 2_000_000) {
    return { ok: false, error: "图集过大，无法用 data URL 写出，请减少帖子数量后重试" };
  }

  const startDownload = (conflictAction) => {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => {
        cancelPath(dataUrl, filename);
        finish({ id: null, error: "启动图集下载超时" });
      }, 8000);
      reservePath(dataUrl, filename, conflictAction);
      try {
        chrome.downloads.download(
          { url: dataUrl, filename, conflictAction, saveAs: false },
          (id) => {
            clearTimeout(timer);
            if (settled) {
              if (id != null) {
                try {
                  chrome.downloads.cancel(id);
                } catch (err) {
                  /* ignore */
                }
              }
              cancelPath(dataUrl, filename);
              return;
            }
            if (chrome.runtime.lastError || id == null) {
              cancelPath(dataUrl, filename);
              finish({
                id: null,
                error: chrome.runtime.lastError?.message || "无法启动图集下载",
              });
              return;
            }
            activeMeta.set(id, { albumWrite: true, handle: safeHandle });
            finish({ id, error: "" });
          }
        );
      } catch (err) {
        clearTimeout(timer);
        cancelPath(dataUrl, filename);
        finish({
          id: null,
          error: String(err?.message || err || "无法启动图集下载"),
        });
      }
    });
  };

  let started = await startDownload("overwrite");
  if (started.id == null) {
    started = await startDownload("uniquify");
  }
  if (started.id == null) {
    return { ok: false, error: started.error || "无法启动图集下载" };
  }

  const result = await waitAlbumDownload(started.id, 20000);
  if (!result.ok) {
    return { ok: false, error: result.error || "图集文件没有保存成功" };
  }
  await chrome.storage.local.remove(`albumDirty:${safeHandle}`);
  return { ok: true };
}

function safeFilename(name) {
  const cleaned = String(name || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || "media.bin";
}

async function flushDirtyAlbums() {
  const stored = await chrome.storage.local.get(null);
  for (const key of Object.keys(stored || {})) {
    if (!key.startsWith("albumDirty:")) continue;
    const handle = key.slice("albumDirty:".length);
    if (handle) flushAlbum(handle).catch(() => {});
  }
}

flushDirtyAlbums().catch(() => {});
chrome.runtime.onStartup.addListener(() => {
  flushDirtyAlbums().catch(() => {});
});
