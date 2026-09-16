// Renderer injected by the desktop application into the game page.

(function () {
  "use strict";

  const APP_ORIGIN = "https://game.placegame.cn";
  const STORAGE_KEY = "placegame-auto-helper-settings-v2";
  const TOKEN_KEY = "place-game-session-token";
  const DEVICE_KEY = "place-game-device-id";
  const FALLBACK_CLIENT_VERSION = "0.2.62";
  const FALLBACK_BUILD_REVISION = "20260916.2";
  const API_TIMEOUT_MS = 20_000;
  const MAX_LOG_LINES = 180;
  const SHOP_PURCHASE_QUANTITIES = {
    strengthen_stone: 1_000,
    refine_stone: 1_000,
    advanced_stone: 999,
  };
  const SHOP_MAX_QUANTITY_PER_REQUEST = 99;
  const ACTIVITY_REWARD_POINTS = [20, 40, 60, 80, 100];
  const REWARD_CLAIM_DELAY_MS = 500;
  const REWARD_CLAIM_LIMIT = 100;
  const SHOP_TARGETS = [
    { key: "strengthen_stone", keys: ["strengthen_stone", "enhance_stone"], name: "强化石" },
    { key: "refine_stone", keys: ["refine_stone"], name: "洗练石" },
    { key: "advanced_stone", keys: ["advanced_stone"], name: "高级强化石" },
  ];
  const API_HEADER_NAMES = [
    "x-placegame-client-version",
    "x-placegame-client-platform",
    "x-placegame-device-id",
    "x-placegame-web-build-revision",
    "authorization",
  ];

  const DEFAULT_SETTINGS = {
    enhanceScope: "selected",
    enhanceTarget: 10,
    reserveGold: 0,
    useProtectCharm: false,
    stopWithoutProtectCharm: true,
    maxFailuresPerEquipment: 3,
    enhanceDelayMs: 1200,
    maxEnhanceAttempts: 200,
    bossScope: "all",
    bossLoop: true,
    bossMaxAttempts: 20,
    bossDelayMs: 1500,
    towerTarget: 100,
    towerDelayMs: 1500,
  };

  const observedHeaders = Object.create(null);
  let discoveredBuild = {
    clientVersion: FALLBACK_CLIENT_VERSION,
    buildRevision: FALLBACK_BUILD_REVISION,
  };
  let discoveryPromise;
  let observedToken = "";
  let currentState;
  let panel;
  let enhanceRunning = false;
  let bossRunning = false;
  let purchaseRunning = false;
  let towerRunning = false;
  let rewardRunning = false;
  let rewardRunScope = "";
  let refreshRunning = false;
  let stopRequested = false;
  let settings = loadSettings();
  const selectedEquipmentIds = new Set();
  const selectedBossKeys = new Set();
  let equipmentSelectionInitialized = false;
  let bossSelectionInitialized = false;

  function taskRunning() {
    return enhanceRunning || bossRunning || purchaseRunning || towerRunning || rewardRunning;
  }

  function busy() {
    return taskRunning() || refreshRunning;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...(parsed && typeof parsed === "object" ? parsed : {}),
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Some privacy modes disable localStorage. The helper still works for this page.
    }
  }

  function numberOr(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function integerSetting(value, min, max, fallback) {
    const number = Math.round(numberOr(value, fallback));
    return Math.min(max, Math.max(min, number));
  }

  function formatNumber(value) {
    return numberOr(value, 0).toLocaleString("zh-CN");
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function makeIdempotencyKey() {
    if (
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === "function"
    ) {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function readSessionToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || observedToken || "";
    } catch {
      return observedToken || "";
    }
  }

  function getDeviceId() {
    try {
      const existing = localStorage.getItem(DEVICE_KEY);
      if (existing && /^[A-Za-z0-9_-]{20,128}$/.test(existing)) return existing;
    } catch {
      // Continue with an in-memory ID.
    }

    let generated;
    if (
      globalThis.crypto &&
      typeof globalThis.crypto.getRandomValues === "function"
    ) {
      const bytes = new Uint8Array(24);
      globalThis.crypto.getRandomValues(bytes);
      generated = `device_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    } else {
      generated = `device_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    }
    try {
      localStorage.setItem(DEVICE_KEY, generated);
    } catch {
      // Keep the generated value for this page only.
    }
    return generated;
  }

  function captureRequestHeaders(input, init) {
    try {
      const requestUrl = typeof input === "string" ? input : input && input.url;
      if (!requestUrl) return;
      const url = new URL(requestUrl, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith("/api/"))
        return;

      const sourceHeaders =
        init && init.headers !== undefined
          ? init.headers
          : input instanceof Request
            ? input.headers
            : undefined;
      if (!sourceHeaders) return;
      const headers = new Headers(sourceHeaders);
      for (const name of API_HEADER_NAMES) {
        const value = headers.get(name);
        if (!value) continue;
        observedHeaders[name] = value;
        if (name === "authorization" && value.startsWith("Bearer ")) {
          observedToken = value.slice("Bearer ".length);
        }
      }
    } catch {
      // A malformed third-party request must not affect the game client.
    }
  }

  // Capture the game's own headers so a future client revision does not break the helper.
  const nativeFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    captureRequestHeaders(input, init);
    return nativeFetch.apply(this, arguments);
  };

  function discoverBuildHeaders() {
    if (discoveryPromise) return discoveryPromise;
    discoveryPromise = (async () => {
      try {
        const script = Array.from(document.scripts).find((item) => {
          const source = item.src || "";
          return source.includes("/assets/") && source.endsWith(".js");
        });
        if (!script) return discoveredBuild;
        const response = await nativeFetch(script.src, {
          credentials: "same-origin",
        });
        if (!response.ok) return discoveredBuild;
        const source = await response.text();
        // Minifier identifiers change between deployments. The client version,
        // build revision and device-storage key are emitted as adjacent constants.
        const buildPair = source.match(
          /(?:^|[,;])\s*[A-Za-z_$][\w$]*\s*=\s*["'](\d+\.\d+\.\d+)["']\s*,\s*[A-Za-z_$][\w$]*\s*=\s*["'](\d{8}\.\d+)["']\s*,\s*[A-Za-z_$][\w$]*\s*=\s*["']place-game-device-id["']/,
        );
        const versionMatch = source.match(
          /(?:clientVersion)\s*=\s*["']([^"']+)["']/,
        );
        const revisionMatch = source.match(
          /(?:webBuildRevision)\s*=\s*["']([^"']+)["']/,
        );
        if (buildPair && buildPair[1])
          discoveredBuild.clientVersion = buildPair[1];
        else if (versionMatch && versionMatch[1])
          discoveredBuild.clientVersion = versionMatch[1];
        if (buildPair && buildPair[2])
          discoveredBuild.buildRevision = buildPair[2];
        else if (revisionMatch && revisionMatch[1])
          discoveredBuild.buildRevision = revisionMatch[1];
      } catch {
        // The hard-coded values are only a fallback; captured page headers take priority.
      }
      return discoveredBuild;
    })();
    return discoveryPromise;
  }

  void discoverBuildHeaders();

  function makeApiHeaders(responseState, idempotencyKey) {
    const headers = {
      "content-type": "application/json",
      "x-placegame-client-version":
        observedHeaders["x-placegame-client-version"] ||
        discoveredBuild.clientVersion,
      "x-placegame-client-platform":
        observedHeaders["x-placegame-client-platform"] || "web",
      "x-placegame-device-id":
        observedHeaders["x-placegame-device-id"] || getDeviceId(),
      "x-placegame-web-build-revision":
        observedHeaders["x-placegame-web-build-revision"] ||
        discoveredBuild.buildRevision,
    };
    const token = readSessionToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (responseState) headers["x-placegame-response-state"] = responseState;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    return headers;
  }

  class ApiError extends Error {
    constructor(message, statusCode, retryAfterMs) {
      super(message);
      this.name = "PlacegameApiError";
      this.statusCode = statusCode;
      this.retryAfterMs = retryAfterMs;
    }
  }

  async function request(path, options = {}, retryAfterRevision = true) {
    const method = options.method || "GET";
    const responseState = options.responseState || "omit";
    const idempotencyKey = options.idempotencyKey;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      options.timeoutMs || API_TIMEOUT_MS,
    );
    let response;
    try {
      response = await nativeFetch(new URL(path, APP_ORIGIN).toString(), {
        method,
        headers: makeApiHeaders(responseState, idempotencyKey),
        body:
          method === "POST" ? JSON.stringify(options.body || {}) : undefined,
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new ApiError("请求超时，请检查网络后重试。", 408);
      }
      throw new ApiError("无法连接游戏服务器。", 0);
    } finally {
      window.clearTimeout(timeout);
    }

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      throw new ApiError("服务器响应无效，操作结果不确定，请刷新游戏核对。", 0);
    }

    if (response.status === 426 && retryAfterRevision) {
      await discoverBuildHeaders();
      return request(path, options, false);
    }
    if (!response.ok || payload.ok === false) {
      const retryAfterHeader = Number(response.headers.get("retry-after"));
      const retryAfterMs =
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : numberOr(payload.retryAfterMs, 0);
      const message =
        payload.error ||
        payload.message ||
        `请求失败（HTTP ${response.status}）`;
      throw new ApiError(message, response.status, retryAfterMs);
    }
    return payload;
  }

  function stateFromPayload(payload) {
    if (!payload || typeof payload !== "object") return undefined;
    const candidates = [
      payload.state,
      payload.data && payload.data.state,
      payload.data,
    ];
    return candidates.find((candidate) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      )
        return false;
      return (
        "player" in candidate ||
        "equipment" in candidate ||
        "bosses" in candidate ||
        "daily" in candidate
      );
    });
  }

  function dataFromPayload(payload) {
    if (!payload || typeof payload !== "object") return {};
    if (
      payload.data &&
      typeof payload.data === "object" &&
      "result" in payload.data
    ) {
      return payload.data.result || {};
    }
    return payload.result || payload.data || {};
  }

  async function loadState() {
    const payload = await request("/api/client/bootstrap", {
      method: "GET",
      responseState: "full",
    });
    const state = stateFromPayload(payload);
    if (!state || !state.player) {
      throw new ApiError("没有读取到角色状态，请先登录并创建角色。", 401);
    }
    currentState = {
      ...currentState, ...state,
      bosses: currentState && currentState.bosses || state.bosses,
      tower: currentState && currentState.tower || state.tower,
    };
    return currentState;
  }

  async function loadBossState() {
    const payload = await request("/api/client/view-sections", {
      method: "POST",
      body: { sections: ["bosses"] },
      responseState: "omit",
    });
    const data = dataFromPayload(payload);
    if (!Array.isArray(data.bosses)) {
      throw new ApiError("没有读取到世界BOSS列表，请刷新后重试。", 0);
    }
    currentState = { ...currentState, bosses: data.bosses };
    return currentState;
  }

  function shopTarget(item) {
    if (!item || typeof item !== "object") return undefined;
    // Never identify a different item merely because its display name happens to match.
    return SHOP_TARGETS.find((target) => target.keys.includes(item.itemKey));
  }

  async function loadShopItems() {
    const items = new Map();
    const cursors = new Set();
    let cursor = "";
    for (let page = 0; page < 50; page += 1) {
      const query = new URLSearchParams({
        scope: "merchant", orderType: "sell", sort: "price",
        currencyType: "gold", itemType: "material", limit: "30",
      });
      if (cursor) query.set("cursor", cursor);
      const data = dataFromPayload(await request(`/api/market/orders?${query}`, { responseState: "omit" }));
      if (!Array.isArray(data.items)) throw new ApiError("系统行商订单格式无效，请刷新后重试。", 0);
      for (const item of data.items) if (validMerchantOrder(item)) items.set(String(item.id), item);
      if (!data.hasMore) {
        currentState = { ...currentState, shopItems: [...items.values()] };
        return currentState.shopItems;
      }
      cursor = data.nextCursor;
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    throw new ApiError("系统行商订单分页不完整，已停止读取，请刷新后重试。", 0);
  }

  function validMerchantOrder(item) {
    return item && item.source === "npc" && item.status === "active" &&
      (item.orderType || "sell") === "sell" && item.currencyType === "gold" &&
      item.itemType === "material" && shopTarget(item) && item.id != null &&
      Number.isSafeInteger(item.amount) && item.amount > 0 &&
      typeof item.price === "number" && Number.isFinite(item.price) && item.price > 0 &&
      (!item.expiredAt || Number(item.expiredAt) > Date.now());
  }

  function merchantPlan(target, items = currentState && currentState.shopItems) {
    const amount = SHOP_PURCHASE_QUANTITIES[target.key];
    const orders = (items || []).filter((item) => validMerchantOrder(item) && shopTarget(item) === target);
    // Quantity on an NPC order means bundles, not individual stones. Find an exact,
    // minimum-cost combination; never round up or silently switch to a player listing.
    const cost = Array(amount + 1).fill(Infinity);
    const previous = Array(amount + 1);
    cost[0] = 0;
    for (let total = 1; total <= amount; total += 1) {
      for (const order of orders) {
        if (order.amount > total) continue;
        const nextCost = cost[total - order.amount] + Math.round(order.price * 100);
        if (nextCost < cost[total]) {
          cost[total] = nextCost;
          previous[total] = order;
        }
      }
    }
    if (!Number.isFinite(cost[amount])) return undefined;
    const bundles = new Map();
    for (let total = amount; total > 0;) {
      const order = previous[total];
      const entry = bundles.get(String(order.id)) || { order: { ...order }, quantity: 0 };
      entry.quantity += 1;
      bundles.set(String(order.id), entry);
      total -= order.amount;
    }
    return { target, amount, cost: cost[amount] / 100, bundles: [...bundles.values()] };
  }

  async function loadTowerState() {
    const data = dataFromPayload(await request("/api/client/view-sections", {
      method: "POST", body: { sections: ["tower"] }, responseState: "omit",
    }));
    if (!data.tower || !Array.isArray(data.tower.floors)) {
      throw new ApiError("没有读取到爬塔状态，请刷新后重试。", 0);
    }
    currentState = { ...currentState, tower: data.tower };
    renderTowerState();
    return data.tower;
  }

  async function loadActivityRewardState() {
    const data = dataFromPayload(await request("/api/client/view-sections", {
      method: "POST",
      body: { sections: ["quests", "achievements", "codex"] },
      responseState: "omit",
    }));
    if (!Array.isArray(data.quests) || !Array.isArray(data.achievements) ||
        !data.codex || !Array.isArray(data.codex.rewards)) {
      throw new ApiError("没有读取到活动奖励状态，请刷新后重试。", 0);
    }
    let coinPusher;
    try {
      coinPusher = dataFromPayload(await request("/api/arcade/coin-pusher/view", {
        method: "GET",
        responseState: "omit",
      }));
      if (!coinPusher || typeof coinPusher !== "object") coinPusher = undefined;
    } catch {
      // The daily reward board remains usable when the optional arcade view is unavailable.
    }
    currentState = {
      ...currentState,
      activityRewards: {
        quests: data.quests,
        achievements: data.achievements,
        codex: data.codex,
        coinPusher,
      },
    };
    return currentState.activityRewards;
  }

  async function loadGuildRewardState() {
    const guild = dataFromPayload(await request("/api/guild/view", {
      method: "GET",
      responseState: "omit",
    }));
    if (!guild || typeof guild !== "object" || typeof guild.joined !== "boolean") {
      throw new ApiError("没有读取到公会奖励状态，请刷新后重试。", 0);
    }
    currentState = { ...currentState, guildRewards: guild };
    return guild;
  }

  function equipmentStatusAllowed(equipment) {
    return equipment && ["in_bag", "equipped"].includes(equipment.status);
  }

  function getEquipment(state) {
    return (Array.isArray(state && state.equipment) ? state.equipment : [])
      .filter(equipmentStatusAllowed)
      .filter(
        (equipment) => equipment.id !== undefined && equipment.id !== null,
      );
  }

  function equipmentLabel(equipment) {
    const name =
      equipment.name || equipment.itemName || equipment.itemKey || "未命名装备";
    const slot = equipment.slot ? ` · ${equipment.slot}` : "";
    const status = equipment.status === "equipped" ? "已穿戴" : "背包";
    return `${name} +${numberOr(equipment.enhanceLevel, 0)}${slot} · ${status}`;
  }

  function worldBosses(state) {
    return (Array.isArray(state && state.bosses) ? state.bosses : []).filter(
      (boss) => boss && boss.type === "world" && boss.key,
    );
  }

  function worldBossAvailable(boss) {
    if (!boss) return false;
    const instance = boss.worldInstance;
    if (!instance || instance.status !== "active") return false;
    if (numberOr(instance.remainingAttemptCount, 0) <= 0)
      return false;
    return !boss.assistBlockedReason;
  }

  function worldBossLabel(boss) {
    const instance = boss.worldInstance;
    if (!instance) return `${boss.name || boss.key} · 状态未知`;
    const status =
      instance.status === "active" ? "开放" : instance.status || "未开放";
    return `${boss.name || boss.key} · ${status} · 剩余 ${numberOr(instance.remainingAttemptCount, 0)} 次`;
  }

  function addLog(message, level = "info") {
    if (!panel) return;
    const log = panel.log;
    if (!log) return;
    const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const line = document.createElement("div");
    line.className = `pg-log-line pg-log-${level}`;
    line.textContent = `[${timestamp}] ${message}`;
    log.appendChild(line);
    while (log.childElementCount > MAX_LOG_LINES)
      log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  function setStatus(message, kind = "normal") {
    if (!panel || !panel.status) return;
    panel.status.textContent = message;
    panel.status.dataset.kind = kind;
  }

  function renderStateSummary(state) {
    if (!panel || !panel.summary) return;
    if (!state || !state.player) {
      panel.summary.textContent = "未登录或尚未创建角色";
      return;
    }
    panel.summary.textContent = `${state.player.nickname || "冒险者"} · Lv.${numberOr(state.player.level, 0)} · 金币 ${formatNumber(state.player.gold)}`;
  }

  function containsValue(values, expected) {
    return Array.isArray(values) && values.some((value) => String(value) === String(expected));
  }

  function activityRewardScore(state = currentState) {
    const daily = state && state.daily;
    if (!daily) return 0;
    const completed = [
      numberOr(daily.collectCount) >= 1,
      numberOr(daily.bossCount) >= 3,
      numberOr(daily.enhanceCount) >= 1,
      numberOr(daily.decomposeCount) >= 10,
      numberOr(daily.marketListCount) >= 1,
      numberOr(daily.marketBuyCount) >= 1,
      numberOr(daily.killCount) >= 1_000,
    ].filter(Boolean).length;
    return Math.min(100, completed * 20);
  }

  function guildRewardActions(state = currentState) {
    const guild = state && state.guildRewards;
    if (!guild || guild.joined !== true) return [];
    const actions = [];
    const today = state && state.daily && state.daily.key;
    const preview = guild.dividendPreview;
    const dividendReady = Boolean(
      preview && typeof preview === "object" &&
      preview.eligible === true && preview.claimed !== true,
    );
    if (dividendReady) {
      actions.push({
        id: `guild-dividend:${today || "today"}`,
        label: "公会每日分红",
        path: "/api/guild/claim-dividend",
        body: {},
      });
    }
    const progressRewards = Array.isArray(guild.progressRewards)
      ? guild.progressRewards
      : [];
    progressRewards
      .filter((reward) => reward && reward.canClaim === true && reward.claimed !== true &&
        Number.isSafeInteger(reward.point) && reward.point > 0)
      .sort((left, right) => left.point - right.point)
      .forEach((reward) => actions.push({
        id: `guild-progress:${reward.point}`,
        label: `公会进度 ${reward.point} 档`,
        path: "/api/guild/claim-progress",
        body: { point: reward.point },
      }));
    return actions;
  }

  function activityRewardActions(state = currentState) {
    const actions = [];
    const daily = state && state.daily;
    const signIn = state && state.retention && state.retention.signIn;
    const today = daily && daily.key;
    if (today && signIn && signIn.lastClaimedKey !== today &&
        !containsValue(signIn.claimedKeys, today)) {
      actions.push({
        id: `activity-sign-in:${today}`,
        label: "活动每日签到",
        path: "/api/retention/sign-in",
        body: {},
      });
    }
    if (daily) {
      const score = activityRewardScore(state);
      for (const point of ACTIVITY_REWARD_POINTS) {
        if (score >= point && !containsValue(daily.claimedActivity, point)) {
          actions.push({
            id: `activity-points:${today || "today"}:${point}`,
            label: `活动 ${point} 活跃箱`,
            path: "/api/daily/claim",
            body: { point },
          });
        }
      }
    }
    const view = state && state.activityRewards;
    const append = (rows, type, path, bodyKey, label) => {
      for (const reward of Array.isArray(rows) ? rows : []) {
        if (!reward || reward.canClaim !== true || reward.claimed === true ||
            typeof reward.key !== "string" || !reward.key.trim()) continue;
        actions.push({
          id: `${type}:${reward.key}`,
          label: `${label}：${reward.title || reward.key}`,
          path,
          body: { [bodyKey]: reward.key },
        });
      }
    };
    if (view) {
      append(view.quests, "activity-quest", "/api/quests/claim", "questKey", "任务奖励");
      append(view.achievements, "activity-achievement", "/api/achievements/claim", "achievementKey", "成就奖励");
      append(view.codex && view.codex.rewards, "activity-codex", "/api/codex/claim", "rewardKey", "图鉴奖励");
      const coinPusher = view.coinPusher;
      if (coinPusher && coinPusher.global && coinPusher.global.canClaim === true &&
          coinPusher.global.claimed !== true) {
        actions.push({
          id: "activity-coin-pusher-global",
          label: "活动全服推币奖励",
          path: "/api/arcade/coin-pusher/claim-global",
          body: {},
        });
      }
      const guildRewards = coinPusher && coinPusher.guild && coinPusher.guild.rewards;
      for (const reward of Array.isArray(guildRewards) ? guildRewards : []) {
        if (!reward || reward.canClaim !== true || reward.claimed === true ||
            !Number.isSafeInteger(reward.point) || reward.point <= 0) continue;
        actions.push({
          id: `activity-coin-pusher-guild:${reward.point}`,
          label: `活动公会推币 ${reward.point} 档`,
          path: "/api/arcade/coin-pusher/claim-guild",
          body: { point: reward.point },
        });
      }
    }
    return actions;
  }

  function rewardActions(scope, state = currentState) {
    return [
      ...(scope === "guild" || scope === "all" ? guildRewardActions(state) : []),
      ...(scope === "activity" || scope === "all" ? activityRewardActions(state) : []),
    ];
  }

  function renderRewardState() {
    if (!panel || !panel.rewardGuildDetail) return;
    const guild = currentState && currentState.guildRewards;
    const activity = currentState && currentState.activityRewards;
    const guildActions = guildRewardActions();
    const activityActions = activityRewardActions();
    panel.rewardGuildCount.textContent = String(guildActions.length);
    panel.rewardActivityCount.textContent = String(activityActions.length);
    panel.rewardGuildDetail.textContent = !guild
      ? "请刷新公会奖励状态"
      : guild.joined !== true
        ? "尚未加入公会"
        : guildActions.length
          ? "分红与进度奖励中有可领取项目"
          : "当前没有可领取的公会奖励";
    panel.rewardActivityDetail.textContent = !currentState || !activity
      ? "请刷新活动奖励状态"
      : `当前活跃 ${activityRewardScore()} · 签到、活跃箱、任务、成就、图鉴、推币场`;
    panel.claimGuild.dataset.unavailable = String(!guild || guildActions.length === 0);
    panel.claimActivity.dataset.unavailable = String(!activity || activityActions.length === 0);
    panel.claimAll.dataset.unavailable = String(
      !guild || !activity || guildActions.length + activityActions.length === 0,
    );
    panel.rewardEstimate.textContent = guildActions.length + activityActions.length
      ? `共 ${guildActions.length + activityActions.length} 项可领取：公会 ${guildActions.length} 项，活动 ${activityActions.length} 项。`
      : "当前没有可领取项目；刷新后会按服务器状态重新检查。";
  }

  function createEquipmentRows(state) {
    if (!panel) return;
    const list = panel.equipmentList;
    list.replaceChildren();
    const equipment = getEquipment(state).sort((left, right) => {
      return (
        numberOr(left.enhanceLevel) - numberOr(right.enhanceLevel) ||
        String(left.name || "").localeCompare(String(right.name || ""))
      );
    });
    if (!equipment.length) {
      const empty = document.createElement("p");
      empty.className = "pg-empty";
      empty.textContent = "没有可强化的背包/穿戴装备。";
      list.appendChild(empty);
      renderEnhancementSelection();
      return;
    }
    if (!equipmentSelectionInitialized ||
        (!taskRunning() && settings.enhanceScope !== "selected")) {
      selectedEquipmentIds.clear();
      equipment
        .filter((item) => settings.enhanceScope === "all" || item.status === "equipped")
        .forEach((item) => selectedEquipmentIds.add(String(item.id)));
      equipmentSelectionInitialized = true;
    }
    for (const item of equipment) {
      const id = String(item.id);
      const row = document.createElement("label");
      row.className = "pg-check-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedEquipmentIds.has(id);
      checkbox.disabled = busy();
      checkbox.dataset.equipmentId = id;
      checkbox.addEventListener("change", () => {
        if (busy()) return;
        if (checkbox.checked) selectedEquipmentIds.add(id);
        else selectedEquipmentIds.delete(id);
        settings.enhanceScope = "selected";
        panel.enhanceScope.value = "selected";
        saveSettings();
        renderEnhancementSelection();
      });
      const text = document.createElement("span");
      text.textContent = equipmentLabel(item);
      row.append(checkbox, text);
      list.appendChild(row);
    }
    renderEnhancementSelection();
  }

  function renderEnhancementSelection() {
    if (!panel) return;
    const selected = getEquipment(currentState).filter((item) =>
      selectedEquipmentIds.has(String(item.id)),
    );
    panel.enhanceSelection.textContent = selected.length
      ? `已选 ${selected.length} 件，目标 +${settings.enhanceTarget}：${selected.map(equipmentLabel).join("、")}`
      : "未勾选装备，不会提交强化。";
  }

  function renderShopRows(items = currentState && currentState.shopItems) {
    if (!panel || !panel.shopList) return;
    const list = panel.shopList;
    list.replaceChildren();
    const plans = [];
    for (const target of SHOP_TARGETS) {
      const plan = merchantPlan(target, items);
      plans.push(plan);
      const row = document.createElement("div");
      row.className = "pg-shop-row";
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = target.name;
      const detail = document.createElement("small");
      detail.textContent = plan
        ? `${plan.bundles.reduce((sum, entry) => sum + entry.quantity, 0)} 份 · 共 ${formatNumber(plan.cost)} 金币`
        : items ? "暂无可凑齐目标数量的金币订单" : "请刷新系统行商订单";
      copy.append(name, detail);
      const buy = document.createElement("button");
      buy.type = "button";
      buy.dataset.action = "buy-shop";
      buy.dataset.shopKey = target.key;
      buy.dataset.unavailable = String(!plan);
      buy.textContent = `买 ${SHOP_PURCHASE_QUANTITIES[target.key]} 个`;
      buy.setAttribute("aria-label", `购买${target.name} ${SHOP_PURCHASE_QUANTITIES[target.key]} 个`);
      buy.disabled = busy() || !plan;
      buy.addEventListener("click", () => void purchaseMaterials([target]));
      row.append(copy, buy);
      list.appendChild(row);
    }
    panel.buyAll.dataset.unavailable = String(plans.some((plan) => !plan));
    panel.buyAll.disabled = busy() || plans.some((plan) => !plan);
    panel.shopEstimate.textContent = plans.every(Boolean)
      ? `三种合计 ${formatNumber(plans.reduce((sum, plan) => sum + plan.cost, 0))} 金币`
      : "请刷新订单，三种材料均可购买后可一键购买全部。";
  }

  async function purchaseMaterials(targets) {
    if (busy()) return;
    const plans = targets.map((target) => merchantPlan(target));
    if (plans.some((plan) => !plan)) return;
    purchaseRunning = true;
    stopRequested = false;
    updateButtons();
    const purchased = new Map(targets.map((target) => [target.key, 0]));
    let pending = "";
    const progress = () => targets.map((target) => `${target.name} ${purchased.get(target.key)}/${SHOP_PURCHASE_QUANTITIES[target.key]} 个`).join("；");
    setStatus("正在核对系统行商订单和金币…", "busy");
    try {
      let remainingCost = plans.reduce((sum, plan) => sum + plan.cost, 0);
      for (const plan of plans) {
        for (const { order, quantity: bundleCount } of plan.bundles) {
          let remainingBundles = bundleCount;
          while (remainingBundles > 0 && !stopRequested) {
            await loadState();
            if (stopRequested) break;
            const items = await loadShopItems();
            if (stopRequested) break;
            renderStateSummary(currentState);
            const fresh = items.find((item) => String(item.id) === String(order.id));
            if (!fresh || fresh.itemKey !== order.itemKey || fresh.amount !== order.amount || fresh.price !== order.price) {
              throw new Error("订单已下架或份量、价格已变化，请刷新后重新核对购买。");
            }
            if (numberOr(currentState.player.gold) < remainingCost) {
              throw new Error(`金币不足，剩余材料共需 ${formatNumber(remainingCost)} 金币。`);
            }
            const quantity = Math.min(SHOP_MAX_QUANTITY_PER_REQUEST, remainingBundles);
            pending = `${plan.target.name} ${quantity * order.amount} 个`;
            await request("/api/market/buy", {
              method: "POST", body: { orderId: fresh.id, quantity },
              responseState: "omit", idempotencyKey: makeIdempotencyKey(),
            }, false);
            pending = "";
            purchased.set(plan.target.key, purchased.get(plan.target.key) + quantity * order.amount);
            remainingBundles -= quantity;
            remainingCost = Math.max(0, remainingCost - order.price * quantity);
            setStatus(`购买进度：${progress()}`, "busy");
            addLog(`系统行商已确认：${progress()}`, "success");
            if (remainingCost > 0 && !stopRequested) await sleep(500);
          }
          if (stopRequested) break;
        }
        if (stopRequested) break;
      }
      const message = `${stopRequested ? "购买已停止" : "购买完成"}：${progress()}`;
      addLog(message, stopRequested ? "warn" : "success");
      setStatus(message, "ok");
    } catch (error) {
      addLog(`购买停止：${stopReasonForError(error)} 已确认：${progress()}`, "error");
      if (pending && (!(error instanceof ApiError) || [0, 408].includes(error.statusCode) || error.statusCode >= 500)) {
        addLog(`${pending} 的提交结果不确定，未自动重试；请先在游戏背包核对。`, "warn");
      }
      setStatus(stopReasonForError(error), "error");
    } finally {
      try {
        await loadState();
        await loadShopItems();
        renderStateSummary(currentState);
      } catch {
        currentState = { ...currentState, shopItems: undefined };
        addLog("购买后同步失败，请刷新游戏核对金币和材料。", "warn");
      }
      purchaseRunning = false;
      stopRequested = false;
      renderShopRows();
      updateButtons();
    }
  }

  function bossAvailabilityText(boss) {
    const instance = boss.worldInstance;
    if (boss.assistBlockedReason) return boss.assistBlockedReason;
    if (!instance) return "服务器未返回当前场次";
    if (instance.status !== "active") return "当前场次未开放";
    if (numberOr(instance.remainingAttemptCount, 0) <= 0)
      return "本场次数已用完";
    return `阶段 ${numberOr(instance.phase, 1)} · 进度 ${numberOr(instance.phaseProgressPercent, 0)}% · 剩余 ${numberOr(instance.remainingAttemptCount, 0)} 次`;
  }

  function createBossRows(state) {
    if (!panel) return;
    const list = panel.bossList;
    list.replaceChildren();
    const bosses = worldBosses(state);
    if (!bosses.length) {
      const empty = document.createElement("p");
      empty.className = "pg-empty";
      empty.textContent = "暂未读取到世界BOSS。";
      list.appendChild(empty);
      return;
    }
    if (!bossSelectionInitialized ||
        (!taskRunning() && settings.bossScope === "all")) {
      selectedBossKeys.clear();
      bosses
        .filter(worldBossAvailable)
        .forEach((boss) => selectedBossKeys.add(String(boss.key)));
      bossSelectionInitialized = true;
    }
    for (const boss of bosses) {
      const key = String(boss.key);
      const row = document.createElement("label");
      row.className = `pg-check-row ${worldBossAvailable(boss) ? "" : "pg-disabled-row"}`;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedBossKeys.has(key);
      checkbox.dataset.unavailable = String(!worldBossAvailable(boss));
      checkbox.disabled = busy() || !worldBossAvailable(boss);
      checkbox.dataset.bossKey = key;
      checkbox.addEventListener("change", () => {
        if (busy()) return;
        if (checkbox.checked) selectedBossKeys.add(key);
        else selectedBossKeys.delete(key);
        settings.bossScope = "selected";
        panel.bossScope.value = "selected";
        saveSettings();
      });
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = boss.name || key;
      const detail = document.createElement("small");
      detail.textContent = `${boss.mapName || "世界首领"} · ${bossAvailabilityText(boss)}`;
      copy.append(title, detail);
      row.append(checkbox, copy);
      list.appendChild(row);
    }
  }

  async function refreshState(silent = false) {
    if (busy()) return;
    refreshRunning = true;
    updateButtons();
    const unavailable = [];
    try {
      setStatus("正在同步状态…", "busy");
      const state = await loadState();
      renderStateSummary(state);
      createEquipmentRows(state);
      try {
        await loadBossState();
        createBossRows(currentState);
      } catch (error) {
        currentState.bosses = undefined;
        createBossRows(currentState);
        const message = `装备已同步，世界BOSS读取失败：${stopReasonForError(error)}`;
        setStatus(message, "error");
        addLog(message, "warn");
        unavailable.push("世界BOSS");
      }
      try {
        await loadShopItems();
        renderShopRows();
      } catch (error) {
        currentState.shopItems = undefined;
        renderShopRows();
        addLog(`强化材料商店读取失败：${stopReasonForError(error)}`, "warn");
        unavailable.push("系统行商");
      }
      try {
        await loadTowerState();
      } catch (error) {
        currentState.tower = undefined;
        renderTowerState();
        addLog(`爬塔状态读取失败：${stopReasonForError(error)}`, "warn");
        unavailable.push("爬塔");
      }
      try {
        await loadGuildRewardState();
      } catch (error) {
        currentState.guildRewards = undefined;
        addLog(`公会奖励读取失败：${stopReasonForError(error)}`, "warn");
        unavailable.push("公会奖励");
      }
      try {
        await loadActivityRewardState();
      } catch (error) {
        currentState.activityRewards = undefined;
        addLog(`活动奖励读取失败：${stopReasonForError(error)}`, "warn");
        unavailable.push("活动奖励");
      }
      renderRewardState();
      setStatus(unavailable.length ? `部分状态未同步：${unavailable.join("、")}，请刷新重试。` : "状态已同步", unavailable.length ? "error" : "ok");
      if (!silent) addLog("状态同步完成。");
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : "状态同步失败";
      renderStateSummary(undefined);
      setStatus(message, "error");
      if (!silent) addLog(message, "error");
      throw error;
    } finally {
      refreshRunning = false;
      updateButtons();
    }
  }

  function selectedWorldBossCandidates(state) {
    const bosses = worldBosses(state).filter(worldBossAvailable);
    return bosses.filter((boss) => selectedBossKeys.has(String(boss.key)));
  }

  function stopReasonForError(error) {
    if (!(error instanceof ApiError))
      return error instanceof Error ? error.message : "未知错误";
    if (error.statusCode === 429) {
      const wait =
        error.retryAfterMs > 0
          ? `，建议等待 ${Math.ceil(error.retryAfterMs / 1000)} 秒`
          : "";
      return `服务器限流${wait}。`;
    }
    if (error.statusCode === 401 || error.statusCode === 403)
      return "登录会话无效，请刷新页面后重新登录。";
    return error.message;
  }

  function readEnhanceSettingsFromUi() {
    if (!panel) return;
    settings.enhanceScope = panel.enhanceScope.value;
    settings.enhanceTarget = integerSetting(
      panel.enhanceTarget.value,
      1,
      999,
      DEFAULT_SETTINGS.enhanceTarget,
    );
    settings.reserveGold = integerSetting(
      panel.reserveGold.value,
      0,
      2_000_000_000,
      DEFAULT_SETTINGS.reserveGold,
    );
    settings.useProtectCharm = panel.useProtectCharm.checked;
    settings.stopWithoutProtectCharm = panel.stopWithoutProtectCharm.checked;
    settings.maxFailuresPerEquipment = integerSetting(
      panel.maxFailures.value,
      0,
      50,
      DEFAULT_SETTINGS.maxFailuresPerEquipment,
    );
    settings.enhanceDelayMs = integerSetting(
      panel.enhanceDelay.value,
      300,
      60_000,
      DEFAULT_SETTINGS.enhanceDelayMs,
    );
    settings.maxEnhanceAttempts = integerSetting(
      panel.maxEnhanceAttempts.value,
      1,
      10_000,
      DEFAULT_SETTINGS.maxEnhanceAttempts,
    );
    saveSettings();
  }

  function readBossSettingsFromUi() {
    if (!panel) return;
    settings.bossScope = panel.bossScope.value;
    settings.bossLoop = panel.bossLoop.checked;
    settings.bossMaxAttempts = integerSetting(
      panel.bossMaxAttempts.value,
      1,
      500,
      DEFAULT_SETTINGS.bossMaxAttempts,
    );
    settings.bossDelayMs = integerSetting(
      panel.bossDelay.value,
      500,
      60_000,
      DEFAULT_SETTINGS.bossDelayMs,
    );
    saveSettings();
  }

  function updateButtons() {
    if (!panel) return;
    const running = busy();
    panel.enhanceStart.disabled = running;
    panel.bossStart.disabled = running;
    panel.refreshEquipment.disabled = running;
    panel.refreshBoss.disabled = running;
    panel.refreshShop.disabled = running;
    panel.refreshTower.disabled = running;
    panel.refreshRewards.disabled = running;
    panel.towerStart.disabled = running;
    panel.buyAll.disabled = running || panel.buyAll.dataset.unavailable === "true";
    for (const input of panel.shadow.querySelectorAll("input, select")) {
      input.disabled = running || input.dataset.unavailable === "true";
    }
    for (const button of panel.shadow.querySelectorAll('[data-action="stop"]')) {
      button.disabled = !taskRunning();
    }
    panel.enhanceStart.textContent = enhanceRunning
      ? "强化运行中…"
      : "开始自动强化";
    panel.bossStart.textContent = bossRunning
      ? "BOSS 运行中…"
      : "一键挑战世界BOSS";
    panel.towerStart.textContent = towerRunning ? "爬塔运行中…" : "开始自动爬塔";
    for (const [button, scope, idleText] of [
      [panel.claimGuild, "guild", "领取公会奖励"],
      [panel.claimActivity, "activity", "领取活动奖励"],
      [panel.claimAll, "all", "一键领取全部"],
    ]) {
      button.disabled = running || button.dataset.unavailable === "true";
      button.textContent = rewardRunning && rewardRunScope === scope ? "领取中…" : idleText;
    }
    for (const button of panel.shadow.querySelectorAll('[data-action="buy-shop"]')) {
      button.disabled = running || button.dataset.unavailable === "true";
    }
  }

  async function runEnhancement() {
    if (busy()) return;
    readEnhanceSettingsFromUi();
    const runSettings = Object.freeze({ ...settings });
    // Capture the IDs visible at the instant Start is clicked, before any await.
    const equipmentIds = new Set(getEquipment(currentState)
      .filter((item) => selectedEquipmentIds.has(String(item.id)))
      .map((item) => String(item.id)));
    if (!equipmentIds.size) {
      addLog("未勾选装备。请先刷新列表并勾选需要强化的装备。", "warn");
      return;
    }
    enhanceRunning = true;
    stopRequested = false;
    const blockedEquipmentIds = new Set();
    updateButtons();
    addLog(
      `开始自动强化：目标 +${runSettings.enhanceTarget}，本轮装备与参数已锁定。`,
    );
    setStatus("自动强化运行中…", "busy");

    const failures = new Map();
    let attempts = 0;
    try {
      let state = await loadState();
      renderStateSummary(state);
      createEquipmentRows(state);
      const initialCandidates = getEquipment(state).filter(
        (item) => equipmentIds.has(String(item.id)) &&
          numberOr(item.enhanceLevel, 0) < runSettings.enhanceTarget,
      );
      if (!initialCandidates.length) {
        addLog("当前强化范围没有低于目标等级的装备。", "warn");
      } else {
        addLog(
          `本次实际处理：${initialCandidates.map(equipmentLabel).join("、")}。`,
        );
      }
      while (!stopRequested && attempts < runSettings.maxEnhanceAttempts) {
        const candidates = getEquipment(state)
          .filter((item) => equipmentIds.has(String(item.id)))
          .filter((item) => !blockedEquipmentIds.has(String(item.id)))
          .filter(
            (item) => numberOr(item.enhanceLevel, 0) < runSettings.enhanceTarget,
          )
          .sort(
            (left, right) =>
              numberOr(left.enhanceLevel) - numberOr(right.enhanceLevel),
          );
        if (!candidates.length) {
          addLog("目标装备已达标、不可强化或已触发停止条件，本轮结束。");
          break;
        }

        let attemptedThisRound = false;
        for (const item of candidates) {
          if (stopRequested || attempts >= runSettings.maxEnhanceAttempts) break;
          const equipmentId = item.id;
          const label = equipmentLabel(item);
          let previewPayload;
          try {
            previewPayload = await request("/api/equipment/enhance-preview", {
              method: "POST",
              body: { equipmentId },
              responseState: "omit",
            });
          } catch (error) {
            throw new ApiError(
              `预览 ${label} 失败：${stopReasonForError(error)}`,
              error.statusCode,
              error.retryAfterMs,
            );
          }
          if (stopRequested) break;
          const preview = dataFromPayload(previewPayload);
          const currentLevel = numberOr(
            preview.currentLevel,
            numberOr(item.enhanceLevel, 0),
          );
          if (currentLevel >= runSettings.enhanceTarget) {
            blockedEquipmentIds.add(String(equipmentId));
            continue;
          }
          if (preview.blockedReason) {
            addLog(`${label}：${preview.blockedReason}`, "warn");
            blockedEquipmentIds.add(String(equipmentId));
            continue;
          }
          if (preview.canAfford !== true) {
            addLog(`${label}：预览未确认金币和材料充足，停止该装备。`, "warn");
            blockedEquipmentIds.add(String(equipmentId));
            continue;
          }
          const goldCost = numberOr(preview.goldCost, 0);
          const ownedGold = numberOr(preview.ownedGold, numberOr(state.player && state.player.gold, 0));
          if (ownedGold - goldCost < runSettings.reserveGold) {
            addLog(
              `${label}：金币不足或低于保留额（需要 ${formatNumber(goldCost)}，当前 ${formatNumber(ownedGold)}）。`,
              "warn",
            );
            blockedEquipmentIds.add(String(equipmentId));
            continue;
          }
          let useProtectCharm = false;
          if (runSettings.useProtectCharm) {
            if (preview.canUseProtectCharm) {
              useProtectCharm = true;
            } else if (runSettings.stopWithoutProtectCharm) {
              addLog(`${label}：没有可用保护符，按设置停止该装备。`, "warn");
              blockedEquipmentIds.add(String(equipmentId));
              continue;
            }
          }

          attemptedThisRound = true;
          addLog(
            `强化 ${label} → +${currentLevel + 1}${useProtectCharm ? "（保护符）" : ""}。`,
          );
          const resultPayload = await request("/api/equipment/enhance", {
            method: "POST",
            body: { equipmentId, useProtectCharm },
            responseState: "omit",
            idempotencyKey: makeIdempotencyKey(),
          });
          const result = dataFromPayload(resultPayload);
          attempts += 1;
          const succeeded =
            result.success === true ||
            numberOr(result.nextLevel, currentLevel) > currentLevel;
          if (succeeded) {
            failures.set(String(equipmentId), 0);
            addLog(
              `${label}：${result.message || `强化成功，当前约 +${numberOr(result.nextLevel, currentLevel + 1)}`}。`,
              "success",
            );
          } else {
            const count = (failures.get(String(equipmentId)) || 0) + 1;
            failures.set(String(equipmentId), count);
            addLog(
              `${label}：${result.message || "强化未成功"}（连续失败 ${count}/${Math.max(1, runSettings.maxFailuresPerEquipment)}）。`,
              "warn",
            );
            if (
              count >= Math.max(1, runSettings.maxFailuresPerEquipment)
            ) {
              blockedEquipmentIds.add(String(equipmentId));
              addLog(`${label}：达到失败停止条件。`, "warn");
            }
          }
          if (stopRequested) break;
          await sleep(runSettings.enhanceDelayMs);
          if (stopRequested) break;
          state = await loadState();
          currentState = state;
          renderStateSummary(state);
          createEquipmentRows(state);
          break;
        }
        if (!attemptedThisRound) break;
      }
      if (attempts >= runSettings.maxEnhanceAttempts) {
        addLog(
          `达到本次最大强化次数 ${runSettings.maxEnhanceAttempts}，已停止。`,
          "warn",
        );
      }
      if (stopRequested) addLog("收到停止请求，自动强化已停止。", "warn");
      setStatus("自动强化已停止", "ok");
    } catch (error) {
      const message = stopReasonForError(error);
      addLog(`自动强化停止：${message}`, "error");
      setStatus(message, "error");
    } finally {
      enhanceRunning = false;
      stopRequested = false;
      updateButtons();
    }
  }

  async function runWorldBoss() {
    if (busy()) return;
    readBossSettingsFromUi();
    const runSettings = Object.freeze({ ...settings });
    const instances = new Map(selectedWorldBossCandidates(currentState).map((boss) =>
      [String(boss.key), String(boss.worldInstance.instanceId)],
    ));
    if (!instances.size) {
      addLog("未勾选可用世界BOSS。请先刷新列表并选择开放的场次。", "warn");
      return;
    }
    bossRunning = true;
    stopRequested = false;
    updateButtons();
    addLog(
      `开始世界BOSS协作：${runSettings.bossLoop ? "循环至次数用完（受上限约束）" : "每个选中场次一次"}。`,
    );
    setStatus("世界BOSS运行中…", "busy");
    let attempts = 0;
    const bossAttempts = new Map();
    try {
      let state = await loadBossState();
      createBossRows(state);
      while (!stopRequested && attempts < runSettings.bossMaxAttempts) {
        const candidates = worldBosses(state).filter((boss) =>
          worldBossAvailable(boss) && instances.has(String(boss.key)) &&
          instances.get(String(boss.key)) === String(boss.worldInstance.instanceId) &&
          (runSettings.bossLoop || !bossAttempts.has(String(boss.key))),
        ).sort((left, right) =>
          (bossAttempts.get(String(left.key)) || 0) - (bossAttempts.get(String(right.key)) || 0),
        );
        if (!candidates.length) {
          addLog("本轮目标场次已处理完毕或暂无可参与次数。");
          break;
        }
          const boss = candidates[0];
          addLog(
            `提交 ${boss.name || boss.key} 世界协作攻击（第 ${attempts + 1} 次）。`,
          );
          const payload = await request("/api/boss/assist", {
            method: "POST",
            body: { bossKey: boss.key },
            responseState: "omit",
          });
          const result = dataFromPayload(payload);
          const world = result.worldBoss || {};
          attempts += 1;
          bossAttempts.set(String(boss.key), (bossAttempts.get(String(boss.key)) || 0) + 1);
          addLog(
            `${boss.name || boss.key}：造成 ${formatNumber(result.damage)} 点伤害；阶段 ${numberOr(world.phase, 1)}，进度 ${numberOr(world.phaseProgressPercent, 0)}%，剩余 ${numberOr(world.remainingAttemptCount, 0)} 次。`,
            "success",
          );
          if (stopRequested) break;
          await sleep(runSettings.bossDelayMs);
          if (stopRequested) break;
          state = await loadBossState();
          createBossRows(state);
      }
      if (attempts >= runSettings.bossMaxAttempts)
        addLog(
          `达到本次世界BOSS最大次数 ${runSettings.bossMaxAttempts}，已停止。`,
          "warn",
        );
      if (stopRequested) addLog("收到停止请求，世界BOSS操作已停止。", "warn");
      setStatus("世界BOSS操作已停止", "ok");
    } catch (error) {
      const message = stopReasonForError(error);
      addLog(`世界BOSS停止：${message}`, "error");
      setStatus(message, "error");
    } finally {
      bossRunning = false;
      stopRequested = false;
      updateButtons();
    }
  }

  function readTowerSettingsFromUi() {
    settings.towerTarget = integerSetting(panel.towerTarget.value, 1, 100, DEFAULT_SETTINGS.towerTarget);
    settings.towerDelayMs = integerSetting(panel.towerDelay.value, 500, 60_000, DEFAULT_SETTINGS.towerDelayMs);
    saveSettings();
  }

  function renderTowerState() {
    if (!panel) return;
    const tower = currentState && currentState.tower;
    panel.towerSummary.textContent = !tower ? "请刷新爬塔状态。"
      : !tower.unlocked ? tower.blockedReason || "试炼之塔尚未解锁。"
      : tower.capped ? `已通关全部楼层 · 最高 ${tower.highestFloor} 层`
      : `已通关 ${tower.highestFloor} 层 · 下一层 ${tower.nextFloor}`;
    const skills = tower && tower.challengeOptions && tower.challengeOptions.skills;
    panel.towerSkills.textContent = Array.isArray(skills) && skills.length
      ? `使用技能：${skills.slice(0, 3).map((skill) => skill.name || skill.key).join("、")}`
      : "使用技能：无可用技能";
  }

  async function runTower() {
    if (busy()) return;
    readTowerSettingsFromUi();
    const runSettings = { ...settings };
    towerRunning = true;
    stopRequested = false;
    updateButtons();
    setStatus("正在读取下一层…", "busy");
    let attempts = 0;
    let lastCleared = 0;
    let finish = "自动爬塔已停止";
    try {
      let tower = await loadTowerState();
      const skillKeys = (tower.challengeOptions && tower.challengeOptions.skills || [])
        .slice(0, 3).map((skill) => skill.key);
      const loadout = { selectedSkillKeys: skillKeys, buffKey: "none", affixKey: "none" };
      while (!stopRequested && attempts < 100) {
        if (!tower.unlocked) { finish = tower.blockedReason || "试炼之塔尚未解锁"; break; }
        if (tower.capped || tower.highestFloor >= runSettings.towerTarget) {
          finish = `已达到目标，最高通关 ${tower.highestFloor} 层`; break;
        }
        const floor = tower.floors.find((item) => item.floor === tower.nextFloor && item.status === "available");
        if (!floor || !Number.isSafeInteger(floor.floor) || floor.floor > runSettings.towerTarget) {
          finish = "没有可挑战的目标楼层，已停止"; break;
        }
        if (floor.floor <= lastCleared) throw new Error("胜利后楼层未更新，已停止重复挑战，请刷新核对。");
        const body = { floor: floor.floor, ...loadout };
        setStatus(`正在评估第 ${floor.floor} 层…`, "busy");
        const preview = dataFromPayload(await request("/api/tower/preview", {
          method: "POST", body, responseState: "omit",
        }));
        if (stopRequested) break;
        if (preview.blockedReason || preview.canChallenge === false) {
          finish = preview.blockedReason || "本层暂不可挑战"; break;
        }
        addLog(`挑战第 ${floor.floor} 层 · ${floor.enemyName || "守层敌人"}${Number.isFinite(preview.chance) ? ` · 预估胜率 ${preview.chance}%` : ""}。`);
        setStatus(`正在挑战第 ${floor.floor} 层…`, "busy");
        const payload = await request("/api/tower/challenge", {
          method: "POST", body, responseState: "omit", timeoutMs: 15_000,
          idempotencyKey: makeIdempotencyKey(),
        }, false);
        attempts += 1;
        const result = dataFromPayload(payload);
        const events = result.battle && result.battle.events;
        const terminal = Array.isArray(events) && events.find((event) => ["victory", "defeat"].includes(event.type));
        if (!terminal) throw new Error("本层结果缺少胜负记录，已停止，请刷新游戏核对后再开始。");
        if (terminal.type === "defeat") {
          finish = `第 ${floor.floor} 层挑战失败，已停止`; break;
        }
        lastCleared = floor.floor;
        addLog(`第 ${floor.floor} 层通关。${Array.isArray(result.rewards && result.rewards.summary) ? result.rewards.summary.join("、") : ""}`, "success");
        if (stopRequested) break;
        if (floor.floor >= runSettings.towerTarget) {
          finish = `已通关目标第 ${floor.floor} 层`; break;
        }
        await sleep(runSettings.towerDelayMs);
        if (stopRequested) break;
        tower = await loadTowerState();
      }
      if (stopRequested) finish = "收到停止请求，自动爬塔已停止";
      if (attempts >= 100) finish = "达到本次 100 次挑战上限，已停止";
      addLog(`${finish}。本次挑战 ${attempts} 次。`);
      setStatus(finish, "ok");
    } catch (error) {
      const message = stopReasonForError(error);
      addLog(`自动爬塔停止：${message} 未自动重试挑战。`, "error");
      setStatus(message, "error");
    } finally {
      try {
        await loadTowerState();
        await loadState();
        renderStateSummary(currentState);
      } catch {
        addLog("爬塔后同步失败，请刷新游戏核对楼层。", "warn");
      }
      towerRunning = false;
      stopRequested = false;
      updateButtons();
    }
  }

  async function loadRewardSources(scope) {
    await loadState();
    if (scope === "guild" || scope === "all") await loadGuildRewardState();
    if (scope === "activity" || scope === "all") await loadActivityRewardState();
    renderStateSummary(currentState);
    renderRewardState();
  }

  async function runRewardClaims(scope) {
    if (busy() || !["guild", "activity", "all"].includes(scope)) return;
    rewardRunning = true;
    rewardRunScope = scope;
    stopRequested = false;
    updateButtons();
    const submitted = new Set();
    let claimed = 0;
    let pendingAction;
    let finish = "当前没有可领取的奖励";
    try {
      while (!stopRequested && claimed < REWARD_CLAIM_LIMIT) {
        setStatus("正在核对可领取奖励…", "busy");
        await loadRewardSources(scope);
        if (stopRequested) break;
        const available = rewardActions(scope);
        const stale = available.find((action) => submitted.has(action.id));
        if (stale) {
          throw new Error(`${stale.label}领取后状态未更新，已停止避免重复提交。`);
        }
        const action = available[0];
        if (!action) {
          finish = claimed > 0
            ? `奖励领取完成，共领取 ${claimed} 项`
            : "当前没有可领取的奖励";
          break;
        }
        pendingAction = action;
        setStatus(`正在领取：${action.label}…`, "busy");
        await request(action.path, {
          method: "POST",
          body: action.body,
          responseState: "omit",
          idempotencyKey: makeIdempotencyKey(),
        }, false);
        submitted.add(action.id);
        pendingAction = undefined;
        claimed += 1;
        addLog(`${action.label}领取成功。`, "success");
        if (!stopRequested) await sleep(REWARD_CLAIM_DELAY_MS);
      }
      if (stopRequested) finish = `收到停止请求，已领取 ${claimed} 项`;
      if (claimed >= REWARD_CLAIM_LIMIT) {
        finish = `达到本次 ${REWARD_CLAIM_LIMIT} 项领取上限，已停止`;
      }
      addLog(`${finish}。`, stopRequested ? "warn" : "success");
      setStatus(finish, "ok");
    } catch (error) {
      const message = stopReasonForError(error);
      addLog(`自动领奖停止：${message}`, "error");
      if (pendingAction && (!(error instanceof ApiError) ||
          [0, 408].includes(error.statusCode) || error.statusCode >= 500)) {
        addLog(`${pendingAction.label}的结果不确定，未自动重发；请先在游戏页面核对。`, "warn");
      }
      setStatus(message, "error");
    } finally {
      try {
        await loadRewardSources(scope);
      } catch {
        addLog("领奖后同步失败，请刷新游戏核对领取结果。", "warn");
      }
      rewardRunning = false;
      rewardRunScope = "";
      stopRequested = false;
      renderRewardState();
      updateButtons();
    }
  }

  function setInputValue(input, value) {
    if (input) input.value = String(value);
  }

  function buildPanel() {
    if (!document.getElementById("placegame-helper-layout-style")) {
      const layoutStyle = document.createElement("style");
      layoutStyle.id = "placegame-helper-layout-style";
      layoutStyle.textContent = `
        html, body {
          width: 100vw !important;
          height: 100vh !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          display: flex !important;
          flex-direction: row !important;
        }
        #root {
          flex: 1 1 0% !important;
          min-width: 0 !important;
          width: 0 !important;
          height: 100vh !important;
          overflow: auto !important;
          position: relative !important;
          contain: paint !important;
        }
        .app-shell {
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          height: 100% !important;
        }
        #placegame-auto-helper-host {
          flex: 0 0 400px !important;
          width: 400px !important;
          min-width: 400px !important;
          max-width: 400px !important;
          height: 100vh !important;
          position: relative !important;
          box-sizing: border-box !important;
        }
        #placegame-auto-helper-host[hidden] {
          display: none !important;
        }
      `;
      (document.head || document.documentElement).appendChild(layoutStyle);
    }

    const host = document.createElement("div");
    host.id = "placegame-auto-helper-host";
    host.style.cssText =
      "flex:0 0 400px;width:400px;min-width:400px;max-width:400px;height:100vh;position:relative;z-index:2147483647;pointer-events:auto;box-sizing:border-box;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .pg-wrap { color-scheme: dark; scrollbar-color: #3a4d64 #0d1219; scrollbar-width: thin; }
        .pg-header, .pg-summary, .pg-status, .pg-tabs { flex-shrink: 0; }
        .pg-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden; pointer-events: auto; color: #e0e8f2; background: linear-gradient(180deg, #111a25 0%, #0e141d 100%); border-left: 1px solid #2a3a4e; font: 13px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .pg-header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: linear-gradient(135deg, #1b2838 0%, #162231 100%); border-bottom: 1px solid #2a3a4e; }
        .pg-title { flex: 1; min-width: 0; font-weight: 800; font-size: 15px; color: #f0f6ff; letter-spacing: 0.3px; }
        .pg-title small { display: block; margin-top: 3px; color: #8899ad; font-weight: 400; font-size: 11px; letter-spacing: 0.2px; }
        button, input, select { font: inherit; }
        button { cursor: pointer; color: #d0dae8; border: 1px solid #344a62; background: linear-gradient(180deg, #243448 0%, #1d2c3e 100%); border-radius: 6px; padding: 6px 10px; transition: all .15s ease; }
        button:hover:not(:disabled) { background: linear-gradient(180deg, #2e4460 0%, #263c56 100%); border-color: #4a6480; }
        button:active:not(:disabled) { transform: scale(.97); }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #5cb8ff; outline-offset: 2px; }
        button:disabled { cursor: not-allowed; opacity: .4; }
        .pg-icon-button { width: 32px; height: 32px; padding: 0; font-size: 18px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
        .pg-icon-button:hover:not(:disabled) { color: #fff; }
        .pg-summary { padding: 9px 16px; color: #9aacbf; background: #0f1820; border-bottom: 1px solid #222f3e; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pg-status { padding: 8px 16px; color: #8a9bb0; background: #0f1820; border-bottom: 1px solid #222f3e; font-size: 12.5px; }
        .pg-status[data-kind="busy"] { color: #ffc94d; }
        .pg-status[data-kind="ok"] { color: #5ee4a0; }
        .pg-status[data-kind="error"] { color: #ff7e7e; }
        .pg-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 10px 12px 6px; background: #111a25; }
        .pg-tab { font-size: 12.5px; font-weight: 600; padding: 7px 8px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #7a8d9f; transition: all .15s ease; }
        .pg-tab:hover:not(.active) { color: #a8bdd2; background: rgba(255,255,255,.04); }
        .pg-tab:last-child:nth-child(odd) { grid-column: 1 / -1; }
        .pg-tab.active { color: #fff; background: linear-gradient(135deg, #2a5a8a 0%, #1e4570 100%); border-color: #3e7ab5; box-shadow: 0 2px 8px rgba(30,69,112,.4); }
        .pg-tab-panel { min-height: 0; padding: 12px 14px 14px; overflow: auto; }
        .pg-tab-panel[hidden] { display: none; }
        .pg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .pg-field { display: flex; flex-direction: column; gap: 5px; color: #96a8bb; }
        .pg-field > span { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.4px; }
        .pg-field input, .pg-field select { min-width: 0; width: 100%; color: #e4ecf5; background: #0c1219; border: 1px solid #2d3e52; border-radius: 6px; padding: 7px 8px; transition: border-color .15s ease; }
        .pg-field input:hover, .pg-field select:hover { border-color: #4a6480; }
        .pg-field input:focus, .pg-field select:focus { outline: none; border-color: #5cb8ff; box-shadow: 0 0 0 3px rgba(92,184,255,.15); }
        .pg-check { display: flex; align-items: center; gap: 8px; margin: 10px 0; color: #c8d4e2; font-size: 12.5px; }
        .pg-check input, .pg-check-row input { accent-color: #5cb8ff; width: 15px; height: 15px; }
        .pg-section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 14px 0 8px; color: #e8f0fa; font-weight: 700; font-size: 13px; }
        .pg-section-title button { padding: 4px 8px; font-size: 11px; }
        .pg-list { max-height: 160px; overflow: auto; padding: 5px 7px; background: #0c1219; border: 1px solid #243242; border-radius: 8px; }
        .pg-check-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 3px; color: #d0dae8; }
        .pg-check-row + .pg-check-row { border-top: 1px solid #1a2838; }
        .pg-check-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pg-check-row strong, .pg-check-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pg-check-row small { color: #7e90a4; font-size: 11px; }
        .pg-disabled-row { opacity: .45; }
        .pg-shop-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 3px; color: #d0dae8; }
        .pg-shop-row + .pg-shop-row { border-top: 1px solid #1a2838; }
        .pg-shop-row span { min-width: 0; overflow-wrap: anywhere; }
        .pg-shop-row strong, .pg-shop-row small { display: block; }
        .pg-shop-row small { color: #96a8bb; margin-top: 4px; font-size: 12px; }
        .pg-shop-row button { flex: 0 0 auto; min-height: 34px; padding: 5px 10px; font-size: 12px; }
        .pg-shop-list { max-height: none; }
        .pg-tower-summary { margin: 4px 0 14px; line-height: 1.7; }
        .pg-reward-list { max-height: none; padding: 0 8px; }
        .pg-reward-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 62px; padding: 8px 3px; }
        .pg-reward-row + .pg-reward-row { border-top: 1px solid #1a2838; }
        .pg-reward-row span { min-width: 0; }
        .pg-reward-row strong, .pg-reward-row small { display: block; }
        .pg-reward-row small { margin-top: 3px; color: #8a9bb0; font-size: 12px; overflow-wrap: anywhere; }
        .pg-reward-count { min-width: 36px; color: #5ee4a0; font-size: 22px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 700; }
        .pg-reward-secondary { margin-top: 8px; }
        .pg-actions { display: flex; gap: 8px; margin-top: 12px; }
        .pg-actions button { flex: 1; }
        .pg-primary { color: #0a1520; background: linear-gradient(135deg, #5ee4a0 0%, #4ac98c 100%); border-color: #7ef0bc; font-weight: 700; text-shadow: 0 1px 0 rgba(255,255,255,.15); }
        .pg-primary:hover:not(:disabled) { background: linear-gradient(135deg, #7ef0bc 0%, #5ee4a0 100%); box-shadow: 0 2px 12px rgba(94,228,160,.3); }
        .pg-danger { color: #ffdede; background: linear-gradient(135deg, #5a2a34 0%, #4a2230 100%); border-color: #8a4050; }
        .pg-danger:hover:not(:disabled) { background: linear-gradient(135deg, #6a3440 0%, #5a2a36 100%); }
        .pg-note { margin: 8px 0 0; color: #7e90a4; font-size: 12px; line-height: 1.6; }
        .pg-log-wrap { flex-shrink: 0; border-top: 1px solid #2a3a4e; background: #0a0f16; }
        .pg-log-head { display: flex; justify-content: space-between; align-items: center; padding: 8px 14px 4px; color: #7e90a4; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .pg-log { max-height: 148px; overflow: auto; padding: 0 14px 10px; font: 11px/1.6 ui-monospace, SFMono-Regular, Consolas, "Cascadia Mono", monospace; }
        .pg-log-line { color: #7e90a4; word-break: break-word; }
        .pg-log-success { color: #5ee4a0; }
        .pg-log-warn { color: #ffc94d; }
        .pg-log-error { color: #ff7e7e; }
        .pg-empty { margin: 8px 3px; color: #607080; }
      </style>
      <section class="pg-wrap" aria-label="复古打宝挂机助手">
        <header class="pg-header">
          <div class="pg-title">挂机助手<small>强化 · 材料 · BOSS · 爬塔 · 奖励</small></div>
          <button class="pg-icon-button" data-action="minimize" title="收起面板" aria-label="收起面板">−</button>
          <button class="pg-icon-button" data-action="close" title="关闭助手" aria-label="关闭助手">×</button>
        </header>
        <div class="pg-summary" data-ref="summary">正在读取角色…</div>
        <div class="pg-status" data-ref="status">等待操作</div>
        <div class="pg-tabs">
          <button class="pg-tab active" data-tab="enhance">自动强化</button>
          <button class="pg-tab" data-tab="shop">金币材料</button>
          <button class="pg-tab" data-tab="boss">世界BOSS</button>
          <button class="pg-tab" data-tab="tower">自动爬塔</button>
          <button class="pg-tab" data-tab="rewards">自动领奖</button>
        </div>
        <section class="pg-tab-panel" data-panel="enhance">
          <div class="pg-grid">
            <label class="pg-field"><span>强化范围</span><select data-ref="enhanceScope"><option value="selected">仅勾选装备</option><option value="equipped">仅穿戴装备</option><option value="all">全部背包/穿戴</option></select></label>
            <label class="pg-field"><span>目标强化等级</span><input data-ref="enhanceTarget" type="number" min="1" max="999"></label>
            <label class="pg-field"><span>保留金币</span><input data-ref="reserveGold" type="number" min="0" step="100"></label>
            <label class="pg-field"><span>单件最大连续失败</span><input data-ref="maxFailures" type="number" min="0" max="50"></label>
            <label class="pg-field"><span>每次间隔（毫秒）</span><input data-ref="enhanceDelay" type="number" min="300" step="100"></label>
            <label class="pg-field"><span>本次最大次数</span><input data-ref="maxEnhanceAttempts" type="number" min="1" max="10000"></label>
          </div>
          <label class="pg-check"><input data-ref="useProtectCharm" type="checkbox">强化时使用保护符</label>
          <label class="pg-check"><input data-ref="stopWithoutProtectCharm" type="checkbox">保护符不足时停止该装备</label>
          <div class="pg-section-title"><span>装备列表</span><button data-action="refresh-equipment">刷新</button></div>
          <div class="pg-list" data-ref="equipmentList"></div>
          <p class="pg-note" data-ref="enhanceSelection" aria-live="polite">未勾选装备，不会提交强化。</p>
          <div class="pg-actions"><button class="pg-primary" data-action="start-enhance">开始自动强化</button><button class="pg-danger" data-action="stop">停止</button></div>
          <p class="pg-note">手动勾选后仅强化勾选装备；运行期间锁定本轮清单和参数。每次强化前检查预览，达到目标或停止条件后结束。</p>
        </section>
        <section class="pg-tab-panel" data-panel="shop" hidden>
          <div class="pg-section-title"><span>系统行商 · 金币材料</span><button data-action="refresh-shop">刷新</button></div>
          <div class="pg-list pg-shop-list" data-ref="shopList"></div>
          <p class="pg-note" data-ref="shopEstimate">正在读取金币订单…</p>
          <div class="pg-actions"><button class="pg-primary" data-action="buy-all" data-unavailable="true">一键购买三种</button><button class="pg-danger" data-action="stop">停止</button></div>
          <p class="pg-note">强化石 1000 个、洗练石 1000 个、高级强化石 999 个。按整份购买，分批完成；金币不足或订单变化时停止。</p>
        </section>
        <section class="pg-tab-panel" data-panel="boss" hidden>
          <div class="pg-grid">
            <label class="pg-field"><span>挑战范围</span><select data-ref="bossScope"><option value="all">所有可用世界BOSS</option><option value="selected">仅勾选BOSS</option></select></label>
            <label class="pg-field"><span>本次最大次数</span><input data-ref="bossMaxAttempts" type="number" min="1" max="500"></label>
            <label class="pg-field"><span>每次间隔（毫秒）</span><input data-ref="bossDelay" type="number" min="500" step="100"></label>
          </div>
          <label class="pg-check"><input data-ref="bossLoop" type="checkbox">循环参与，直到没有可用次数</label>
          <div class="pg-section-title"><span>世界BOSS列表</span><button data-action="refresh-boss">刷新</button></div>
          <div class="pg-list" data-ref="bossList"></div>
          <div class="pg-actions"><button class="pg-primary" data-action="start-boss">一键挑战世界BOSS</button><button class="pg-danger" data-action="stop">停止</button></div>
          <p class="pg-note">每次参与消耗游戏设定的首领门票；脚本遵循服务器返回的剩余次数和开放状态。</p>
        </section>
        <section class="pg-tab-panel" data-panel="tower" hidden>
          <div class="pg-section-title"><span>试炼之塔</span><button data-action="refresh-tower">刷新</button></div>
          <p class="pg-tower-summary" data-ref="towerSummary" aria-live="polite">正在读取爬塔状态…</p>
          <div class="pg-grid">
            <label class="pg-field"><span>目标层数</span><input data-ref="towerTarget" type="number" min="1" max="100"></label>
            <label class="pg-field"><span>挑战间隔（毫秒）</span><input data-ref="towerDelay" type="number" min="500" max="60000" step="100"></label>
          </div>
          <p class="pg-note" data-ref="towerSkills"></p>
          <p class="pg-note">默认使用前三个可用技能，不附加增益和词缀。胜利后继续下一层，失败、达到目标或不可挑战时停止。</p>
          <div class="pg-actions"><button class="pg-primary" data-action="start-tower">开始自动爬塔</button><button class="pg-danger" data-action="stop">停止</button></div>
        </section>
        <section class="pg-tab-panel" data-panel="rewards" hidden>
          <div class="pg-section-title"><span>公会与活动奖励</span><button data-action="refresh-rewards">刷新</button></div>
          <div class="pg-list pg-reward-list">
            <div class="pg-reward-row"><span><strong>公会奖励</strong><small data-ref="rewardGuildDetail">正在读取分红与进度奖励…</small></span><b class="pg-reward-count" data-ref="rewardGuildCount" aria-label="公会可领取数量">–</b></div>
            <div class="pg-reward-row"><span><strong>活动奖励</strong><small data-ref="rewardActivityDetail">正在读取签到与活动奖励…</small></span><b class="pg-reward-count" data-ref="rewardActivityCount" aria-label="活动可领取数量">–</b></div>
          </div>
          <p class="pg-note" data-ref="rewardEstimate" aria-live="polite">正在检查可领取项目…</p>
          <div class="pg-actions"><button class="pg-primary" data-action="claim-all" data-unavailable="true">一键领取全部</button><button class="pg-danger" data-action="stop">停止</button></div>
          <div class="pg-actions pg-reward-secondary"><button data-action="claim-guild" data-unavailable="true">领取公会奖励</button><button data-action="claim-activity" data-unavailable="true">领取活动奖励</button></div>
          <p class="pg-note">仅领取服务器标记为可领取的免费项目：公会分红、捐献进度、签到、活跃箱、任务、成就、图鉴和推币场已解锁奖励。不会开始小游戏、购买彩票、兑换、捐献或执行付费功能。</p>
        </section>
        <div class="pg-log-wrap"><div class="pg-log-head"><span>运行日志</span><button data-action="clear-log">清空</button></div><div class="pg-log" data-ref="log" aria-live="polite"></div></div>
      </section>`;

    const get = (selector) => shadow.querySelector(selector);
    panel = {
      host,
      shadow,
      wrap: get(".pg-wrap"),
      summary: get('[data-ref="summary"]'),
      status: get('[data-ref="status"]'),
      equipmentList: get('[data-ref="equipmentList"]'),
      enhanceSelection: get('[data-ref="enhanceSelection"]'),
      shopList: get('[data-ref="shopList"]'),
      shopEstimate: get('[data-ref="shopEstimate"]'),
      buyAll: get('[data-action="buy-all"]'),
      towerSummary: get('[data-ref="towerSummary"]'),
      towerSkills: get('[data-ref="towerSkills"]'),
      towerTarget: get('[data-ref="towerTarget"]'),
      towerDelay: get('[data-ref="towerDelay"]'),
      towerStart: get('[data-action="start-tower"]'),
      refreshTower: get('[data-action="refresh-tower"]'),
      rewardGuildDetail: get('[data-ref="rewardGuildDetail"]'),
      rewardGuildCount: get('[data-ref="rewardGuildCount"]'),
      rewardActivityDetail: get('[data-ref="rewardActivityDetail"]'),
      rewardActivityCount: get('[data-ref="rewardActivityCount"]'),
      rewardEstimate: get('[data-ref="rewardEstimate"]'),
      claimGuild: get('[data-action="claim-guild"]'),
      claimActivity: get('[data-action="claim-activity"]'),
      claimAll: get('[data-action="claim-all"]'),
      refreshRewards: get('[data-action="refresh-rewards"]'),
      bossList: get('[data-ref="bossList"]'),
      log: get('[data-ref="log"]'),
      enhanceScope: get('[data-ref="enhanceScope"]'),
      enhanceTarget: get('[data-ref="enhanceTarget"]'),
      reserveGold: get('[data-ref="reserveGold"]'),
      maxFailures: get('[data-ref="maxFailures"]'),
      enhanceDelay: get('[data-ref="enhanceDelay"]'),
      maxEnhanceAttempts: get('[data-ref="maxEnhanceAttempts"]'),
      useProtectCharm: get('[data-ref="useProtectCharm"]'),
      stopWithoutProtectCharm: get('[data-ref="stopWithoutProtectCharm"]'),
      bossScope: get('[data-ref="bossScope"]'),
      bossMaxAttempts: get('[data-ref="bossMaxAttempts"]'),
      bossDelay: get('[data-ref="bossDelay"]'),
      bossLoop: get('[data-ref="bossLoop"]'),
      enhanceStart: get('[data-action="start-enhance"]'),
      bossStart: get('[data-action="start-boss"]'),
      refreshEquipment: get('[data-action="refresh-equipment"]'),
      refreshBoss: get('[data-action="refresh-boss"]'),
      refreshShop: get('[data-action="refresh-shop"]'),
    };

    setInputValue(panel.enhanceScope, settings.enhanceScope);
    setInputValue(panel.enhanceTarget, settings.enhanceTarget);
    setInputValue(panel.reserveGold, settings.reserveGold);
    setInputValue(panel.maxFailures, settings.maxFailuresPerEquipment);
    setInputValue(panel.enhanceDelay, settings.enhanceDelayMs);
    setInputValue(panel.maxEnhanceAttempts, settings.maxEnhanceAttempts);
    panel.useProtectCharm.checked = Boolean(settings.useProtectCharm);
    panel.stopWithoutProtectCharm.checked = Boolean(
      settings.stopWithoutProtectCharm,
    );
    setInputValue(panel.bossScope, settings.bossScope);
    setInputValue(panel.bossMaxAttempts, settings.bossMaxAttempts);
    setInputValue(panel.bossDelay, settings.bossDelayMs);
    panel.bossLoop.checked = Boolean(settings.bossLoop);
    setInputValue(panel.towerTarget, settings.towerTarget);
    setInputValue(panel.towerDelay, settings.towerDelayMs);

    for (const input of shadow.querySelectorAll("input, select")) {
      input.addEventListener("change", () => {
        if (busy()) return;
        if (input.closest('[data-panel="enhance"]')) {
          readEnhanceSettingsFromUi();
          if (input === panel.enhanceScope) createEquipmentRows(currentState);
          renderEnhancementSelection();
        } else if (input.closest('[data-panel="tower"]')) {
          readTowerSettingsFromUi();
        } else {
          readBossSettingsFromUi();
          if (input === panel.bossScope) createBossRows(currentState);
        }
      });
    }
    for (const tab of shadow.querySelectorAll(".pg-tab")) {
      tab.addEventListener("click", () => {
        for (const candidate of shadow.querySelectorAll(".pg-tab"))
          candidate.classList.toggle("active", candidate === tab);
        for (const page of shadow.querySelectorAll(".pg-tab-panel"))
          page.hidden = page.dataset.panel !== tab.dataset.tab;
      });
    }
    shadow
      .querySelector('[data-action="start-enhance"]')
      .addEventListener("click", () => void runEnhancement());
    shadow
      .querySelector('[data-action="start-boss"]')
      .addEventListener("click", () => void runWorldBoss());
    panel.towerStart.addEventListener("click", () => void runTower());
    panel.claimGuild.addEventListener("click", () => void runRewardClaims("guild"));
    panel.claimActivity.addEventListener("click", () => void runRewardClaims("activity"));
    panel.claimAll.addEventListener("click", () => void runRewardClaims("all"));
    panel.buyAll.addEventListener("click", () => void purchaseMaterials(SHOP_TARGETS));
    for (const stopButton of shadow.querySelectorAll('[data-action="stop"]'))
      stopButton.addEventListener("click", () => {
        stopRequested = true;
        setStatus("正在停止，等待当前请求结束…", "busy");
      });
    panel.refreshEquipment.addEventListener("click", () => void refreshState().catch(() => {}));
    panel.refreshBoss.addEventListener("click", () => void refreshState().catch(() => {}));
    panel.refreshShop.addEventListener("click", () => void refreshState().catch(() => {}));
    panel.refreshTower.addEventListener("click", () => void refreshState().catch(() => {}));
    panel.refreshRewards.addEventListener("click", () => void refreshState().catch(() => {}));
    shadow
      .querySelector('[data-action="clear-log"]')
      .addEventListener("click", () => panel.log.replaceChildren());
    shadow
      .querySelector('[data-action="minimize"]')
      .addEventListener("click", () =>
        panel.wrap.classList.toggle("pg-minimized"),
      );
    shadow
      .querySelector('[data-action="close"]')
      .addEventListener("click", () => {
        if (taskRunning()) {
          stopRequested = true;
          setStatus("面板已关闭，正在停止后续操作…", "busy");
        }
        host.hidden = true;
      });
    const minimizedStyle = document.createElement("style");
    minimizedStyle.textContent =
      ".pg-wrap.pg-minimized > :not(.pg-header) { display:none; }";
    shadow.appendChild(minimizedStyle);
    updateButtons();
    (document.body || document.documentElement).appendChild(host);
    return panel;
  }

  window.__PLACEGAME_SHOW_HELPER__ = () => {
    if (!panel) return;
    panel.host.hidden = false;
    panel.wrap.classList.remove("pg-minimized");
  };

  function mount() {
    if (panel || !document.documentElement) return;
    buildPanel();
    void refreshState(true).catch(() => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
