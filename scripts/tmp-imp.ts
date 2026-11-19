import { improvementSummary } from "../app/lib/learn-improvements";
void (async () => {
  for (const d of [1, 3, 30]) {
    const s = await improvementSummary(d);
    console.log(`${d}日以内: total=${s.total} ${s.error ? "ERR " + s.error : ""}`);
    if (s.total) for (const a of s.byArea) console.log("   " + a.area + " → " + a.n + "件");
  }
})();
