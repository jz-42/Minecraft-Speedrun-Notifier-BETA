// store.js — tiny persistent "already sent" set

const fs = require("fs"); // import node's file system library
const path = require("path");

const PATH = path.join(__dirname, "../../sent_keys.json"); // PATH is where previous alerts (keys) stored

let seen = new Set(); // memory record of sent keys
try {
  seen = new Set(JSON.parse(fs.readFileSync(PATH, "utf8"))); // fs.readFileSync reads PATH into text, JSON.parse turns it into array, then into set w unique values
} catch {
  /* first run; fine */
} // just catches error smoothly first time when set is empty

// Given a key (string) or list of equivalent keys (string[]), return true if none were seen.
// If new, it records ALL provided keys so future checks can match either legacy or new formats.
function markIfNew(keyOrKeys) {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  for (const k of keys) {
    if (seen.has(k)) return false;
  }
  for (const k of keys) {
    seen.add(k);
  }
  fs.writeFileSync(PATH, JSON.stringify([...seen])); // persist
  return true; // tell caller it was new
}
module.exports = { markIfNew };
