// 再生（yuma-repeat-replay.ts の jsonl）の下書きを竹内さんの実送信の物差し（audit-draft-vs-takeuchi.measure）で版ごとに並べる（回を重ねた下書きも全部数える・読むだけ）
import fs from "node:fs";
import { loadTurns, type Turn } from "./audit-draft-repeat";
import { measure, printAcc } from "./audit-draft-vs-takeuchi";
import { ackReplyShape } from "../app/lib/draft-repeat";
// 使い方: npx tsx --env-file=.env.local scripts/audit-replay-vs-takeuchi.ts <label>=<jsonl>:<prefix> ...   prefix=draft_before|draft_after
(async () => {
  const turns = await loadTurns(60);
  const byId = new Map(turns.map((t) => [t.id, t]));
  for (const spec of process.argv.slice(2)) {
    const [label, rest] = spec.split("=");
    const [file, prefix] = rest.split(":");
    const L = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const pairs: { t: Turn; d: string }[] = [];
    let shapeSame = 0, n = 0;
    for (const r of L) {
      const t = byId.get(String(r.src)); if (!t) continue;
      for (const [k, v] of Object.entries(r)) {
        if (!(k === prefix || k.startsWith(`${prefix}_`)) || typeof v !== "string" || !v) continue;
        if (/^ms_|^skip_|^err_/.test(k)) continue;
        pairs.push({ t, d: v });
        const prev = t.priorStaff[0]?.text ?? "";
        n++; if (ackReplyShape(v, prev) === ackReplyShape(t.sent, prev)) shapeSame++;
      }
    }
    const fake = pairs.map((p, i) => ({ ...p.t, id: `${p.t.id}#${i}`, draft: p.d }));
    printAcc(measure(fake, (t) => t.draft), `${label}（下書き ${pairs.length}）・返事の形が竹内さんと同じ ${shapeSame}/${n}（${(shapeSame / Math.max(1, n) * 100).toFixed(0)}%）`);
  }
})();
