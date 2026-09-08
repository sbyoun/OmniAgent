import assert from "node:assert/strict";
import { sanitizeTag } from "../dist-test/clientTag.mjs";

/**
 * The tag has to be a name tmux accepts and a sidebar can read: first label
 * only, lowercase, `[a-z0-9-]`, short, never empty.
 */
const cases = [
  ["sunbumyoun-MacBookPro-RF7KWG9265", "sunbumyoun"],
  ["sunbumui-MacBookPro.local", "sunbumui"],
  ["DESKTOP-ABC123", "desktop-abc123"],
  ["a100.lab.corp.example.com", "a100"],
  ["My Laptop (2)", "my-laptop-2"],
  ["---", "client"],
  ["", "client"],
  ["über.local", "ber"],
  ["a-very-long-hostname-indeed", "a-very-long"],
  ["abcdefghijklmno-p", "abcdefghijklmno"],
  ["abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnop"],
];

for (const [input, expected] of cases) {
  assert.equal(sanitizeTag(input), expected, `sanitizeTag(${JSON.stringify(input)})`);
  console.log(`  ok  ${JSON.stringify(input)} → ${expected}`);
}
console.log("\nall passed");
