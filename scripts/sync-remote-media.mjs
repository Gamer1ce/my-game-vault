import { createReadStream, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { listHighlights, resolveHighlightsDirectory } from "../src/highlights.mjs";
import {
  createRemoteMediaClient,
  readRemoteMediaManifest,
  remoteMediaConfiguration,
  remoteMediaManifestFilename,
  remoteObjectKey
} from "../src/remote-media.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const dryRun = process.argv.includes("--dry-run");
const config = remoteMediaConfiguration();
if (!config.uploadEnabled) {
  throw new Error("远程媒体配置不完整，请先填写 data/remote-media.env 中的 Bucket、Access Key 和 Secret Key");
}

const storage = resolveHighlightsDirectory(dataDirectory);
const videos = listHighlights(storage.directory, 5000).filter((item) => item.type === "video");
if (!videos.length) throw new Error(`没有找到可上传的视频：${storage.directory}`);

const client = createRemoteMediaClient(config);
const manifest = readRemoteMediaManifest(dataDirectory);
manifest.version = 1;
manifest.provider = "s3-compatible";
manifest.files ||= {};

const contentTypes = new Map([
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
  [".m4v", "video/x-m4v"]
]);

function saveManifest() {
  manifest.updatedAt = new Date().toISOString();
  const target = path.join(dataDirectory, remoteMediaManifestFilename);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

async function remoteSize(key) {
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return Number(result.ContentLength || 0);
  } catch (error) {
    const status = Number(error?.$metadata?.httpStatusCode || 0);
    if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") return null;
    throw error;
  }
}

let uploaded = 0;
let skipped = 0;
for (let index = 0; index < videos.length; index += 1) {
  const item = videos[index];
  const key = remoteObjectKey(config.prefix, item.filename);
  const label = `[${index + 1}/${videos.length}] ${item.filename}`;
  const existingSize = await remoteSize(key);
  if (existingSize === item.size) {
    skipped += 1;
    console.log(`${label} · 已存在，跳过`);
  } else if (dryRun) {
    console.log(`${label} · 将上传 ${(item.size / 1024 / 1024).toFixed(1)} MB`);
    continue;
  } else {
    const upload = new Upload({
      client,
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: createReadStream(path.join(storage.directory, item.filename)),
        ContentLength: item.size,
        ContentType: contentTypes.get(path.extname(item.filename).toLowerCase()) || "application/octet-stream",
        CacheControl: "public, max-age=3600"
      },
      queueSize: 2,
      partSize: 16 * 1024 * 1024,
      leavePartsOnError: false
    });
    let reported = -1;
    upload.on("httpUploadProgress", (progress) => {
      const percent = Math.floor((Number(progress.loaded || 0) / item.size) * 10) * 10;
      if (percent !== reported && percent < 100) {
        reported = percent;
        console.log(`${label} · ${percent}%`);
      }
    });
    await upload.done();
    uploaded += 1;
    console.log(`${label} · 上传完成`);
  }

  manifest.files[item.filename] = {
    key,
    type: item.type,
    title: item.title,
    size: item.size,
    modifiedAt: item.modifiedAt,
    contentType: contentTypes.get(path.extname(item.filename).toLowerCase()) || "application/octet-stream",
    uploadedAt: new Date().toISOString()
  };
  if (!dryRun) saveManifest();
}

console.log(dryRun
  ? `检查完成：${videos.length} 个视频（演练模式，未上传）`
  : `云端同步完成：上传 ${uploaded} 个，跳过 ${skipped} 个，清单共 ${Object.keys(manifest.files).length} 个`);
