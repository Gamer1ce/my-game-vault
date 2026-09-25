import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateMedia } from "../src/private-media.mjs";

test("only Dai can delete a version-matched private video, without touching public or nonvideo files", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "private-delete-"));
  const dir = path.join(root, "private"), outside = path.join(root, "public");
  mkdirSync(dir); mkdirSync(outside); mkdirSync(path.join(dir, "游戏"));
  writeFileSync(path.join(dir, "游戏", "片段.webm"), "video");
  writeFileSync(path.join(dir, "keep.jpg"), "image");
  writeFileSync(path.join(dir, ".hidden.mp4"), "hidden");
  writeFileSync(path.join(outside, "public.mp4"), "public");
  symlinkSync(outside, path.join(dir, "escape"));
  symlinkSync(path.join(outside, "public.mp4"), path.join(dir, "link.mp4"));
  let loggedIn = true;
  const mediaUser = req => loggedIn && req.get("x-user") === "dai" ? { username: "戴卓然", displayName: "戴卓然", library: "dai" }
    : req.get("x-user") === "other" ? { username: "other", library: "dai" }
    : req.get("x-user") === "wrong-library" ? { username: "戴卓然", library: "other" } : null;
  const media = createPrivateMedia({ dataDirectory: root, directory: dir, mediaUser });
  const app = express(); app.use(express.json()); app.use("/api/my-media", media.router);
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { media.close(); server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (route = "", { method = "GET", user = "dai", body, headers = {} } = {}) => fetch(origin + "/api/my-media" + route, {
    method, headers: { Origin: origin, "x-user": user, "Content-Type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  const index = await (await call()).json(); assert.equal(index.canDelete, true);
  assert.equal((await (await call("", { user: "other" })).json()).canDelete, false);
  const item = index.videos[0], endpoint = `/files/${encodeURIComponent(item.filename)}`;
  const options = { method: "DELETE", body: { size: item.size, modifiedAt: item.modifiedAt } };
  for (const user of ["", "admin", "wrong-library"]) assert.equal((await call(endpoint, { ...options, user })).status, 401);
  assert.equal((await call(endpoint, { ...options, user: "other" })).status, 403);
  for (const headers of [{ Origin: "https://evil.test" }, { Origin: "" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await call(endpoint, { ...options, headers })).status, 403);
  }
  assert.equal((await call(endpoint, { method: "DELETE" })).status, 400);
  assert.equal((await call(endpoint, { ...options, body: { ...options.body, size: 99 } })).status, 409);
  assert.equal((await call(endpoint, { ...options, body: { ...options.body, modifiedAt: "2000-01-01T00:00:00.000Z" } })).status, 409);
  for (const filename of ["../public/public.mp4", "escape/public.mp4", "link.mp4", ".hidden.mp4", "keep.jpg", "游戏"]) {
    assert.equal((await call(`/files/${encodeURIComponent(filename)}`, options)).status, 404);
  }
  assert.ok(existsSync(path.join(dir, item.filename)));
  loggedIn = false; assert.equal((await call(endpoint, options)).status, 401); loggedIn = true;
  assert.equal((await call(endpoint, options)).status, 204);
  assert.equal(existsSync(path.join(dir, item.filename)), false);
  assert.equal((await (await call()).json()).videos.length, 0);
  assert.equal((await call(endpoint)).status, 404);
  assert.equal((await call(endpoint, options)).status, 404);
  assert.equal(readFileSync(path.join(outside, "public.mp4"), "utf8"), "public");
  assert.equal(readFileSync(path.join(dir, "keep.jpg"), "utf8"), "image");
  assert.ok(existsSync(path.join(dir, "游戏")));
});

test("private delete UI requires explicit confirmation and separate control", () => {
  const source = readFileSync(new URL("../public/my-videos.js", import.meta.url), "utf8");
  assert.match(source, /if \(canDelete\)/);
  assert.match(source, /window\.confirm/);
  assert.match(source, /无法撤销/);
  assert.match(source, /card\.append\(remove\)/);
  assert.match(source, /"DELETE", \{ size: item\.size, modifiedAt: item\.modifiedAt \}/);
});
