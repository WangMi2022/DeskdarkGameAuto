"use strict";

// Exercise the shipped renderer in Electron, including checkbox events and HTTP bodies.
// All requests are intercepted; these tests never contact the game server.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../renderer-helper.js"), "utf8");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "placegame-tests-"));
app.setPath("userData", profile);
app.disableHardwareAcceleration();

function installFixture(options) {
  localStorage.clear();
  localStorage.setItem("place-game-session-token", "offline-test-token");
  const state = {
    player: { nickname: "离线测试", level: 50, gold: options.gold ?? 100_000_000, rareCoin: 2_000_000 },
    equipment: options.equipment || [
      { id: "weapon", name: "神话永夜断罪", slot: "weapon", enhanceLevel: 31, status: "equipped" },
      { id: "armor", name: "铠甲", slot: "armor", enhanceLevel: 0, status: "equipped" },
      { id: "boots", name: "靴子", slot: "boots", enhanceLevel: 0, status: "equipped" },
    ],
    daily: {
      key: "2026-09-16", collectCount: 0, bossCount: 0, enhanceCount: 0,
      decomposeCount: 0, marketListCount: 0, marketBuyCount: 0, killCount: 0,
      claimedActivity: [], ...options.daily,
    },
    retention: {
      signIn: { lastClaimedKey: "", streak: 0, totalClaims: 0, claimedKeys: [], ...options.signIn },
    },
  };
  const bosses = options.bosses || [];
  const shopItems = options.shopItems || [];
  const activityView = structuredClone(options.activityView || {
    quests: [], achievements: [], codex: { categories: [], rewards: [] },
  });
  const coinPusherView = structuredClone(options.coinPusherView || {
    global: { canClaim: false, claimed: false },
    guild: { rewards: [] },
  });
  const guildView = structuredClone({
    joined: false, dividendClaimedKeys: [], dailyFundContribution: 0,
    dividendPreview: { eligible: false, claimed: false, reason: "尚无可领分红" },
    progressRewards: [], ...options.guildView,
  });
  const marketOrders = options.marketOrders || [
    { id: "npc-enhance", source: "npc", orderType: "sell", status: "active", currencyType: "gold", itemType: "material", itemKey: "strengthen_stone", itemName: "强化石", amount: 20, price: 10000 },
    { id: "npc-refine", source: "npc", orderType: "sell", status: "active", currencyType: "gold", itemType: "material", itemKey: "refine_stone", itemName: "洗练石", amount: 8, price: 6093 },
    { id: "npc-advanced", source: "npc", orderType: "sell", status: "active", currencyType: "gold", itemType: "material", itemKey: "advanced_stone", itemName: "高级强化石", amount: 3, price: 65000 },
  ];
  let tower = {
    unlocked: true, capped: false, highestFloor: 0, nextFloor: 1,
    challengeOptions: { skills: ["slash", "fire", "ice", "heal"].map((key) => ({ key, name: key })), buffs: [], affixes: [] },
    ...options.tower,
  };
  const towerView = () => ({ ...tower, floors: Array.from({ length: 100 }, (_, index) => ({
    floor: index + 1, enemyName: `守层敌人 ${index + 1}`, status: index + 1 <= tower.highestFloor ? "cleared" : index + 1 === tower.nextFloor ? "available" : "locked",
  })) });
  const calls = [];
  let releasePreview;
  let releaseBuy;
  let releaseTowerPreview;
  let releaseRewardClaim;
  let marketReads = 0;
  const purchased = {};
  const fixture = { state, bosses, calls, purchased, marketOrders, activityView, coinPusherView, guildView,
    previewWaiting: false, buyWaiting: false, towerPreviewWaiting: false, rewardClaimWaiting: false,
    releasePreview: () => releasePreview?.(), releaseBuy: () => releaseBuy?.(),
    releaseTowerPreview: () => releaseTowerPreview?.(),
    releaseRewardClaim: () => releaseRewardClaim?.(),
  };
  window.__fixture = fixture;

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method || "GET", body,
      idempotencyKey: new Headers(init.headers).get("idempotency-key") });
    const reply = (data, status = 200) => new Response(JSON.stringify({ ok: status === 200, data }), {
      status, headers: { "content-type": "application/json" },
    });
    if (url.pathname === "/api/client/bootstrap") {
      return reply(structuredClone(state));
    }
    if (url.pathname === "/api/client/view-sections") {
      if (JSON.stringify(body) === JSON.stringify({ sections: ["bosses"] })) return reply({ bosses: structuredClone(bosses) });
      if (JSON.stringify(body) === JSON.stringify({ sections: ["tower"] })) return reply({ tower: towerView() });
      if (JSON.stringify(body) === JSON.stringify({ sections: ["quests", "achievements", "codex"] })) {
        return reply(structuredClone(activityView));
      }
      throw new Error("Unexpected section request");
    }
    if (url.pathname === "/api/arcade/coin-pusher/view") return reply(structuredClone(coinPusherView));
    if (url.pathname === "/api/guild/view") return reply(structuredClone(guildView));
    const rewardClaimPaths = new Set([
      "/api/guild/claim-dividend", "/api/guild/claim-progress", "/api/retention/sign-in",
      "/api/daily/claim", "/api/quests/claim", "/api/achievements/claim", "/api/codex/claim",
      "/api/arcade/coin-pusher/claim-global", "/api/arcade/coin-pusher/claim-guild",
    ]);
    if (rewardClaimPaths.has(url.pathname)) {
      if (options.holdRewardClaim) {
        fixture.rewardClaimWaiting = true;
        await new Promise((resolve) => { releaseRewardClaim = resolve; });
        fixture.rewardClaimWaiting = false;
      }
      if (options.rewardClaimFails) throw new TypeError("Offline simulated reward response lost");
      if (!options.staleRewardState) {
        if (url.pathname === "/api/guild/claim-dividend") {
          guildView.dividendPreview = { ...guildView.dividendPreview, eligible: false, claimed: true };
          guildView.dividendClaimedKeys.push(state.daily.key);
        } else if (url.pathname === "/api/guild/claim-progress") {
          const reward = guildView.progressRewards.find((entry) => entry.point === body.point);
          if (!reward) throw new Error("Unknown guild progress reward");
          reward.canClaim = false; reward.claimed = true;
        } else if (url.pathname === "/api/retention/sign-in") {
          state.retention.signIn.lastClaimedKey = state.daily.key;
          state.retention.signIn.claimedKeys.push(state.daily.key);
          state.retention.signIn.streak += 1;
        } else if (url.pathname === "/api/daily/claim") {
          state.daily.claimedActivity.push(body.point);
        } else if (url.pathname === "/api/arcade/coin-pusher/claim-global") {
          coinPusherView.global.claimed = true;
          coinPusherView.global.canClaim = false;
        } else if (url.pathname === "/api/arcade/coin-pusher/claim-guild") {
          const reward = coinPusherView.guild.rewards.find((entry) => entry.point === body.point);
          if (!reward) throw new Error("Unknown coin pusher guild reward");
          reward.canClaim = false; reward.claimed = true;
        } else {
          const collection = url.pathname === "/api/quests/claim" ? activityView.quests
            : url.pathname === "/api/achievements/claim" ? activityView.achievements
              : activityView.codex.rewards;
          const key = body.questKey || body.achievementKey || body.rewardKey;
          const reward = collection.find((entry) => entry.key === key);
          if (!reward) throw new Error("Unknown activity reward");
          reward.canClaim = false; reward.claimed = true;
        }
      }
      return reply({});
    }
    if (url.pathname === "/api/npc-shop/items") {
      return reply(structuredClone(shopItems));
    }
    if (url.pathname === "/api/market/orders") {
      marketReads += 1;
      if (marketReads === 2 && options.changePrice) marketOrders[0].price *= 2;
      const size = options.marketPageSize || 30;
      const offset = Number(url.searchParams.get("cursor") || 0);
      const hasMore = offset + size < marketOrders.length;
      return reply({ items: structuredClone(marketOrders.slice(offset, offset + size)), hasMore, nextCursor: hasMore ? String(offset + size) : null });
    }
    if (url.pathname === "/api/market/buy") {
      if (options.holdBuy) {
        fixture.buyWaiting = true;
        await new Promise((resolve) => { releaseBuy = resolve; });
        fixture.buyWaiting = false;
      }
      const order = marketOrders.find((entry) => entry.id === body.orderId);
      if (!order || !Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 99) throw new Error("Invalid market purchase");
      if (options.buyFails) throw new TypeError("Offline simulated response lost");
      if (options.buyLimited) return reply({}, 429);
      state.player.gold -= order.price * body.quantity;
      purchased[order.itemKey] = (purchased[order.itemKey] || 0) + order.amount * body.quantity;
      return reply({});
    }
    if (url.pathname === "/api/tower/preview") {
      if (options.holdTowerPreview) {
        fixture.towerPreviewWaiting = true;
        await new Promise((resolve) => { releaseTowerPreview = resolve; });
        fixture.towerPreviewWaiting = false;
      }
      return reply({ chance: 90, predictedWin: true, outputReady: true, survivalReady: true, ...options.towerPreview });
    }
    if (url.pathname === "/api/tower/challenge") {
      if (options.towerFails) throw new TypeError("Offline simulated response lost");
      if (body.floor !== tower.nextFloor) throw new Error("Skipped or repeated tower floor");
      const outcome = body.floor === options.defeatFloor ? "defeat" : "victory";
      if (outcome === "victory" && !options.staleTower) {
        tower = { ...tower, highestFloor: body.floor, nextFloor: body.floor + 1, capped: body.floor === 100 };
      }
      return reply({ battle: { events: options.noBattleResult ? [] : [{ type: "start" }, { type: outcome }] }, rewards: { summary: ["金币 100"] } });
    }
    if (url.pathname === "/api/equipment/enhance-preview") {
      if (options.holdPreview) {
        fixture.previewWaiting = true;
        await new Promise((resolve) => { releasePreview = resolve; });
        fixture.previewWaiting = false;
      }
      const item = state.equipment.find((entry) => entry.id === body.equipmentId);
      return reply({ currentLevel: item.enhanceLevel, nextLevel: item.enhanceLevel + 1,
        goldCost: 10, ownedGold: state.player.gold, canAfford: true,
        canUseProtectCharm: false, ownedProtectCharm: 0, protectCharmCost: 1,
        ...options.preview });
    }
    if (url.pathname === "/api/equipment/enhance") {
      const item = state.equipment.find((entry) => entry.id === body.equipmentId);
      if (options.enhanceSuccess !== false) item.enhanceLevel += 1;
      if (options.addEquipmentOnEnhance && !state.equipment.some((entry) => entry.id === "new-item")) {
        state.equipment.push({ id: "new-item", name: "新获得装备", enhanceLevel: 0, status: "equipped" });
      }
      return reply({ result: { success: options.enhanceSuccess !== false,
        nextLevel: item.enhanceLevel, message: "离线测试结果" } });
    }
    if (url.pathname === "/api/boss/assist") {
      const boss = bosses.find((entry) => entry.key === body.bossKey);
      boss.worldInstance.remainingAttemptCount -= 1;
      return reply({ damage: 100, worldBoss: structuredClone(boss.worldInstance) });
    }
    if (url.pathname === "/api/npc-shop/buy") {
      const item = shopItems.find((entry) => entry.key === body.shopItemKey);
      if (!item) throw new Error("Unknown shop item");
      state.player.rareCoin -= body.quantity * item.rareCoinCost;
      item.owned = (item.owned || 0) + body.quantity;
      return reply({ success: true });
    }
    throw new Error(`Unexpected offline request: ${url.pathname}`);
  };

  async function waitFor(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for helper state");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const root = () => document.getElementById("placegame-auto-helper-host").shadowRoot;
  const ref = (name) => root().querySelector(`[data-ref="${name}"]`);
  const button = (action) => root().querySelector(`[data-action="${action}"]`);
  const set = (name, value) => {
    const input = ref(name);
    if (input.type === "checkbox") {
      if (input.checked !== value) input.click();
    } else {
      input.value = String(value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  window.__test = {
    root, ref, button, set, waitFor, fixture,
    checkEquipment(ids) {
      for (const input of root().querySelectorAll("[data-equipment-id]")) {
        if (input.checked !== ids.includes(input.dataset.equipmentId)) input.click();
      }
    },
    async start(kind) {
      button(`start-${kind}`).click();
      await waitFor(() => !button(`start-${kind}`).disabled);
    },
    async buy(key) {
      const buyButton = root().querySelector(`[data-action="buy-shop"][data-shop-key="${key}"]`);
      if (!buyButton) throw new Error(`Missing shop button ${key}`);
      buyButton.click();
      await waitFor(() => !button("start-enhance").disabled);
    },
    async claimRewards(scope) {
      button(`claim-${scope}`).click();
      await waitFor(() => !button("start-enhance").disabled);
    },
    enhancedIds: () => calls.filter((call) => call.path === "/api/equipment/enhance").map((call) => call.body.equipmentId),
    assistedKeys: () => calls.filter((call) => call.path === "/api/boss/assist").map((call) => call.body.bossKey),
  };
}

async function exercise(options, work) {
  const window = new BrowserWindow({ show: false, width: options.width || 1440, height: options.height || 920, useContentSize: true, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    partition: `test-${crypto.randomUUID()}`,
  } });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) });
  });
  try {
    await window.loadFile(path.join(__dirname, "fixture.html"));
    await window.webContents.executeJavaScript(`(${installFixture.toString()})(${JSON.stringify(options)})`);
    await window.webContents.executeJavaScript(source);
    const result = await window.webContents.executeJavaScript(`(async () => {
      try {
        const h = window.__test;
        await h.waitFor(() => document.getElementById("placegame-auto-helper-host") && h.ref("status").textContent === "状态已同步");
        h.set("enhanceDelay", 300);
        h.set("bossDelay", 500);
        return { value: await (${work.toString()})(h) };
      } catch (error) { return { error: error.stack || error.message }; }
    })()`);
    if (result.error) throw new Error(result.error);
    if (options.capture) {
      const output = path.join(__dirname, "../.impeccable/review");
      fs.mkdirSync(output, { recursive: true });
      for (const tab of ["enhance", "shop", "boss", "tower", "rewards"]) {
        const bounds = await window.webContents.executeJavaScript(`(async () => {
          const h = window.__test;
          h.root().querySelector('[data-tab="${tab}"]').click();
          await new Promise(requestAnimationFrame);
          await new Promise((resolve) => setTimeout(resolve, 150));
          const rect = h.root().querySelector('.pg-wrap').getBoundingClientRect();
          return { x: Math.floor(rect.x) - 4, y: Math.floor(rect.y) - 4, width: Math.ceil(rect.width) + 8, height: Math.ceil(rect.height) + 8 };
        })()`);
        const capture = await window.webContents.capturePage(bounds);
        fs.writeFileSync(path.join(output, `${options.capture}-${tab}.png`), capture.toPNG());
      }
    }
    return result.value;
  } finally {
    window.destroy();
  }
}

const tests = [
  ["market-source: 截图中的强化石应走系统行商金币订单，不走元宝兑换", async () => {
    const paths = await exercise({ shopItems: [
      { key: "strengthen_stone", name: "强化石", rareCoinCost: 2, canBuy: true },
    ] }, async (h) => {
      await h.buy("strengthen_stone");
      return h.fixture.calls.filter((call) => call.path.endsWith("/buy")).map((call) => call.path);
    });
    assert.ok(paths.length > 0);
    assert.ok(paths.every((path) => path === "/api/market/buy"), `实际购买渠道：${[...new Set(paths)].join(", ")}`);
  }],
  ["selection: 勾选武器时仅提交武器 ID（原范围为穿戴）", async () => {
    const ids = await exercise({ equipment: [
      { id: "weapon", name: "神话永夜断罪", enhanceLevel: 31, status: "equipped" },
      { id: "armor", name: "铠甲", enhanceLevel: 0, status: "equipped" },
    ] }, async (h) => {
      h.set("enhanceScope", "equipped");
      h.set("enhanceTarget", 32);
      h.set("maxEnhanceAttempts", 1);
      h.checkEquipment(["weapon"]);
      await h.start("enhance");
      return h.enhancedIds();
    });
    assert.deepEqual(ids, ["weapon"]);
  }],
  ["selection-control: 仅勾选范围与刷新前后的名称、ID、勾选对应一致", async () => {
    const result = await exercise({}, async (h) => {
      h.set("enhanceScope", "selected");
      h.set("enhanceTarget", 32);
      h.set("maxEnhanceAttempts", 1);
      h.checkEquipment(["weapon"]);
      const rows = () => Array.from(h.root().querySelectorAll("[data-equipment-id]"), (input) => ({
        id: input.dataset.equipmentId, checked: input.checked, label: input.parentElement.textContent,
      })).sort((a, b) => a.id.localeCompare(b.id));
      const before = rows();
      h.button("refresh-equipment").click();
      await h.waitFor(() => h.ref("status").textContent === "状态已同步");
      const after = rows();
      await h.start("enhance");
      return { before, after, ids: h.enhancedIds() };
    });
    assert.deepEqual(result.before, result.after);
    assert.equal(result.before.find((item) => item.id === "weapon").checked, true);
    assert.match(result.before.find((item) => item.id === "weapon").label, /神话永夜断罪/);
    assert.equal(result.before.find((item) => item.id === "armor").checked, false);
    assert.match(result.before.find((item) => item.id === "armor").label, /铠甲/);
    assert.deepEqual(result.ids, ["weapon"]);
  }],
  ["selection-original: 武器、铠甲、靴子场景只强化武器，刷新后仍保持选择", async () => {
    const result = await exercise({}, async (h) => {
      h.set("enhanceScope", "all");
      h.set("enhanceTarget", 33);
      h.set("maxEnhanceAttempts", 3);
      h.checkEquipment(["weapon"]);
      await h.start("enhance");
      return { ids: h.enhancedIds(), keys: h.fixture.calls.filter((call) => call.path === "/api/equipment/enhance").map((call) => call.idempotencyKey) };
    });
    assert.deepEqual(result.ids, ["weapon", "weapon"]);
    assert.ok(result.keys.every(Boolean));
    assert.equal(new Set(result.keys).size, 2);
  }],
  ["selection-empty: 取消全部勾选并刷新后，不提交强化请求", async () => {
    const result = await exercise({}, async (h) => {
      h.set("enhanceScope", "all");
      h.set("enhanceTarget", 32);
      h.set("maxEnhanceAttempts", 1);
      h.checkEquipment([]);
      h.button("refresh-equipment").click();
      await h.waitFor(() => h.ref("status").textContent === "状态已同步");
      await h.start("enhance");
      return { ids: h.enhancedIds(), checked: h.root().querySelectorAll("[data-equipment-id]:checked").length };
    });
    assert.deepEqual(result, { ids: [], checked: 0 });
  }],
  ["selection-frozen: 本轮不会强化刷新后新增的装备", async () => {
    const ids = await exercise({ equipment: [
      { id: "weapon", name: "神话永夜断罪", enhanceLevel: 31, status: "equipped" },
    ], addEquipmentOnEnhance: true }, async (h) => {
      h.set("enhanceScope", "equipped");
      h.set("enhanceTarget", 33);
      h.set("maxEnhanceAttempts", 2);
      await h.start("enhance");
      return h.enhancedIds();
    });
    assert.deepEqual(ids, ["weapon", "weapon"]);
  }],
  ["stop-preview: 在预览等待期间停止，不再提交强化", async () => {
    const ids = await exercise({ holdPreview: true }, async (h) => {
      h.set("enhanceTarget", 32);
      h.set("maxEnhanceAttempts", 1);
      h.checkEquipment(["weapon"]);
      h.button("start-enhance").click();
      await h.waitFor(() => h.fixture.previewWaiting);
      h.button("stop").click();
      h.fixture.releasePreview();
      await h.waitFor(() => !h.button("start-enhance").disabled);
      return h.enhancedIds();
    });
    assert.deepEqual(ids, []);
  }],
  ["controls-locked: 运行时锁定参数和选择，所有页面停止按钮状态一致", async () => {
    const result = await exercise({ holdPreview: true }, async (h) => {
      const idleStops = Array.from(h.root().querySelectorAll('[data-action="stop"]'), (input) => input.disabled);
      h.set("enhanceTarget", 32);
      h.set("maxEnhanceAttempts", 1);
      h.checkEquipment(["weapon"]);
      h.button("start-enhance").click();
      await h.waitFor(() => h.fixture.previewWaiting);
      const inputsLocked = Array.from(h.root().querySelectorAll("input, select")).every((input) => input.disabled);
      const runningStops = Array.from(h.root().querySelectorAll('[data-action="stop"]'), (input) => input.disabled);
      h.root().querySelector('[data-panel="boss"] [data-action="stop"]').click();
      h.fixture.releasePreview();
      await h.waitFor(() => !h.button("start-enhance").disabled);
      return { idleStops, inputsLocked, runningStops, ids: h.enhancedIds() };
    });
    assert.deepEqual(result, { idleStops: [true, true, true, true, true], inputsLocked: true, runningStops: [false, false, false, false, false], ids: [] });
  }],
  ["preview-afford: 材料不足时不提交强化", async () => {
    const ids = await exercise({ preview: { canAfford: false } }, async (h) => {
      h.set("enhanceTarget", 32);
      h.set("maxEnhanceAttempts", 1);
      h.checkEquipment(["weapon"]);
      await h.start("enhance");
      return h.enhancedIds();
    });
    assert.deepEqual(ids, []);
  }],
  ["preview-level: 预览已达到目标时不使用过期等级继续强化", async () => {
    const ids = await exercise({ preview: { currentLevel: 32, nextLevel: 33 } }, async (h) => {
      h.set("enhanceTarget", 32);
      h.set("maxEnhanceAttempts", 1);
      h.checkEquipment(["weapon"]);
      await h.start("enhance");
      return h.enhancedIds();
    });
    assert.deepEqual(ids, []);
  }],
  ["failure-limit: 连续失败上限为 2 时恰好尝试 2 次", async () => {
    const ids = await exercise({ enhanceSuccess: false }, async (h) => {
      h.set("enhanceTarget", 32);
      h.set("maxEnhanceAttempts", 5);
      h.set("maxFailures", 2);
      h.checkEquipment(["weapon"]);
      await h.start("enhance");
      return h.enhancedIds();
    });
    assert.deepEqual(ids, ["weapon", "weapon"]);
  }],
  ["boss-once: 从视图接口读取 BOSS，每个开放场次各参与一次", async () => {
    const result = await exercise({ bosses: [
      { key: "a", name: "世界首领甲", type: "world", worldInstance: { instanceId: 1, status: "active", remainingAttemptCount: 3 } },
      { key: "b", name: "世界首领乙", type: "world", worldInstance: { instanceId: 2, status: "active", remainingAttemptCount: 2 } },
      { key: "closed", type: "world", worldInstance: { status: "ended", remainingAttemptCount: 2 } },
      { key: "unknown", type: "world" },
      { key: "empty", type: "world", worldInstance: { status: "active", remainingAttemptCount: 0 } },
    ] }, async (h) => {
      h.set("bossLoop", false);
      await h.start("boss");
      return { keys: h.assistedKeys(), sections: h.fixture.calls.filter((call) => call.path === "/api/client/view-sections").length };
    });
    assert.deepEqual(result.keys, ["a", "b"]);
    assert.ok(result.sections >= 2);
  }],
  ["boss-selection: 手动取消 BOSS 勾选后只参与保留的场次", async () => {
    const keys = await exercise({ bosses: [
      { key: "a", type: "world", worldInstance: { instanceId: 1, status: "active", remainingAttemptCount: 2 } },
      { key: "b", type: "world", worldInstance: { instanceId: 2, status: "active", remainingAttemptCount: 2 } },
    ] }, async (h) => {
      h.root().querySelector('[data-boss-key="a"]').click();
      h.set("bossLoop", false);
      await h.start("boss");
      return h.assistedKeys();
    });
    assert.deepEqual(keys, ["b"]);
  }],
  ["market-all: 按截图份量买齐 1000、1000、999 个，只花金币且分页读取", async () => {
    const result = await exercise({ marketPageSize: 1 }, async (h) => {
      h.button("buy-all").click();
      await h.waitFor(() => !h.button("start-enhance").disabled);
      return { purchased: h.fixture.purchased, gold: h.fixture.state.player.gold,
        rareCoin: h.fixture.state.player.rareCoin, calls: h.fixture.calls };
    });
    assert.deepEqual(result.purchased, { strengthen_stone: 1000, refine_stone: 1000, advanced_stone: 999 });
    assert.equal(result.gold, 100_000_000 - 50 * 10000 - 125 * 6093 - 333 * 65000);
    assert.equal(result.rareCoin, 2_000_000);
    assert.ok(!result.calls.some((call) => call.path.startsWith("/api/npc-shop/")));
    const buys = result.calls.filter((call) => call.path === "/api/market/buy");
    assert.deepEqual(buys.map((call) => call.body.quantity), [50, 99, 26, 99, 99, 99, 36]);
    assert.equal(new Set(buys.map((call) => call.idempotencyKey)).size, 7);
    assert.ok(result.calls.filter((call) => call.path === "/api/market/orders").every((call) => call.query.scope === "merchant" && call.query.currencyType === "gold"));
  }],
  ["market-targets: 三种金币材料均显示独立购买入口", async () => {
    const keys = await exercise({}, async (h) => Array.from(h.root().querySelectorAll('[data-action="buy-shop"]'), (button) => button.dataset.shopKey).sort());
    assert.deepEqual(keys, ["advanced_stone", "refine_stone", "strengthen_stone"]);
  }],
  ["market-source-filter: 排除玩家、元宝、过期和同名不同物品的订单", async () => {
    const order = { source: "npc", orderType: "sell", status: "active", currencyType: "gold", itemType: "material", itemKey: "strengthen_stone", itemName: "强化石", amount: 20, price: 10000 };
    const result = await exercise({ marketOrders: [
      { ...order, id: "player", source: "player", price: 1 },
      { ...order, id: "premium", currencyType: "rareCoin", price: 1 },
      { ...order, id: "expired", expiredAt: 1, price: 1 },
      { ...order, id: "wrong-item", itemKey: "advanced_stone_shard", price: 1 },
      { ...order, id: "correct" },
    ] }, async (h) => { await h.buy("strengthen_stone"); return h.fixture.calls.filter((call) => call.path === "/api/market/buy").map((call) => call.body); });
    assert.deepEqual(result, [{ orderId: "correct", quantity: 50 }]);
  }],
  ["market-gold: 金币不足时三种材料均不购买", async () => {
    const calls = await exercise({ gold: 100 }, async (h) => {
      h.button("buy-all").click();
      await h.waitFor(() => !h.button("start-enhance").disabled);
      return h.fixture.calls.filter((call) => call.path.endsWith("/buy"));
    });
    assert.deepEqual(calls, []);
  }],
  ["market-price: 价格变化后停止，不用旧报价提交购买", async () => {
    const calls = await exercise({ changePrice: true }, async (h) => {
      await h.buy("strengthen_stone");
      return h.fixture.calls.filter((call) => call.path.endsWith("/buy"));
    });
    assert.deepEqual(calls, []);
  }],
  ["market-stop: 分批购买期间停止不发下一批，重复点击不重复购买", async () => {
    const result = await exercise({ holdBuy: true }, async (h) => {
      h.root().querySelector('[data-shop-key="refine_stone"]').click();
      await h.waitFor(() => h.fixture.buyWaiting);
      h.button("buy-all").click();
      h.button("start-tower").click();
      h.button("stop").click();
      h.fixture.releaseBuy();
      await h.waitFor(() => !h.button("start-enhance").disabled);
      return { purchased: h.fixture.purchased, mutations: h.fixture.calls.filter((call) => call.path.endsWith("/buy") || call.path.endsWith("/challenge")) };
    });
    assert.deepEqual(result.purchased, { refine_stone: 792 });
    assert.equal(result.mutations.length, 1);
  }],
  ["market-error: 购买响应丢失时不重发，明确提示核对背包", async () => {
    const result = await exercise({ buyFails: true }, async (h) => {
      await h.buy("refine_stone");
      return { calls: h.fixture.calls.filter((call) => call.path.endsWith("/buy")), log: h.ref("log").textContent };
    });
    assert.equal(result.calls.length, 1);
    assert.match(result.log, /结果不确定/);
  }],
  ["market-combination: 从多个整份订单凑齐指定个数，不超购", async () => {
    const order = { source: "npc", status: "active", currencyType: "gold", itemType: "material", itemKey: "strengthen_stone", itemName: "强化石" };
    const result = await exercise({ marketOrders: [
      { ...order, id: "bundle-a", amount: 400, price: 1000 },
      { ...order, id: "bundle-b", amount: 600, price: 1100 },
    ] }, async (h) => { await h.buy("strengthen_stone"); return { purchased: h.fixture.purchased, gold: h.fixture.state.player.gold }; });
    assert.deepEqual(result, { purchased: { strengthen_stone: 1000 }, gold: 99_997_900 });
  }],
  ["market-unavailable: 没有精确数量的订单时禁用购买", async () => {
    const result = await exercise({ marketOrders: [
      { id: "bundle", source: "npc", status: "active", currencyType: "gold", itemType: "material", itemKey: "refine_stone", amount: 7, price: 100 },
    ] }, async (h) => {
      const disabled = h.root().querySelector('[data-shop-key="refine_stone"]').disabled;
      await h.buy("refine_stone");
      return { disabled, allDisabled: h.button("buy-all").disabled, purchased: h.fixture.purchased };
    });
    assert.deepEqual(result, { disabled: true, allDisabled: true, purchased: {} });
  }],
  ["rewards-activity: 只领取活动页已达成的免费奖励", async () => {
    const calls = await exercise({
      daily: { collectCount: 1, bossCount: 3, enhanceCount: 1, claimedActivity: [20] },
      activityView: {
        quests: [
          { key: "quest-ready", canClaim: true, claimed: false },
          { key: "quest-blocked", canClaim: false, claimed: false },
          { key: "quest-claimed", canClaim: false, claimed: true },
        ],
        achievements: [{ key: "achievement-ready", canClaim: true, claimed: false }],
        codex: { categories: [], rewards: [{ key: "codex-ready", canClaim: true, claimed: false }] },
      },
    }, async (h) => {
      await h.claimRewards("activity");
      return h.fixture.calls.filter((call) => call.path.includes("/claim") || call.path.endsWith("/sign-in"));
    });
    assert.deepEqual(calls.map(({ path, body }) => ({ path, body })), [
      { path: "/api/retention/sign-in", body: {} },
      { path: "/api/daily/claim", body: { point: 40 } },
      { path: "/api/daily/claim", body: { point: 60 } },
      { path: "/api/quests/claim", body: { questKey: "quest-ready" } },
      { path: "/api/achievements/claim", body: { achievementKey: "achievement-ready" } },
      { path: "/api/codex/claim", body: { rewardKey: "codex-ready" } },
    ]);
    assert.ok(calls.every((call) => call.idempotencyKey));
  }],
  ["rewards-guild: 领取公会分红和可领取的进度档位，不执行捐献或兑换", async () => {
    const calls = await exercise({ guildView: {
      joined: true, dailyFundContribution: 30,
      dividendPreview: { eligible: true, claimed: false, gold: 1000 },
      progressRewards: [
        { point: 20, canClaim: true, claimed: false },
        { point: 40, canClaim: true, claimed: false },
        { point: 60, canClaim: false, claimed: true },
      ],
    } }, async (h) => {
      await h.claimRewards("guild");
      return h.fixture.calls.filter((call) => call.path.startsWith("/api/guild/") && call.method === "POST");
    });
    assert.deepEqual(calls.map(({ path, body }) => ({ path, body })), [
      { path: "/api/guild/claim-dividend", body: {} },
      { path: "/api/guild/claim-progress", body: { point: 20 } },
      { path: "/api/guild/claim-progress", body: { point: 40 } },
    ]);
    assert.ok(calls.every((call) => call.idempotencyKey));
    assert.ok(calls.every((call) => !/donate|redeem|purchase/.test(call.path)));
  }],
  ["rewards-guild-explicit: 缺少服务器分红 eligible 时不根据贡献值自行领取", async () => {
    const calls = await exercise({
      guildView: {
        joined: true, dailyFundContribution: 999,
        dividendPreview: null, dividendClaimedKeys: [], progressRewards: [],
      },
    }, async (h) => {
      await h.claimRewards("guild");
      return h.fixture.calls.filter((call) => call.path === "/api/guild/claim-dividend");
    });
    assert.deepEqual(calls, []);
  }],
  ["rewards-arcade: 活动页只领取推币场已解锁的免费全服/公会奖励", async () => {
    const calls = await exercise({
      signIn: { lastClaimedKey: "2026-09-16", claimedKeys: ["2026-09-16"] },
      coinPusherView: {
        global: { canClaim: true, claimed: false },
        guild: { rewards: [
          { point: 50, canClaim: true, claimed: false },
          { point: 100, canClaim: false, claimed: false },
        ] },
      },
    }, async (h) => {
      await h.claimRewards("activity");
      return h.fixture.calls.filter((call) => call.path.includes("coin-pusher") && call.method === "POST");
    });
    assert.deepEqual(calls.map(({ path, body }) => ({ path, body })), [
      { path: "/api/arcade/coin-pusher/claim-global", body: {} },
      { path: "/api/arcade/coin-pusher/claim-guild", body: { point: 50 } },
    ]);
  }],
  ["rewards-all: 一键领取同时覆盖公会和活动两类奖励", async () => {
    const paths = await exercise({
      signIn: { lastClaimedKey: "2026-09-16", claimedKeys: ["2026-09-16"] },
      guildView: { joined: true, dividendPreview: { eligible: true, claimed: false }, progressRewards: [] },
      activityView: { quests: [{ key: "quest-ready", canClaim: true, claimed: false }], achievements: [], codex: { categories: [], rewards: [] } },
    }, async (h) => {
      await h.claimRewards("all");
      return h.fixture.calls.filter((call) => call.path.includes("/claim")).map((call) => call.path);
    });
    assert.deepEqual(paths, ["/api/guild/claim-dividend", "/api/quests/claim"]);
  }],
  ["rewards-none: 没有可领取项目时禁用相应按钮且不提交写请求", async () => {
    const result = await exercise({
      signIn: { lastClaimedKey: "2026-09-16", claimedKeys: ["2026-09-16"] },
    }, async (h) => {
      const disabled = ["claim-guild", "claim-activity", "claim-all"].map((action) => h.button(action).disabled);
      h.button("claim-all").click();
      return { disabled, writes: h.fixture.calls.filter((call) => call.method === "POST" && /claim|sign-in/.test(call.path)) };
    });
    assert.deepEqual(result, { disabled: [true, true, true], writes: [] });
  }],
  ["rewards-stop: 当前领取结束后停止，不再提交后续奖励", async () => {
    const calls = await exercise({
      holdRewardClaim: true,
      activityView: { quests: [{ key: "first", canClaim: true, claimed: false }, { key: "second", canClaim: true, claimed: false }], achievements: [], codex: { categories: [], rewards: [] } },
    }, async (h) => {
      h.button("claim-activity").click();
      await h.waitFor(() => h.fixture.rewardClaimWaiting);
      h.root().querySelector('[data-panel="rewards"] [data-action="stop"]').click();
      h.fixture.releaseRewardClaim();
      await h.waitFor(() => !h.button("start-enhance").disabled);
      return h.fixture.calls.filter((call) => call.path.includes("/claim") || call.path.endsWith("/sign-in"));
    });
    assert.equal(calls.length, 1);
  }],
  ["rewards-error: 领取响应丢失时不重发并提示结果不确定", async () => {
    const result = await exercise({
      rewardClaimFails: true,
      activityView: { quests: [{ key: "quest-ready", canClaim: true, claimed: false }], achievements: [], codex: { categories: [], rewards: [] } },
    }, async (h) => {
      await h.claimRewards("activity");
      return { calls: h.fixture.calls.filter((call) => call.path.includes("/claim") || call.path.endsWith("/sign-in")), log: h.ref("log").textContent };
    });
    assert.equal(result.calls.length, 1);
    assert.match(result.log, /结果不确定/);
    assert.match(result.log, /未自动重发/);
  }],
  ["rewards-stale: 领取后状态未更新时禁止重复提交同一奖励", async () => {
    const result = await exercise({
      staleRewardState: true,
      signIn: { lastClaimedKey: "2026-09-16", claimedKeys: ["2026-09-16"] },
      activityView: { quests: [{ key: "quest-ready", canClaim: true, claimed: false }], achievements: [], codex: { categories: [], rewards: [] } },
    }, async (h) => {
      await h.claimRewards("activity");
      return { calls: h.fixture.calls.filter((call) => call.path === "/api/quests/claim"), log: h.ref("log").textContent };
    });
    assert.equal(result.calls.length, 1);
    assert.match(result.log, /状态未更新/);
  }],
  ["tower-win: 胜利后逐层前进并在目标层停止，使用前三个技能", async () => {
    const result = await exercise({}, async (h) => {
      h.set("towerTarget", 3); h.set("towerDelay", 500);
      await h.start("tower");
      return { bodies: h.fixture.calls.filter((call) => call.path === "/api/tower/challenge").map((call) => call.body), summary: h.ref("towerSummary").textContent };
    });
    assert.deepEqual(result.bodies, [1, 2, 3].map((floor) => ({ floor, selectedSkillKeys: ["slash", "fire", "ice"], buffKey: "none", affixKey: "none" })));
    assert.match(result.summary, /已通关 3 层/);
  }],
  ["tower-defeat: 本层失败后不重复尝试或挑战后续层", async () => {
    const floors = await exercise({ defeatFloor: 2 }, async (h) => {
      h.set("towerTarget", 5); h.set("towerDelay", 500); await h.start("tower");
      return h.fixture.calls.filter((call) => call.path === "/api/tower/challenge").map((call) => call.body.floor);
    });
    assert.deepEqual(floors, [1, 2]);
  }],
  ["tower-stop: 预览等待时停止不提交挑战", async () => {
    const floors = await exercise({ holdTowerPreview: true }, async (h) => {
      h.button("start-tower").click();
      await h.waitFor(() => h.fixture.towerPreviewWaiting);
      h.root().querySelector('[data-panel="tower"] [data-action="stop"]').click();
      h.fixture.releaseTowerPreview();
      await h.waitFor(() => !h.button("start-tower").disabled);
      return h.fixture.calls.filter((call) => call.path === "/api/tower/challenge");
    });
    assert.deepEqual(floors, []);
  }],
  ["tower-unavailable: 未解锁或已封顶均不发挑战", async () => {
    for (const tower of [{ unlocked: false, blockedReason: "等级不足" }, { capped: true, highestFloor: 100, nextFloor: 0 }]) {
      const floors = await exercise({ tower }, async (h) => { await h.start("tower"); return h.fixture.calls.filter((call) => call.path.startsWith("/api/tower/")); });
      assert.deepEqual(floors, []);
    }
  }],
  ["tower-stale: 胜利后状态未推进，禁止重复挑战", async () => {
    const calls = await exercise({ staleTower: true }, async (h) => {
      h.set("towerDelay", 500); await h.start("tower");
      return h.fixture.calls.filter((call) => call.path === "/api/tower/challenge");
    });
    assert.equal(calls.length, 1);
  }],
  ["tower-error: 缺失胜负或网络失败时不重发挑战", async () => {
    for (const options of [{ noBattleResult: true }, { towerFails: true }]) {
      const calls = await exercise(options, async (h) => { await h.start("tower"); return h.fixture.calls.filter((call) => call.path === "/api/tower/challenge"); });
      assert.equal(calls.length, 1);
    }
  }],
  ["close-stop: 关闭助手会停止爬塔，菜单重新打开保留日志", async () => {
    const result = await exercise({ holdTowerPreview: true }, async (h) => {
      h.button("start-tower").click();
      await h.waitFor(() => h.fixture.towerPreviewWaiting);
      h.button("close").click();
      h.fixture.releaseTowerPreview();
      await h.waitFor(() => !h.button("start-tower").disabled);
      const hidden = document.getElementById("placegame-auto-helper-host").hidden;
      window.__PLACEGAME_SHOW_HELPER__();
      return { hidden, reopened: !document.getElementById("placegame-auto-helper-host").hidden,
        calls: h.fixture.calls.filter((call) => call.path === "/api/tower/challenge") };
    });
    assert.deepEqual(result, { hidden: true, reopened: true, calls: [] });
  }],
];

app.whenReady().then(async () => {
  if (process.argv.includes("--capture")) {
    for (const size of [{ width: 1440, height: 920, capture: "desktop" }, { width: 1000, height: 680, capture: "minimum" }]) {
      await exercise({ ...size, bosses: [{ key: "world_dragon", name: "世界首领", type: "world", worldInstance: { instanceId: 1, status: "active", remainingAttemptCount: 3, phase: 1, phaseProgressPercent: 12 } }] }, async () => {});
    }
    console.log("Captured 5 helper tabs at 1440x920 and 1000x680 under .impeccable/review");
    app.exit(0);
    return;
  }
  const filter = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
  let failed = 0;
  let count = 0;
  for (const [name, test] of tests) {
    if (filter && !name.startsWith(filter)) continue;
    count += 1;
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n${error.stack}`);
    }
  }
  console.log(`Results: ${count - failed}/${count} passed`);
  app.exit(failed || !count ? 1 : 0);
}).catch((error) => { console.error(error); app.exit(1); });

app.on("window-all-closed", () => {});
