import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createSiteUsers } from "../src/site-users.mjs";

const username = process.argv[2];
if (!username) throw new Error("Usage: node scripts/create-media-user.mjs <username>");
const dataDirectory = path.resolve(process.env.DATA_DIR || "data");
mkdirSync(dataDirectory, { recursive: true });
const users = createSiteUsers({ dataDirectory });
try {
  const password = randomBytes(18).toString("base64url");
  const result = await users.createUser({ username, displayName: username, password, library: "dai" });
  // Display once to the operator; only a salted password hash is persisted.
  console.log(JSON.stringify({ username: result.username, password }));
} finally { users.close(); }
