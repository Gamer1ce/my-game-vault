import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { PROFILE_THEMES, DEFAULT_PROFILE_DESIGN, normalizeProfileDesign } from "../public/voice-design.js";

test("profile UI previews, discards and explicitly applies AI designs without changing manual drafts", async () => {
  class Node {
    constructor() { this.value = ""; this.textContent = ""; this.dataset = {}; this.listeners = {}; this.children = []; this.classList = { toggle() {} }; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    replaceChildren(...nodes) { this.children = nodes; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
    querySelectorAll() { return []; }
    scrollIntoView() {}
  }
  const nodes = new Map(); const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const initial = { id: "me", username: "player", displayName: "My Name", bio: "Original bio", theme: "yellow", design: { ...DEFAULT_PROFILE_DESIGN } };
  const draft = { theme: "blue", bio: "AI bio", design: { ...DEFAULT_PROFILE_DESIGN, layout: "centered", font: "mono", banner: "orbit", tagline: "星海" } };
  let user = initial, saved = 0, generated = 0;
  const info = () => ({ enabled: true, model: "grok-4.6", dailyLimit: 8, remaining: 8 - generated });
  const context = vm.createContext({ console, PROFILE_THEMES, DEFAULT_PROFILE_DESIGN, normalizeProfileDesign,
    document: { querySelector: get, createElement: () => new Node(), hidden: false, addEventListener() {} },
    window: { addEventListener() {} }, setInterval: () => 1, clearInterval() {}, AbortController, AbortSignal,
    matchMedia: () => ({ matches: true }), fetch: async (url, options = {}) => {
      let response;
      if (url.endsWith("/session")) response = { user, csrf: "csrf-test" };
      else if (url.endsWith("/rooms")) response = { rooms: [{ id: "lobby", name: "大厅", capacity: 6, description: "", members: [] }, { id: "squad", name: "组队", capacity: 6, members: [] }, { id: "lounge", name: "电台", capacity: 6, members: [] }] };
      else if (url.endsWith("/profile-ai")) { if (options.body) { generated++; response = { draft, ...info() }; } else response = info(); }
      else if (url.endsWith("/profile")) { saved++; user = { ...user, ...JSON.parse(options.body) }; response = { user }; }
      else throw new Error("Unexpected request");
      return { ok: true, status: 200, json: async () => structuredClone(response) };
    }
  });
  const code = readFileSync(new URL("../public/voice.js", import.meta.url), "utf8").replace(/^import[^\n]+\n/, "");
  vm.runInContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get("#aiDesignForm").hidden, false);
  get("#bio").value = "Unsaved manual bio";
  get("#designPrompt").value = "Make a blue space profile";
  await get("#aiDesignForm").listeners.submit({ preventDefault() {} });
  assert.equal(saved, 0); assert.equal(get("#profilePreview").dataset.banner, "orbit");
  assert.equal(get("#previewState").hidden, false); assert.equal(get("#profileFields").disabled, true);
  assert.equal(get("#previewBio").textContent, "AI bio");
  get("#discardDesign").listeners.click();
  assert.equal(saved, 0); assert.equal(get("#profilePreview").dataset.banner, "solid");
  assert.equal(get("#previewBio").textContent, "Unsaved manual bio");
  assert.equal(get("#profileFields").disabled, false);
  await get("#aiDesignForm").listeners.submit({ preventDefault() {} });
  get("#applyDesign").listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, 1); assert.equal(user.design.banner, "orbit"); assert.equal(user.bio, "AI bio");
  assert.equal(get("#previewState").hidden, true); assert.equal(get("#profileFields").disabled, false);
  get("#resetDesign").listeners.click();
  assert.equal(saved, 1); assert.equal(get("#profilePreview").dataset.banner, "solid");
  await get("#profileForm").listeners.submit({ preventDefault() {} });
  assert.equal(saved, 2); assert.deepEqual(user.design, DEFAULT_PROFILE_DESIGN);
});
