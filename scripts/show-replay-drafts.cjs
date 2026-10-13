// 再生の jsonl の下書きを番ごとに並べて目で読む（版=ファイル:接頭辞）: node scripts/show-replay-drafts.cjs "off=x.jsonl:draft_before" "on=x.jsonl:draft_after"
const fs = require("fs");
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const specs = process.argv.slice(2).map((s) => { const [l, r] = s.split("="); const [f, p] = r.split(":"); return { l, L: rd(f), p }; });
const ids = [...new Set(specs[0].L.map((r) => r.src))];
for (const id of ids) {
  const base = specs[0].L.find((r) => r.src === id); if (!base) continue;
  console.log("── " + id.slice(0, 8) + " 竹: " + String(base.staff || "").replace(/\n+/g, " / ").slice(0, 110));
  for (const s of specs) {
    const r = s.L.find((x) => x.src === id); if (!r) continue;
    const ds = Object.entries(r).filter(([k, v]) => (k === s.p || k.startsWith(s.p + "_")) && typeof v === "string" && !/^(ms|skip|err)_/.test(k)).map(([, v]) => v.replace(/\n+/g, " / ").slice(0, 90));
    for (const d of ds) console.log("   " + s.l.padEnd(5) + " " + d);
  }
}
