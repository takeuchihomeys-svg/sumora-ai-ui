// app/lib/__tests__/material-gap-weekly.test.ts — 毎週の表の章「材料の足りなさ」「知識の弱さ」（2026-10-29）
//   実行: npx tsx app/lib/__tests__/material-gap-weekly.test.ts
import { tallyMaterialGaps, renderMaterialGapChapter, renderKnowledgeGapChapter, normalizeGapName } from "../material-gap-weekly";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, v?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(v)); } };
const now = Date.parse("2026-10-29T00:00:00Z");
const at = (d: number) => new Date(now - d * 86_400_000).toISOString();
const g = tallyMaterialGaps([
  { created_at: at(1), digest: { mm: ["入居時期", "見積の金額"] } },
  { created_at: at(2), digest: { mm: ["入居時期"], mx: ["sent_props"] } },
  { created_at: at(3), digest: { mm: [] } },
  { created_at: at(3), digest: {} },
  { created_at: at(9), digest: { mm: ["見積の金額"] } },
  { created_at: at(20), digest: { mm: ["古い"] } },
], now);
t("直近7日の判断・申告・挙げた数", g.last7.decisions === 4 && g.last7.reported === 3 && g.last7.nonEmpty === 2, g.last7);
t("名前ごとの回数", g.last7.names.get("入居時期") === 2 && g.last7.names.get("見積の金額") === 1);
t("前の7日", g.prev7.decisions === 1 && g.prev7.names.get("見積の金額") === 1);
t("14日より前は数えない", !g.last7.names.has("古い") && !g.prev7.names.has("古い"));
t("読めなかった材料", g.last7.readMiss === 1 && g.last7.readKeys.get("sent_props") === 1);
const md = renderMaterialGapChapter(g).join("\n");
t("章に見出しと名前と前の数", md.includes("## 材料の足りなさ") && md.includes("入居時期: 2（前 0）") && md.includes("見積の金額: 1（前 1）"), md);
t("新しく出た物", md.includes("新しく出た: 入居時期"), md);
t("読めなかった材料の名前", md.includes("送った物件 1"), md);
t("名前の寄せ", normalizeGapName(" 「入居 時期」 ") === "入居時期", normalizeGapName(" 「入居 時期」 "));
t("知識の章: 出力が無い時", renderKnowledgeGapChapter(null).join("\n").includes("出力が無い"));
const k = renderKnowledgeGapChapter([{ id: 7683, scene: "返信:質問", draft: "確認させて頂きます", staff: "引越し業者の手配も可能です", candidate: "引越し業者の手配は弊社でも可能", verified: false }], 3).join("\n");
t("知識の章: 件数・要確認・候補", k.includes("拾った番 1（前 3）") && k.includes("竹内さんへの確認 1") && k.includes("#7683") && k.includes("（要確認）"), k);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
