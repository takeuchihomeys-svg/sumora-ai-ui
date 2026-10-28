// app/lib/__tests__/line-watch-kn-ids.test.ts — 見張りの行に材料に渡した知見の行 id を控える（E・2026-10-28）
//   実行: npx tsx app/lib/__tests__/line-watch-kn-ids.test.ts
import { summarizeMaterialLog, mergeWatchMaterials } from "../line-watch-materials";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, v?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(v)); } };

const kn = summarizeMaterialLog({ tag: "brain:kn-used", conversationId: "c1", ids: ["21a4735f", "b2e27601-aaaa"] });
t("ナレッジの id → brain.knIds（8文字）", kn?.source === "brain" && kn.key === "knIds" && JSON.stringify((kn.summary as { ids: string[] }).ids) === '["21a4735f","b2e27601"]', kn);
const empty = summarizeMaterialLog({ tag: "brain:kn-used", conversationId: "c1", ids: [] });
t("入らなかった時は空の配列", JSON.stringify((empty?.summary as { ids: string[] }).ids) === "[]", empty);
const kb = summarizeMaterialLog({ tag: "brain:priority-pulled", conversationId: "c1", kb: ["ca55d42b", "4b744a33"], scene: "property_share", sit: {}, chars: 497, ms: 0 });
t("設計知見の id → brain.kb（場面つき）", kb?.key === "kb" && (kb.summary as { ids: string[]; scene: string }).ids.length === 2 && (kb.summary as { scene: string }).scene === "property_share", kb);
const many = summarizeMaterialLog({ tag: "brain:kn-used", ids: Array.from({ length: 30 }, (_, i) => `id${String(i).padStart(6, "0")}`) });
t("12件まで", (many?.summary as { ids: string[] }).ids.length === 12, many);
const merged = mergeWatchMaterials({ brain: { rag: { knowledge: { n: 30 } } } }, [{ ...kn!, at: "2026-10-28T00:00:00Z" }]);
t("前の材料（rag）を残して足す", !!merged.brain.rag && !!merged.brain.knIds, merged);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
