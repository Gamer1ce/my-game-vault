import test from "node:test";
import assert from "node:assert/strict";
import {
  baiduMediaConfiguration,
  baiduVideoFiles,
  createAuthorizationUrl,
  getBaiduDownloadLink,
  listBaiduDirectory,
  probeBaiduPlayback
} from "../src/baidu-media.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("百度媒体配置规范化目录且授权地址只申请网盘权限", () => {
  const config = baiduMediaConfiguration({
    BAIDU_CLIENT_ID: "app-key",
    BAIDU_MEDIA_FOLDER: "/精彩时刻/../视频"
  });
  assert.equal(config.folder, "/视频");
  const url = new URL(createAuthorizationUrl(config, "safe-state"));
  assert.equal(url.searchParams.get("scope"), "basic,netdisk");
  assert.equal(url.searchParams.get("state"), "safe-state");
  assert.throws(() => baiduMediaConfiguration({ BAIDU_MEDIA_FOLDER: "relative" }), /绝对路径/);
});

test("目录分页并只筛选视频文件", async () => {
  let calls = 0;
  const files = await listBaiduDirectory({ accessToken: "token", folder: "/视频" }, async () => {
    calls += 1;
    return jsonResponse({ errno: 0, has_more: 0, list: [
      { fs_id: 1, isdir: 0, server_filename: "clip.mp4" },
      { fs_id: 2, isdir: 0, server_filename: "cover.jpg" },
      { fs_id: 3, isdir: 1, server_filename: "folder.webm" }
    ] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(baiduVideoFiles(files).map((item) => item.fs_id), [1]);
});

test("dlink 自动附加 access_token 但调用者可避免输出完整地址", async () => {
  const result = await getBaiduDownloadLink({ accessToken: "private-token" }, 12, async () => jsonResponse({
    errno: 0,
    list: [{ fs_id: 12, dlink: "https://d.example.com/file/video.mp4?fid=12" }]
  }));
  const url = new URL(result.url);
  assert.equal(url.searchParams.get("access_token"), "private-token");
});

test("Range 探测只接受 206 和有效 Content-Range", async () => {
  const result = await probeBaiduPlayback("https://d.example.com/video.mp4", {
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Range, "bytes=0-65535");
      return new Response(new Uint8Array([0]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-65535/999999", "Content-Type": "video/mp4", "Content-Length": "65536" }
      });
    }
  });
  assert.equal(result.rangeSupported, true);
  assert.equal(result.contentLength, 65536);
});
