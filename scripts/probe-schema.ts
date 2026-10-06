import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const s = fs.readFileSync("src/lib/db.ts", "utf8");
const m = s.match(/const SCHEMA = `([\s\S]*?)`;/);
if (!m) throw new Error("no SCHEMA literal found");

const d = new DatabaseSync(":memory:");
let n = 0;
for (const st of m[1]!.split(";").map((x) => x.trim()).filter(Boolean)) {
  n++;
  try {
    d.exec(st + ";");
  } catch (e) {
    console.log(`FAIL #${n}: ${st.replace(/\s+/g, " ").slice(0, 100)}`);
    console.log(`   -> ${(e as Error).message}`);
  }
}
console.log(`checked ${n} statements`);