(() => {
  if (globalThis.__xMediaDlContent) return;
  globalThis.__xMediaDlContent = true;

  const RESERVED = new Set([
    "home", "explore", "notifications", "messages", "settings", "i", "search",
    "compose", "jobs", "tos", "privacy", "login", "signup", "intent", "share",
    "hashtag", "account", "logout", "download", "about", "oauth",
  ]);

  const captured = new Map();
  const queuedKeys = new Set();
  const skippedKeys = new Set();
  const alreadyKeys = new Set();
  const streamStarted = new Set();
  const streamDone = new Set();
  const streamFailed = new Set();
  const domIndex = new Map();
  let streamsPending = 0;
  let streamEpoch = 0;
  let streamPort = null;
  let savedCursors = { photo: null, video: null };
  let boundary = { photo: "", video: "" };
  let newestSeen = { photo: "", video: "" };
  let newestCreated = { photo: "", video: "" };
  let passedCutoff = false;
  let knownStreak = 0;
  let scanMissed = false;
  let batchScope = "all";
  let savedAtStart = 0;

  let currentHandle = "";
  let acceptLive = false;
  let leftWatch = false;
  let loopRunning = false;
  let stopRequested = false;
  let statsTimer = 0;
  let flushTimer = 0;
  let flushFails = 0;
  let pending = [];
  let panelHost = null;
  let soloPort = null;
  const soloButtons = new Map();
  let lastDownloads = { completed: 0, failed: 0, queued: 0, active: 0 };
  let view = {
    running: false,
    phase: "idle",
    message: "打开用户主页后点开始。插件会进入媒体页，慢慢向下加载并保存。",
    handle: "",
    found: 0,
    skipped: 0,
    already: 0,
    mode: "download",
    scope: "all",
  };

  const sleep = (ms) => new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (stopRequested || Date.now() >= end) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(200, end - Date.now()));
    };
    tick();
  });

  function parseProfile(pathname) {
    const parts = String(pathname || "").split("/").filter(Boolean);
    if (!parts.length || RESERVED.has(parts[0].toLowerCase())) return null;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(parts[0])) return null;
    return { handle: parts[0], section: parts[1] || "" };
  }

  function isMediaPath(handle) {
    const profile = parseProfile(location.pathname);
    return !!profile && profile.handle.toLowerCase() === handle.toLowerCase() && profile.section === "media";
  }

  function send(message, attempt = 0) {
    if (!chrome.runtime?.id) return Promise.resolve(null);
    let pending;
    try {
      pending = chrome.runtime.sendMessage(message);
    } catch (err) {
      pending = Promise.reject(err);
    }
    return Promise.resolve(pending).then(
      (response) => response ?? null,
      () => {
        if (attempt >= 4) return null;
        return new Promise((resolve) => {
          setTimeout(() => resolve(send(message, attempt + 1)), 250 * (attempt + 1));
        });
      }
    );
  }

  function refreshDownloads() {
    send({ type: "GET_DOWNLOADS" })
      .then((stats) => {
        if (!stats || typeof stats.completed !== "number") return;
        lastDownloads = stats;
        renderPanel();
      })
      .catch(() => {});
  }

  function patchJob(partial) {
    view = { ...view, ...partial, updatedAt: Date.now() };
    renderPanel();
    mirrorStatus();
    refreshDownloads();
    return Promise.resolve();
  }

  function writePending(handle, view) {
    const target = view === "video" || view === "photo" ? view : viewName();
    try {
      sessionStorage.setItem("x-media-dl-pending", JSON.stringify({
        handle,
        at: Date.now(),
        mode: scanMissed ? "scan" : "download",
        view: target,
        scope: batchScope,
      }));
    } catch (err) {
      /* 页面不允许会话存储时，整页跳转后需要再点一次开始 */
    }
  }

  function readPending() {
    try {
      const raw = sessionStorage.getItem("x-media-dl-pending");
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function clearPending() {
    try {
      sessionStorage.removeItem("x-media-dl-pending");
    } catch (err) {
      /* ignore */
    }
  }

  function scheduleStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      patchJob({
        handle: currentHandle,
        found: queuedKeys.size,
        skipped: skippedKeys.size,
        already: alreadyKeys.size,
      });
    }, 350);
  }

  function authorOk(author) {
    if (!author) return true;
    if (!currentHandle) return false;
    return author.toLowerCase() === currentHandle.toLowerCase();
  }

  function formatDate(created) {
    if (!created) return "undated";
    const date = new Date(created);
    if (Number.isNaN(date.getTime())) return "undated";
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function buildFilename(item) {
    const tweet = /^\d{6,}$/.test(item.tweetId || "") ? item.tweetId : "post";
    const index = Number.isInteger(item.index) && item.index > 0 ? item.index : 1;
    const ext = String(item.ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    return `${formatDate(item.created)}_${tweet}_${index}.${ext}`;
  }

  function extOf(url, fallback) {
    try {
      const parsed = new URL(url);
      const format = parsed.searchParams.get("format");
      if (format && /^[a-z0-9]+$/i.test(format)) return format.toLowerCase();
      const matched = parsed.pathname.match(/\.([a-z0-9]+)$/i);
      if (matched) return matched[1].toLowerCase();
    } catch (err) {
      /* use fallback */
    }
    return fallback;
  }

  function remember(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item?.key) continue;
      const previous = captured.get(item.key);
      if (!previous) captured.set(item.key, item);
      else if (!previous.text && item.text) previous.text = item.text;
      if (acceptLive) handleIncoming(item);
    }
  }

  function viewName() {
    if (new URLSearchParams(location.search).get("filter") === "photo") return "photo";
    for (const tab of document.querySelectorAll('[role="tab"][aria-selected="true"], a[aria-selected="true"]')) {
      const label = (tab.textContent || "").replace(/\s+/g, " ").trim();
      if (/^(照片|圖片|图片|Photos?)$/i.test(label)) return "photo";
      if (/^(视频|視頻|Videos?)$/i.test(label)) return "video";
      try {
        const href = tab.getAttribute("href") || tab.href || "";
        if (!href) continue;
        const url = new URL(href, location.origin);
        if (!/\/media\/?$/i.test(url.pathname.replace(/\/+$/, "") + "/") && !/\/media$/i.test(url.pathname.replace(/\/+$/, ""))) continue;
        if (url.searchParams.get("filter") === "photo") return "photo";
      } catch (err) {
        /* ignore */
      }
    }
    return "video";
  }

  function viewLabel() {
    return viewName() === "photo" ? "照片" : "视频";
  }

  function seenViews() {
    try {
      const raw = sessionStorage.getItem("x-media-dl-views");
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch (err) {
      return new Set();
    }
  }

  function addSeenView(name) {
    const views = seenViews();
    views.add(name);
    try {
      sessionStorage.setItem("x-media-dl-views", JSON.stringify([...views]));
    } catch (err) {
      /* 记不住已看过的栏目时，这一栏下完就结束 */
    }
  }

  function clearSeenViews() {
    try {
      sessionStorage.removeItem("x-media-dl-views");
    } catch (err) {
      /* ignore */
    }
  }

  function itemView(item) {
    return item?.kind === "photo" ? "photo" : "video";
  }

  function newerTweet(nextId, prevId) {
    if (!/^\d{6,}$/.test(nextId || "")) return false;
    if (!/^\d{6,}$/.test(prevId || "")) return true;
    try {
      return BigInt(nextId) > BigInt(prevId);
    } catch (err) {
      return nextId > prevId;
    }
  }

  function rememberNewest(item) {
    const view = itemView(item);
    const tweetId = String(item?.tweetId || "");
    if (!/^\d{6,}$/.test(tweetId)) return;
    if (!newestSeen[view] || newerTweet(tweetId, newestSeen[view])) {
      newestSeen[view] = tweetId;
      newestCreated[view] = item.created || "";
    }
  }

  function olderThanCutoff(item) {
    if (scanMissed) return false;
    const view = itemView(item);
    const limit = boundary[view] || savedCursors[view]?.tweetId || "";
    const tweetId = String(item?.tweetId || "");
    if (!limit || view !== viewName()) return false;
    return olderId(tweetId, limit);
  }

  function cursorLabel(cursor) {
    if (!cursor?.tweetId) return "";
    const fromCreated = formatDate(cursor.created);
    if (fromCreated !== "undated") return fromCreated;
    try {
      const ms = Number((BigInt(cursor.tweetId) >> 22n) + 1288834974657n);
      if (!Number.isFinite(ms)) return "";
      return formatDate(new Date(ms).toISOString());
    } catch (err) {
      return "";
    }
  }

  function olderId(nextId, prevId) {
    if (!/^\d{6,}$/.test(nextId || "") || !/^\d{6,}$/.test(prevId || "")) return false;
    try {
      return BigInt(nextId) < BigInt(prevId);
    } catch (err) {
      return false;
    }
  }

  function noteBoundary(item, already) {
    rememberNewest(item);
    const view = itemView(item);
    if (view !== viewName()) return;
    const tweetId = String(item?.tweetId || "");
    if (!/^\d{6,}$/.test(tweetId)) {
      knownStreak = already ? knownStreak + 1 : 0;
      return;
    }
    if (!scanMissed && boundary[view] && olderId(tweetId, boundary[view])) {
      passedCutoff = true;
      return;
    }
    if (already && (!boundary[view] || newerTweet(tweetId, boundary[view]))) boundary[view] = tweetId;
    knownStreak = already ? knownStreak + 1 : 0;
  }

  function canStopAtCursor() {
    if (scanMissed) return false;
    const view = viewName();
    return !!(boundary[view] || savedCursors[view]?.tweetId);
  }

  async function commitCursor() {
    for (const name of ["photo", "video"]) {
      const tweetId = newestSeen[name];
      if (!tweetId) continue;
      const prev = savedCursors[name]?.tweetId;
      if (prev && !newerTweet(tweetId, prev)) continue;
      await send({
        type: "COMMIT_CURSOR",
        handle: currentHandle,
        view: name,
        tweetId,
        created: newestCreated[name] || "",
      });
      savedCursors[name] = { tweetId, created: newestCreated[name] || "" };
    }
  }

  function normalizeScope(value) {
    return value === "photo" || value === "video" ? value : "all";
  }

  function scopeLabel(scope) {
    if (scope === "photo") return "照片";
    if (scope === "video") return "视频";
    return "照片和视频";
  }

  function acceptsItem(item) {
    const kind = itemView(item);
    if (batchScope !== "all" && kind !== batchScope) return false;
    return kind === viewName();
  }

  function handleIncoming(item) {
    if (!item?.key || !authorOk(item.author)) return;
    if (!acceptsItem(item)) return;
    if (olderThanCutoff(item)) {
      passedCutoff = true;
      rememberNewest(item);
      return;
    }
    if (item.skipped) {
      if (!skippedKeys.has(item.key)) {
        skippedKeys.add(item.key);
        scheduleStats();
      }
      return;
    }
    if (item.kind === "stream") {
      startStream(item);
      return;
    }
    if (!item.url) return;
    bufferEnqueue({
      key: item.key,
      url: item.url,
      filename: buildFilename(item),
      tweetId: item.tweetId || "",
      created: item.created || "",
      text: item.text || "",
      view: itemView(item),
      kind: item.kind || "photo",
    });
  }

  function bufferEnqueue(item) {
    if (!item?.key || queuedKeys.has(item.key)) return;
    queuedKeys.add(item.key);
    pending.push(item);
    scheduleStats();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushQueue().catch(() => {});
    }, 250);
  }

  async function flushQueue() {
    clearTimeout(flushTimer);
    const batch = pending.splice(0, pending.length);
    if (!batch.length) return;
    const response = await send({ type: "ENQUEUE", handle: currentHandle, items: batch });
    if (!response) {
      flushFails += 1;
      pending.unshift(...batch);
      if (flushFails < 3 && chrome.runtime?.id) {
        clearTimeout(flushTimer);
        flushTimer = setTimeout(() => flushQueue().catch(() => {}), 1000);
      }
      return;
    }
    flushFails = 0;
    const already = new Set(response.alreadyKeys || []);
    for (const item of batch) {
      if (already.has(item.key)) {
        alreadyKeys.add(item.key);
        noteBoundary(item, true);
      } else {
        noteBoundary(item, false);
      }
    }
    if (already.size) scheduleStats();
  }

  async function startStream(item) {
    if (!item?.playlistUrl || streamStarted.has(item.key) || streamDone.has(item.key)) return;
    streamStarted.add(item.key);
    queuedKeys.add(item.key);
    streamsPending += 1;
    scheduleStats();
    const response = await send({ type: "HAS_DONE", handle: currentHandle, keys: [item.key] });
    if (response?.done?.includes(item.key)) {
      alreadyKeys.add(item.key);
      noteBoundary(item, true);
      streamDone.add(item.key);
      streamsPending = Math.max(0, streamsPending - 1);
      scheduleStats();
      await send({
        type: "NOTE_ALBUM",
        handle: currentHandle,
        items: [{
          key: item.key,
          filename: buildFilename(item),
          tweetId: item.tweetId || "",
          created: item.created || "",
          text: item.text || "",
          kind: "video",
          view: "video",
        }],
      });
      return;
    }
    noteBoundary(item, false);
    if (stopRequested) {
      streamsPending = Math.max(0, streamsPending - 1);
      streamStarted.delete(item.key);
      return;
    }
    window.postMessage({
      source: "x-media-dl",
      type: "assemble",
      epoch: streamEpoch,
      item: {
        key: item.key,
        playlistUrl: item.playlistUrl,
        author: item.author || "",
        tweetId: item.tweetId || "",
        created: item.created || "",
        text: item.text || "",
        index: item.index || 1,
      },
    }, "*");
  }

  function closeStreamPort() {
    if (!streamPort) return;
    try {
      streamPort.postMessage({ type: "abort" });
      streamPort.disconnect();
    } catch (err) {
      /* 端口已经关掉 */
    }
    streamPort = null;
  }

  function onStreamMessage(data) {
    if (data.solo || data.file?.solo) {
      onSoloStream(data);
      return;
    }
    if (data.epoch !== streamEpoch) return;
    if (data.type === "stream-progress" && view.phase === "downloading") {
      patchJob({ message: `正在把流媒体拼成视频（${data.got}/${data.total}）…` });
      return;
    }
    if (data.type === "stream-fail") {
      streamFailed.add(data.key);
      streamsPending = Math.max(0, streamsPending - 1);
      scheduleStats();
      return;
    }
    if (data.type === "stream-start") {
      closeStreamPort();
      const file = data.file || {};
      if (!authorOk(file.author)) return;
      streamPort = chrome.runtime.connect({ name: "stream-file" });
      streamPort.postMessage({
        type: "start",
        handle: currentHandle,
        key: file.key,
        filename: buildFilename(file),
        ext: file.ext === "mp4" ? "mp4" : "ts",
        tweetId: file.tweetId || "",
        created: file.created || "",
        text: file.text || "",
        view: "video",
      });
      return;
    }
    if (data.type === "stream-chunk" && streamPort && data.buffer) {
      streamPort.postMessage({ type: "chunk", buffer: data.buffer }, [data.buffer]);
      return;
    }
    if (data.type === "stream-end") {
      if (streamPort) streamPort.postMessage({ type: "end" });
      streamPort = null;
      streamDone.add(data.key);
      streamsPending = Math.max(0, streamsPending - 1);
      scheduleStats();
    }
  }

  function onSoloStream(data) {
    const file = data.file || {};
    if (data.type === "stream-start") {
      if (soloPort) {
        try {
          soloPort.disconnect();
        } catch (err) {
          /* 上一条单帖视频已经结束 */
        }
      }
      const handle = file.folder || file.author || "";
      if (!handle) return;
      soloPort = chrome.runtime.connect({ name: "stream-file" });
      soloPort.postMessage({
        type: "start",
        handle,
        key: file.key,
        filename: buildFilename(file),
        ext: file.ext === "mp4" ? "mp4" : "ts",
        tweetId: file.tweetId || "",
        created: file.created || "",
        text: file.text || "",
        view: "video",
        solo: true,
        trackCursor: false,
      });
      return;
    }
    if (data.type === "stream-chunk" && soloPort && data.buffer) {
      soloPort.postMessage({ type: "chunk", buffer: data.buffer }, [data.buffer]);
      return;
    }
    if (data.type === "stream-end") {
      if (soloPort) soloPort.postMessage({ type: "end" });
      soloPort = null;
      setTweetButton(soloButtons.get(data.key), "ok", phoneDownload() ? "已开始下载，文件名以账号名开头，在「下载」里" : "已开始下载，文件在该账号的文件夹里");
      return;
    }
    if (data.type === "stream-fail") {
      setTweetButton(soloButtons.get(data.key), "fail", "这条视频没有保存下来");
    }
  }

  window.addEventListener("message", (event) => {
    if (event.data?.source === "x-media-dl" && event.data.type === "command") {
      onCommand({ detail: event.data.command });
      return;
    }
    if (event.source !== window || event.data?.source !== "x-media-dl") return;
    if (event.data.type === "reset") {
      if (!event.data.sameAccount) {
        captured.clear();
        domIndex.clear();
      }
      if (leftWatch && currentHandle && !isMediaPath(currentHandle)) {
        stopJob("已离开媒体页，下载已停下。回到该账号的媒体页后可以继续。");
      }
      return;
    }
    if (event.data.type === "media") {
      remember(event.data.items);
      return;
    }
    if (event.data.type?.startsWith("stream-")) onStreamMessage(event.data);
  });

  function rawUrls(node) {
    const chunks = [];
    if (node.currentSrc) chunks.push(node.currentSrc);
    if (node.src) chunks.push(node.src);
    const attr = node.getAttribute?.("src") || node.getAttribute?.("srcset") || node.getAttribute?.("style") || "";
    if (attr) chunks.push(attr);
    const out = [];
    for (const chunk of chunks) {
      const text = String(chunk);
      const matches = text.match(/https?:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+[^"'\\\s)]*/gi);
      if (matches) out.push(...matches);
      else if (/^https?:/i.test(text)) out.push(text);
    }
    return out;
  }

  function scanDom() {
    const root = document.querySelector("[data-testid='primaryColumn']") || document.querySelector("main");
    if (!root) return;
    const nodes = root.querySelectorAll("img, source, [style*='twimg.com']");
    for (const node of nodes) {
      if (node.closest("[data-testid^='UserAvatar']")) continue;
      const link = node.closest("a[href*='/status/']")
        || node.closest("article, li[role='listitem']")?.querySelector("a[href*='/status/']");
      const href = link?.href || "";
      const authorMatch = href.match(/https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//i);
      if (authorMatch && !authorOk(authorMatch[1])) continue;
      const tweetMatch = href.match(/status\/(\d+)/);
      const tweetId = tweetMatch ? tweetMatch[1] : "";
      const created = node.closest("article")?.querySelector("time")?.getAttribute("datetime") || "";
      for (const raw of rawUrls(node)) {
        const photo = domPhoto(raw);
        if (!photo || queuedKeys.has(photo.key) || domIndex.has(photo.key)) continue;
        const bucket = tweetId || photo.key;
        const index = (domIndex.get(bucket) || 0) + 1;
        domIndex.set(bucket, index);
        domIndex.set(photo.key, index);
        remember([{
          key: photo.key,
          url: photo.url,
          kind: "photo",
          ext: photo.ext,
          author: currentHandle,
          tweetId,
          created,
          index,
        }]);
      }
    }
  }

  function domPhoto(raw) {
    try {
      const url = new URL(raw, location.origin);
      if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || !url.pathname.includes("/media/")) return null;
      url.searchParams.set("name", "orig");
      const matched = url.pathname.match(/\/media\/([^/?]+)/);
      const id = matched?.[1]?.replace(/\.(jpe?g|png|webp)$/i, "");
      if (!id) return null;
      return { key: `photo:${id}`, url: url.toString(), ext: extOf(url.toString(), "jpg") };
    } catch (err) {
      return null;
    }
  }

  const TWEET_ICON = `<svg viewBox="0 0 24 24" width="18.75" height="18.75" aria-hidden="true"><path fill="currentColor" d="M12 3.5a.75.75 0 0 1 .75.75v8.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V4.25A.75.75 0 0 1 12 3.5zM4.75 18.25a.75.75 0 0 0 0 1.5h14.5a.75.75 0 0 0 0-1.5H4.75z"/></svg>`;

  function setTweetButton(button, state, title) {
    if (!button) return;
    button.dataset.state = state;
    button.dataset.busy = state === "busy" ? "1" : "0";
    button.title = title;
    button.setAttribute("aria-label", title);
  }

  function articleText(article) {
    const node = article.querySelector("[data-testid='tweetText']");
    if (!node) return "";
    return String(node.innerText || node.textContent || "").replace(/\r\n/g, "\n").trim();
  }

  function tweetIdentity(article) {
    const time = article.querySelector("time");
    const link = time?.closest("a[href*='/status/']");
    const href = link?.href || "";
    const match = href.match(/https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
    if (!match) return null;
    return {
      handle: match[1],
      tweetId: match[2],
      created: time.getAttribute("datetime") || "",
    };
  }

  function outsideQuote(node, article) {
    const quote = node.closest("[data-testid='quoteTweet']");
    return !quote || !article.contains(quote);
  }

  function collectTweetItems(article, info) {
    const items = [];
    const seen = new Set();
    const text = articleText(article);
    const add = (item) => {
      if (!item?.key || seen.has(item.key) || item.skipped) return;
      seen.add(item.key);
      if (!item.text && text) item = { ...item, text };
      items.push(item);
    };
    for (const item of captured.values()) {
      if (String(item.tweetId || "") !== info.tweetId) continue;
      add(item);
    }
    let photoIndex = items.filter((item) => item.kind === "photo").length;
    const nodes = article.querySelectorAll("img, source, [style*='twimg.com']");
    for (const node of nodes) {
      if (!outsideQuote(node, article)) continue;
      if (node.closest("[data-testid^='UserAvatar']")) continue;
      for (const raw of rawUrls(node)) {
        const photo = domPhoto(raw);
        if (!photo) continue;
        photoIndex += 1;
        add({
          key: photo.key,
          url: photo.url,
          kind: "photo",
          ext: photo.ext,
          author: info.handle,
          tweetId: info.tweetId,
          created: info.created,
          text,
          index: photoIndex,
        });
      }
    }
    let videoIndex = items.filter((item) => item.kind === "video" || item.kind === "stream").length;
    if (!videoIndex) {
      for (const video of article.querySelectorAll("video, source")) {
      if (!outsideQuote(video, article)) continue;
      const src = video.currentSrc || video.src || video.getAttribute?.("src") || "";
      if (!/video\.twimg\.com/i.test(src) || src.startsWith("blob:")) continue;
      let url = "";
      try {
        const parsed = new URL(src);
        if (parsed.protocol === "https:" && parsed.hostname === "video.twimg.com") url = parsed.toString();
      } catch (err) {
        url = "";
      }
      if (!url) continue;
      videoIndex += 1;
      const key = `video:${url}`;
      add({
        key,
        url: /\.m3u8(\?|$)/i.test(url) ? "" : url,
        playlistUrl: /\.m3u8(\?|$)/i.test(url) ? url : "",
        kind: /\.m3u8(\?|$)/i.test(url) ? "stream" : "video",
        ext: /\.m3u8(\?|$)/i.test(url) ? "ts" : "mp4",
        author: info.handle,
        tweetId: info.tweetId,
        created: info.created,
        text,
        index: videoIndex,
      });
      }
    }
    return items;
  }

  function tweetHasVideo(article) {
    for (const node of article.querySelectorAll("[data-testid='videoPlayer'], [data-testid='videoComponent'], video")) {
      if (outsideQuote(node, article)) return true;
    }
    return false;
  }

  async function saveTweet(article, button) {
    if (button.dataset.busy === "1") return;
    const info = tweetIdentity(article);
    if (!info) {
      setTweetButton(button, "fail", "没有找到这条帖子");
      return;
    }
    setTweetButton(button, "busy", "正在查找这条里的照片和视频…");
    window.postMessage({ source: "x-media-dl", type: "pull" }, "*");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const items = collectTweetItems(article, info);
    const files = items.filter((item) => item.url && (item.kind === "photo" || item.kind === "video"));
    const streams = items.filter((item) => item.kind === "stream" && item.playlistUrl);
    const videoMissing = tweetHasVideo(article) && !files.some((item) => item.kind === "video") && !streams.length;
    if (!files.length && !streams.length) {
      setTweetButton(button, "empty", videoMissing
        ? "视频地址还没出现。请先点开这条视频，再点下载。"
        : "这条没有可下载的照片或视频");
      return;
    }
    const captionText = files.find((item) => item.text)?.text
      || streams.find((item) => item.text)?.text
      || articleText(article);
    const payload = files.map((item) => ({
      key: item.key,
      url: item.url,
      filename: buildFilename(item),
      tweetId: info.tweetId,
      created: item.created || info.created,
      text: item.text || captionText || "",
      view: item.kind === "video" ? "video" : "photo",
      kind: item.kind === "video" ? "video" : "photo",
      solo: true,
      trackCursor: false,
    }));
    let already = 0;
    let started = 0;
    if (payload.length) {
      const response = await send({ type: "ENQUEUE", handle: info.handle, items: payload });
      if (!response) {
        setTweetButton(button, "fail", "下载没发出去。请重新加载插件后再试。");
        return;
      }
      already += (response.alreadyKeys || []).length;
      started += payload.length - (response.alreadyKeys || []).length;
      send({ type: "FLUSH_ALBUM", handle: info.handle }).catch(() => {});
    }
    for (const item of streams) {
      const response = await send({ type: "HAS_DONE", handle: info.handle, keys: [item.key] });
      if (response?.done?.includes(item.key)) {
        already += 1;
        continue;
      }
      started += 1;
      soloButtons.set(item.key, button);
      window.postMessage({
        source: "x-media-dl",
        type: "assemble",
        epoch: streamEpoch,
        item: {
          key: item.key,
          playlistUrl: item.playlistUrl,
          author: info.handle,
          folder: info.handle,
          tweetId: info.tweetId,
          created: item.created || info.created,
          text: item.text || captionText || "",
          index: item.index || 1,
          solo: true,
          trackCursor: false,
        },
      }, "*");
    }
    if (!started && already) {
      setTweetButton(button, "ok", "这条里的照片和视频已经保存过了");
      return;
    }
    const extra = videoMissing ? "视频请先点开再下一次。" : "";
    setTweetButton(button, "ok", (phoneDownload()
      ? `已开始下载，文件名以 ${info.handle} 开头，在「下载」里。可用浏览器打开 album.html 看图和文案。`
      : `已开始下载到 @${info.handle} 文件夹。打开里面的 album.html 可看图和文案。`) + extra);
  }

  function mountTweetButtons() {
    if (!document.getElementById("x-media-dl-tweet-style")) {
      const style = document.createElement("style");
      style.id = "x-media-dl-tweet-style";
      style.textContent = `
        button.x-media-dl-tweet {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          padding: 0;
          border: 0;
          border-radius: 999px;
          background: transparent;
          color: inherit;
          cursor: pointer;
        }
        button.x-media-dl-tweet:hover { background: rgba(29, 155, 240, 0.12); color: #1d9bf0; }
        button.x-media-dl-tweet[data-state="ok"] { color: #00ba7c; }
        button.x-media-dl-tweet[data-state="fail"],
        button.x-media-dl-tweet[data-state="empty"] { color: #f4212e; }
        button.x-media-dl-tweet[data-state="busy"] { opacity: 0.45; cursor: default; }
      `;
      (document.documentElement || document.head).appendChild(style);
    }
    for (const article of document.querySelectorAll("article")) {
      const reply = article.querySelector("[data-testid='reply']");
      const group = reply?.closest("[role='group']");
      if (!group || group.querySelector("[data-x-media-dl-btn]")) continue;
      const sample = reply.parentElement;
      const slot = document.createElement("div");
      slot.dataset.xMediaDlSlot = "1";
      if (sample && sample.parentElement === group && sample.className) slot.className = sample.className;
      else slot.style.cssText = "display:flex;flex:1 1 0%;justify-content:center;align-items:center;";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "x-media-dl-tweet";
      button.dataset.xMediaDlBtn = "1";
      button.title = "下载这条的照片和视频";
      button.setAttribute("aria-label", "下载这条的照片和视频");
      button.innerHTML = TWEET_ICON;
      const halt = (event) => event.stopPropagation();
      button.addEventListener("pointerdown", halt);
      button.addEventListener("mousedown", halt);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        saveTweet(article, button).catch(() => {
          setTweetButton(button, "fail", "下载失败");
        });
      });
      slot.appendChild(button);
      group.appendChild(slot);
    }
  }

  function watchTweets() {
    let timer = 0;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        mountTweetButtons();
      }, 200);
    };
    const root = document.documentElement;
    if (!root) return;
    mountTweetButtons();
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  }

  function findMediaLink(handle) {
    const want = `/${handle}/media`.toLowerCase();
    for (const anchor of document.querySelectorAll("a[href]")) {
      try {
        const path = new URL(anchor.href).pathname.replace(/\/+$/, "").toLowerCase();
        if (path === want) return anchor;
      } catch (err) {
        /* ignore bad href */
      }
    }
    return null;
  }

  function waitFor(fn, timeout) {
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (stopRequested) {
          resolve(false);
          return;
        }
        if (fn()) {
          resolve(true);
          return;
        }
        if (Date.now() - start > timeout) {
          resolve(false);
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function switchTries(view) {
    try {
      const raw = sessionStorage.getItem("x-media-dl-switch");
      const prev = raw ? JSON.parse(raw) : null;
      if (!prev || prev.view !== view || Date.now() - prev.at > 20000) return 0;
      return prev.tries || 0;
    } catch (err) {
      return 0;
    }
  }

  function noteSwitch(view) {
    const tries = switchTries(view) + 1;
    try {
      sessionStorage.setItem("x-media-dl-switch", JSON.stringify({ view, tries, at: Date.now() }));
    } catch (err) {
      /* 记不住次数时，最多再跳一次 */
    }
    return tries;
  }

  function clearSwitch() {
    try {
      sessionStorage.removeItem("x-media-dl-switch");
    } catch (err) {
      /* ignore */
    }
  }

  function firstView() {
    return batchScope === "video" ? "video" : "photo";
  }

  async function ensureMediaTab(handle, resumeView) {
    const want = resumeView === "video" || resumeView === "photo" ? resumeView : firstView();
    if (!isMediaPath(handle)) {
      const link = findMediaLink(handle);
      if (link && want === "photo") {
        link.click();
        const ok = await waitFor(() => isMediaPath(handle), 10000);
        if (ok && viewName() === "photo") return "ok";
      }
      return openView(want);
    }
    if (viewName() === want) {
      clearSwitch();
      return "ok";
    }
    if (resumeView && switchTries(resumeView) >= 1) {
      stopRequested = true;
      await patchJob({
        running: false,
        phase: "paused",
        message: want === "video"
          ? "视频栏打不开。请手动点一下「视频」，再点继续。"
          : "照片栏打不开。请手动点一下「照片」，再点继续。",
      });
      return "stopped";
    }
    return openView(want);
  }

  function pageBlocked() {
    const nodes = document.querySelectorAll("[data-testid='error-detail'], [data-testid='empty_state_header_text']");
    for (const node of nodes) {
      const text = node.textContent || "";
      if (/something went wrong|try reloading|try again|rate limit|出错了|请重试|过于频繁/i.test(text)) return true;
    }
    return false;
  }

  function clickRetry() {
    for (const button of document.querySelectorAll("[role='button']")) {
      if (/^(retry|重试)$/i.test((button.textContent || "").trim())) {
        button.click();
        return;
      }
    }
  }

  function oldestVisibleId() {
    const root = document.querySelector("[data-testid='primaryColumn']") || document.querySelector("main");
    if (!root) return "";
    let oldest = "";
    for (const link of root.querySelectorAll("a[href*='/status/']")) {
      const match = link.href.match(/status\/(\d+)/);
      if (!match) continue;
      if (!oldest || olderId(match[1], oldest)) oldest = match[1];
    }
    return oldest;
  }

  function findViewLink(kind) {
    const want = `/${currentHandle}/media`.toLowerCase();
    for (const anchor of document.querySelectorAll("a[href]")) {
      try {
        const url = new URL(anchor.href);
        if (url.pathname.replace(/\/+$/, "").toLowerCase() !== want) continue;
        const photo = url.searchParams.get("filter") === "photo";
        if (kind === "photo" ? photo : !photo) return anchor;
      } catch (err) {
        /* ignore bad href */
      }
    }
    for (const tab of document.querySelectorAll('[role="tab"], a[role="tab"]')) {
      const label = (tab.textContent || "").replace(/\s+/g, " ").trim();
      if (kind === "photo" && /^(照片|圖片|图片|Photos?)$/i.test(label)) return tab;
      if (kind === "video" && /^(视频|視頻|Videos?)$/i.test(label)) return tab;
    }
    return null;
  }

  async function openView(kind) {
    if (isMediaPath(currentHandle) && viewName() === kind) return "ok";
    const label = kind === "photo" ? "照片" : "视频";
    await patchJob({
      phase: "scrolling",
      running: true,
      message: `正在打开${label}…`,
    });
    const link = findViewLink(kind);
    if (link) {
      writePending(currentHandle, kind);
      link.click();
      const ok = await waitFor(() => isMediaPath(currentHandle) && viewName() === kind, 8000);
      if (ok) {
        if (stopRequested) return "stopped";
        clearPending();
        clearSwitch();
        window.scrollTo(0, 0);
        await sleep(1200);
        if (stopRequested) return "stopped";
        return "ok";
      }
    }
    if (stopRequested) return "stopped";
    if (noteSwitch(kind) > 2) {
      stopRequested = true;
      await patchJob({
        running: false,
        phase: "paused",
        message: kind === "video"
          ? "视频栏打不开。请手动点一下「视频」，再点继续。"
          : "照片栏打不开。请手动点一下「照片」，再点继续。",
      });
      return "stopped";
    }
    writePending(currentHandle, kind);
    const base = `${location.origin}/${currentHandle}/media`;
    location.assign(kind === "photo" ? `${base}?filter=photo` : base);
    return "navigating";
  }

  async function openOtherView() {
    if (batchScope !== "all") return false;
    addSeenView(viewName());
    const next = viewName() === "photo" ? "video" : "photo";
    if (seenViews().has(next)) return false;
    await patchJob({
      phase: "scrolling",
      running: true,
      message: scanMissed
        ? (next === "photo" ? "视频查完了，接着检查照片…" : "照片查完了，接着检查视频…")
        : (next === "photo" ? "视频下完了，接着打开照片…" : "照片下完了，接着下载视频…"),
    });
    const link = findViewLink(next);
    if (link) {
      writePending(currentHandle, next);
      link.click();
      const ok = await waitFor(() => viewName() === next, 8000);
      if (ok) {
        if (stopRequested) return false;
        clearPending();
        clearSwitch();
        addSeenView(next);
        window.scrollTo(0, 0);
        await sleep(1200);
        if (stopRequested) return false;
        return true;
      }
    }
    if (stopRequested) return false;
    if (noteSwitch(next) > 2) {
      stopRequested = true;
      await patchJob({
        running: false,
        phase: "paused",
        message: "照片已经下完，但视频栏打不开。请手动点一下「视频」，再点继续。",
      });
      return false;
    }
    writePending(currentHandle, next);
    const base = `${location.origin}/${currentHandle}/media`;
    location.assign(next === "photo" ? `${base}?filter=photo` : base);
    return "navigating";
  }

  function scrollStep() {
    const root = document.querySelector("[data-testid='primaryColumn']") || document.querySelector("main");
    const cells = root?.querySelectorAll("article, li[role='listitem'], [data-testid='tweetPhoto']");
    const last = cells?.[cells.length - 1];
    if (last) last.scrollIntoView({ block: "end", behavior: "auto" });
    const distance = Math.floor(window.innerHeight * (0.28 + Math.random() * 0.22));
    window.scrollBy(0, distance);
    let el = document.querySelector("[data-testid='primaryColumn']");
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 80) {
        el.scrollTop += distance;
      }
      el = el.parentElement;
    }
  }

  async function runScroll() {
    let rounds = 0;
    let blocks = 0;
    let floorId = "";
    let floorStill = 0;
    await sleep(800);
    while (!stopRequested) {
      if (document.visibilityState !== "visible") {
        await patchJob({ phase: "scrolling", running: true, message: "请切回这个标签页，页面才会继续向下加载。" });
        await sleep(800);
        continue;
      }
      scanDom();
      if (pageBlocked()) {
        blocks += 1;
        if (blocks >= 4) {
          await patchJob({
            running: false,
            phase: "paused",
            message: "X 暂时不再往下加载。已发现的文件会继续保存，稍后再点继续。",
          });
          return "paused";
        }
        await patchJob({
          phase: "scrolling",
          running: true,
          message: `页面加载受限，先等 30 秒再继续（${blocks}/4）。`,
        });
        clickRetry();
        await sleep(30000);
        continue;
      }
      const beforeFound = queuedKeys.size;
      scrollStep();
      rounds += 1;
      await sleep(1500 + Math.floor(Math.random() * 1400));
      if (stopRequested) return "stopped";
      scanDom();
      await flushQueue();
      if (stopRequested) return "stopped";
      const grew = queuedKeys.size > beforeFound;
      const oldest = oldestVisibleId();
      if (grew || (oldest && (!floorId || olderId(oldest, floorId)))) {
        if (oldest && (!floorId || olderId(oldest, floorId))) floorId = oldest;
        floorStill = 0;
      } else {
        floorStill += 1;
      }
      const since = cursorLabel(savedCursors[viewName()]);
      const settling = floorStill >= 2;
      await patchJob({
        phase: "scrolling",
        running: true,
        handle: currentHandle,
        found: queuedKeys.size,
        skipped: skippedKeys.size,
        already: alreadyKeys.size,
        message: scanMissed
          ? (settling
            ? (batchScope === "all"
              ? `${viewLabel()}已经不再往下了，确认后去检查另一栏 … 已发现 ${queuedKeys.size} 个`
              : `${viewLabel()}已经到底了，确认后就结束 … 已发现 ${queuedKeys.size} 个`)
            : `正在检查${viewLabel()}，漏下的会补上 … 已发现 ${queuedKeys.size} 个`)
          : since
            ? `正在找比 ${since} 更新的${viewLabel()} … 已发现 ${queuedKeys.size} 个`
            : `正在向下加载 @${currentHandle} 的${viewLabel()} … 已发现 ${queuedKeys.size} 个`,
      });
      if (!scanMissed && canStopAtCursor() && (passedCutoff || knownStreak >= 40)) {
        await commitCursor();
        const switched = await openOtherView();
        if (switched === "navigating") return "navigating";
        if (switched) {
          passedCutoff = false;
          knownStreak = 0;
          floorId = "";
          floorStill = 0;
          for (const item of captured.values()) handleIncoming(item);
          await flushQueue();
          continue;
        }
        return "caughtup";
      }
      if (floorStill >= 12) {
        const switched = await openOtherView();
        if (switched === "navigating") return "navigating";
        if (switched) {
          passedCutoff = false;
          knownStreak = 0;
          floorId = "";
          floorStill = 0;
          for (const item of captured.values()) handleIncoming(item);
          await flushQueue();
          continue;
        }
        // 滚得不够深时不要记下光标，否则下次会误以为「已经下到最新」而跳过更早的内容
        if (rounds >= 30) await commitCursor();
        return "drained";
      }
      if (rounds >= 4000) {
        await patchJob({
          running: false,
          phase: "paused",
          message: "这次已经滚动了很久。点继续可以接着往下，已保存的文件会跳过。",
        });
        return "paused";
      }
    }
    return "stopped";
  }

  async function waitDownloads() {
    await patchJob({
      phase: "downloading",
      running: true,
      message: streamsPending ? "正在把已加载的流媒体拼成视频文件…" : "媒体页已经滚完，正在把文件保存到下载目录…",
    });
    let idleTicks = 0;
    while (!stopRequested) {
      const stats = await send({ type: "GET_DOWNLOADS" });
      const downloads = stats && typeof stats.completed === "number" ? stats : lastDownloads;
      lastDownloads = downloads;
      renderPanel();
      const pendingCount = (downloads.queued || 0) + (downloads.active || 0) + streamsPending;
      if (pendingCount === 0) {
        idleTicks += 1;
        if (idleTicks >= 3) return;
      } else {
        idleTicks = 0;
      }
      await sleep(400);
    }
  }

  function phoneDownload() {
    return /Android/i.test(navigator.userAgent || "");
  }

  function savePlace(handle) {
    return phoneDownload()
      ? `「下载」，文件名以 ${handle} 开头；用浏览器打开 ${handle}_album.html 看图和文案`
      : `「下载 / ${handle}」；打开 album.html 可看图和文案`;
  }

  function startMessage(resumeView) {
    const root = savePlace(currentHandle);
    if (scanMissed) {
      if (batchScope === "photo") return `正在检查 @${currentHandle} 的照片，漏下的会补进${root}…`;
      if (batchScope === "video") return `正在检查 @${currentHandle} 的视频，漏下的会补进${root}…`;
      return `正在检查 @${currentHandle} 的照片和视频，漏下的会补进${root}…`;
    }
    if (batchScope === "photo") return `正在下载 @${currentHandle} 的照片，保存到${root}。碰到上次那条就停。`;
    if (batchScope === "video") return `正在下载 @${currentHandle} 的视频，保存到${root}。碰到上次那条就停。`;
    if (resumeView === "video") return `照片下完了，正在下载 @${currentHandle} 的视频，保存到${root}…`;
    return `先下载 @${currentHandle} 的照片，再下载视频。都放在${root}。`;
  }

  function albumStatusNote(response) {
    if (response?.skipped) {
      if (response.reason === "unchanged") return "图集已有，无需更新。";
      return "";
    }
    if (response?.ok) return "图集已保存。";
    if (response?.error) return `图集生成失败：${response.error}`;
    return "图集可能未写出，请重新加载插件后再试一次。";
  }

  async function flushAlbumNow(handle, announce) {
    if (!handle) return null;
    if (announce) {
      await patchJob({
        running: true,
        phase: "album",
        handle,
        message: "正在整理图集…",
      });
    }
    try {
      return await send({ type: "FLUSH_ALBUM", handle });
    } catch (err) {
      return { ok: false, error: String(err?.message || err || "图集导出失败") };
    }
  }

  async function start(fromResume, mode, resumeView, scope) {
    if (loopRunning) return;
    const profile = parseProfile(location.pathname);
    if (!profile) {
      await patchJob({ running: false, phase: "error", handle: "", message: "请先打开某个用户的主页，地址类似 x.com/用户名 。" });
      return;
    }

    stopRequested = false;
    currentHandle = profile.handle;
    if (scope) batchScope = normalizeScope(scope);
    if (!fromResume) {
      clearSeenViews();
      scanMissed = mode === "scan";
    } else if (mode === "scan" || mode === "download") {
      scanMissed = mode === "scan";
    }
    savedAtStart = lastDownloads.completed || 0;
    try {
      const resetKey = `x-media-dl-cursor-reset-30:${profile.handle.toLowerCase()}`;
      if (!fromResume && !sessionStorage.getItem(resetKey)) {
        await send({ type: "CLEAR_CURSOR", handle: profile.handle });
        sessionStorage.setItem(resetKey, "1");
      }
    } catch (err) {
      /* ignore */
    }
    const cursor = await send({ type: "GET_CURSOR", handle: currentHandle });
    savedCursors = { photo: cursor?.photo || null, video: cursor?.video || null };
    boundary = {
      photo: savedCursors.photo?.tweetId || "",
      video: savedCursors.video?.tweetId || "",
    };
    passedCutoff = false;
    knownStreak = 0;
    if (!fromResume) {
      newestSeen = { photo: "", video: "" };
      newestCreated = { photo: "", video: "" };
    }
    const previous = view;
    const switchingAccount = previous?.handle && previous.handle.toLowerCase() !== profile.handle.toLowerCase();
    if (switchingAccount) {
      captured.clear();
      queuedKeys.clear();
      skippedKeys.clear();
      alreadyKeys.clear();
      streamStarted.clear();
      streamDone.clear();
      streamFailed.clear();
      streamsPending = 0;
      domIndex.clear();
      await send({ type: "RESET_JOB" });
    } else {
      await send({ type: "RESUME_DOWNLOADS" });
    }

    loopRunning = true;
    showPanel();
    let finishedHandle = currentHandle;
    let albumFlushed = false;
    try {
      await patchJob({
        running: true,
        phase: "scrolling",
        handle: currentHandle,
        mode: scanMissed ? "scan" : "download",
        scope: batchScope,
        message: startMessage(fromResume ? resumeView : ""),
      });
      const nav = await ensureMediaTab(currentHandle, fromResume ? resumeView : "");
      if (nav === "navigating" || nav === "stopped" || stopRequested) return;

      leftWatch = true;
      acceptLive = true;
      for (const key of streamFailed) streamStarted.delete(key);
      streamFailed.clear();
      for (const item of captured.values()) handleIncoming(item);
      await flushQueue();
      window.postMessage({ source: "x-media-dl", type: "pull" }, "*");
      await sleep(400);
      scanDom();
      await flushQueue();

      const result = await runScroll();
      if (result === "navigating" || result === "stopped" || result === "paused" || stopRequested) return;
      acceptLive = true;
      scanDom();
      await flushQueue();
      await commitCursor();
      await waitDownloads();
      if (stopRequested) return;
      leftWatch = false;
      acceptLive = false;

      const added = Math.max(0, (lastDownloads.completed || 0) - savedAtStart);
      const albumResponse = await flushAlbumNow(finishedHandle, added > 0);
      albumFlushed = true;
      await patchJob({
        running: false,
        phase: "done",
        handle: currentHandle,
        found: queuedKeys.size,
        skipped: skippedKeys.size,
        already: alreadyKeys.size,
        message: `${doneMessage(result === "caughtup")}${albumStatusNote(albumResponse)}`,
        mode: scanMissed ? "scan" : "download",
        scope: batchScope,
      });
    } finally {
      loopRunning = false;
      const handle = finishedHandle || currentHandle;
      if (handle && !albumFlushed) {
        try {
          await send({ type: "FLUSH_ALBUM", handle });
        } catch (err) {
          /* 跳栏中途退出也尽量写出图集 */
        }
      }
    }
  }

  function doneMessage(caughtUp) {
    const saved = lastDownloads.completed || 0;
    const added = Math.max(0, saved - savedAtStart);
    const failed = lastDownloads.failed || 0;
    const place = savePlace(currentHandle);
    if (scanMissed) {
      const what = scopeLabel(batchScope);
      return added
        ? `检查完成。补上了 ${added} 个漏下的${what}，其余 ${alreadyKeys.size} 个之前已有。`
        : `检查完成。${what}里没有发现漏下的，已有 ${alreadyKeys.size} 个。`;
    }
    const skipped = skippedKeys.size ? `，${skippedKeys.size} 个没有可保存的地址` : "";
    const streams = streamFailed.size ? `，${streamFailed.size} 个流媒体没有拼成文件` : "";
    const existing = alreadyKeys.size ? `，${alreadyKeys.size} 个之前已保存` : "";
    const stopNote = caughtUp ? "。已经到上次保存的位置，更早的没有重复下载" : "";
    return `完成。本次新保存 ${saved} 个到${place}${existing}${skipped}${streams}${failed ? `，失败 ${failed} 个` : ""}${stopNote}。`;
  }

  function stopJob(message) {
    stopRequested = true;
    leftWatch = false;
    acceptLive = false;
    streamEpoch += 1;
    streamsPending = 0;
    closeStreamPort();
    window.postMessage({ source: "x-media-dl", type: "assemble-stop" }, "*");
    for (const key of [...streamStarted]) {
      if (!streamDone.has(key)) streamStarted.delete(key);
    }
    clearPending();
    send({ type: "STOP" });
    patchJob({
      running: false,
      phase: "paused",
      handle: currentHandle,
      found: queuedKeys.size,
      skipped: skippedKeys.size,
      already: alreadyKeys.size,
      message: message || "已停止。再次开始会跳过已经保存的文件。",
    });
  }

  function showPanel() {
    if (!panelHost) {
      panelHost = document.createElement("div");
      panelHost.id = "x-media-dl-panel";
      const shadow = panelHost.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          :host([hidden]) { display: none !important; }
          .card {
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 2147483647;
            width: 260px;
            box-sizing: border-box;
            padding: 12px 14px;
            border-radius: 12px;
            background: #fff;
            color: #111;
            font: 13px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
          }
          .title { font-weight: 650; }
          .handle, .msg, .stats { margin-top: 4px; color: #333; word-break: break-word; }
          .row { display: flex; gap: 8px; margin-top: 10px; }
          button {
            border: 0;
            border-radius: 8px;
            padding: 6px 10px;
            font: inherit;
            cursor: pointer;
          }
          #act { background: #111; color: #fff; }
          #hide { background: #eee; color: #111; }
        </style>
        <div class="card">
          <div class="title">X 媒体下载</div>
          <div class="handle"></div>
          <div class="msg"></div>
          <div class="stats"></div>
          <div class="row">
            <button id="act" type="button">停止</button>
            <button id="hide" type="button">隐藏</button>
          </div>
        </div>
      `;
      shadow.getElementById("hide").addEventListener("click", () => {
        panelHost.hidden = true;
      });
      shadow.getElementById("act").addEventListener("click", () => {
        if (view.running) stopJob();
        else if (view.phase === "paused") start(false, view.mode === "scan" ? "scan" : "download", "", view.scope).catch(() => {});
        else panelHost.hidden = true;
      });
      (document.documentElement || document.body).appendChild(panelHost);
    }
    panelHost.hidden = false;
    renderPanel();
  }

  function renderPanel() {
    try {
      if (!panelHost?.shadowRoot) return;
      const shadow = panelHost.shadowRoot;
      const handleEl = shadow.querySelector(".handle");
      const msgEl = shadow.querySelector(".msg");
      const statsEl = shadow.querySelector(".stats");
      const action = shadow.getElementById("act");
      if (!handleEl || !msgEl || !statsEl || !action) return;
      handleEl.textContent = view.handle ? `@${view.handle}` : "";
      msgEl.textContent = view.message || "";
      const saved = lastDownloads.completed || 0;
      const failed = lastDownloads.failed || 0;
      statsEl.textContent = `发现 ${view.found || 0} · 本次保存 ${saved} · 已有 ${view.already || 0} · 失败 ${failed}`;
      if (view.running) action.textContent = "停止";
      else if (view.phase === "paused") action.textContent = "继续";
      else action.textContent = "关闭";
    } catch (err) {
      /* 面板没挂上时不影响下载 */
    }
  }

  function statusPayload() {
    const profile = parseProfile(location.pathname);
    return {
      onProfile: !!profile,
      handle: profile?.handle || "",
      section: profile?.section || "",
      hooked: document.documentElement?.dataset?.xMediaDl === "1",
      view: {
        running: !!view.running,
        phase: view.phase || "idle",
        message: view.message || "",
        handle: view.handle || "",
        found: view.found || 0,
        skipped: view.skipped || 0,
        already: view.already || 0,
        mode: view.mode === "scan" ? "scan" : "download",
        scope: normalizeScope(view.scope),
      },
      downloads: {
        completed: lastDownloads.completed || 0,
        failed: lastDownloads.failed || 0,
        queued: lastDownloads.queued || 0,
        active: lastDownloads.active || 0,
      },
    };
  }

  function mirrorStatus() {
    const root = document.documentElement;
    if (!root) return;
    try {
      root.dataset.xMediaState = JSON.stringify(statusPayload());
    } catch (err) {
      /* 状态写不进页面时，弹窗会显示上一次的内容 */
    }
  }

  function readCommand(raw) {
    if (raw && typeof raw === "object") {
      return { name: String(raw.name || ""), scope: normalizeScope(raw.scope) };
    }
    const text = String(raw || "").split("#")[0];
    const [name, scope] = text.split(":");
    return { name, scope: normalizeScope(scope) };
  }

  let launchLock = false;

  function onCommand(event) {
    const { name, scope } = readCommand(event?.detail || document.documentElement?.dataset?.xMediaCmd || "");
    if (name === "status") {
      mirrorStatus();
      return;
    }
    if (name === "start" || name === "scan") {
      if (launchLock || loopRunning) {
        mirrorStatus();
        return;
      }
      launchLock = true;
      view.running = true;
      view.phase = "scrolling";
      view.mode = name === "scan" ? "scan" : "download";
      view.scope = scope;
      view.message = "正在开始…";
      mirrorStatus();
      showPanel();
      start(false, name === "scan" ? "scan" : "download", "", scope).catch((err) => {
        patchJob({ running: false, phase: "error", message: err?.message || "启动失败" });
      }).finally(() => {
        launchLock = false;
      });
      return;
    }
    if (name === "stop") stopJob();
  }

  function bindCommand() {
    const root = document.documentElement;
    if (!root) return false;
    if (root.dataset.xMediaCmdBound === "1") return true;
    root.dataset.xMediaCmdBound = "1";
    root.addEventListener("x-media-dl-cmd", onCommand);
    return true;
  }

  if (!bindCommand()) {
    document.addEventListener("DOMContentLoaded", () => {
      bindCommand();
      mirrorStatus();
    }, { once: true });
  } else {
    mirrorStatus();
  }

  function maybeResume() {
    const pendingStart = readPending();
    if (!pendingStart || Date.now() - pendingStart.at > 60000) return;
    const profile = parseProfile(location.pathname);
    if (!profile || profile.handle.toLowerCase() !== String(pendingStart.handle).toLowerCase() || profile.section !== "media") return;
    clearPending();
    start(true, pendingStart.mode === "scan" ? "scan" : "download", pendingStart.view || "", pendingStart.scope || "").catch(() => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      maybeResume();
      watchTweets();
    }, { once: true });
  } else {
    maybeResume();
    watchTweets();
  }
})();
