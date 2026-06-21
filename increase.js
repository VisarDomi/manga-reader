import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const configPath = resolve(__dirname, "package.json");
const encoding = "utf-8";

const content = readFileSync(configPath, { encoding });
const pkg = JSON.parse(content);

const currentVersion = pkg.version;
const newVersion = (parseInt(currentVersion, 10) + 1).toString();
pkg.version = newVersion;

writeFileSync(configPath, JSON.stringify(pkg, null, 2) + "\n", { encoding });
console.log(`Version incremented: ${currentVersion} -> ${newVersion}`);
