// Refresh the vendored access client from the M2A-Access-Control repo next
// door (the source of truth for the shared members system).
import { copyFileSync } from "node:fs";

copyFileSync("../M2A-Access-Control/src/access-client.js", "src/vendor/access-client.js");
console.log("src/vendor/access-client.js updated from M2A-Access-Control");
