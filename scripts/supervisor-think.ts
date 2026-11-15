/**
 * 統括に材料から考えさせる（2026-11-15 竹内さん）
 *
 *   竹内さん「統括がメインなのでその考えは絶対事項／統括がブレインとしてまとめるようにする」
 *     「日々進化していくように統括のがブレインとなって強化していく」
 *     「統括の部分もしAPIつかっているのなら deepseekv4pro の方が思考的に良い可能性ある」
 *
 * 何をするか:
 *   ① 本番の束（`/api/human-learn-profile`）から**材料**を取る
 *   ② DeepSeek V4 Pro に「次に何を直すか」を**1つだけ**選ばせる
 *   ③ 決定論の判断（今までの統括）と**並べて出す**（どちらが良いか目で比べる）
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/supervisor-think.ts
 *   npx tsx --env-file=.env.local scripts/supervisor-think.ts --model=deepseek-flash
 *   npx tsx --env-file=.env.local scripts/supervisor-think.ts --scope=realpro
 *
 * ⚠ 読むだけ（DBを変えない）。
 * ⚠ 費用: 1回 約$0.001〜0.01（材料の量による）。
 */
import { thinkAsSupervisor, supervisorMaterialText } from "../app/lib/learn-supervisor-llm";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const scope = argOf("scope", "realpro");
const model = argOf("model", "");
const base = process.env.NEXT_PUBLIC_SITE_URL || "https://sumora-ai-ui.vercel.app";

type Bundle = {
  rows?: number; with_ops?: number; next_n?: number; points_n?: number;
  weak?: Array<{ kind?: string; name?: string; why?: string }>;
  scene_flows?: Array<{ scene?: string; runs?: number; ops?: number; steps?: string[]; variants?: number }>;
  stopped_scene?: string | null;
  improvements?: { total?: number; recent?: Array<{ area?: string; title?: string }> } | null;
  human_ops?: number; auto_ops?: number; same_runs?: number;
  supervisor?: { lines?: string[] };
};

void (async () => {
  console.log(`統括に考えさせる（scope=${scope}${model ? " model=" + model : ""}）`);
  console.log("─".repeat(70));

  // ① 材料を取る
  const res = await fetch(`${base}/api/human-learn-profile?scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
  if (!res.ok) {
    console.log("材料を取れません（HTTP " + res.status + "）");
    process.exitCode = 1;
    return;
  }
  const j = (await res.json()) as { bundle?: Bundle };
  const b = j.bundle ?? {};
  const material = supervisorMaterialText(b);
  console.log("材料（" + material.length + "字）:");
  for (const line of material.split("\n").slice(0, 14)) console.log("  " + line);
  if (material.split("\n").length > 14) console.log("  …（以下略）");

  // ② いままでの統括（決定論）の判断
  console.log("\n=== いままでの統括（決定論・私が書いたルール）");
  const lines = b.supervisor?.lines ?? [];
  for (const l of lines.slice(0, 14)) console.log("  " + l);

  // ③ LLM に考えさせる
  console.log("\n=== LLM（" + (model || "deepseek-v4-pro") + "）が材料から選んだ判断");
  const t = await thinkAsSupervisor(material, { model: model || undefined });
  if (!t) {
    console.log("  ⚠ 考えられませんでした（鍵が無い・時間切れ・答えの形が違う）→ 決定論の判断をそのまま使います");
    return;
  }
  console.log("  次に直す: " + t.next);
  console.log("  なぜ:     " + t.why);
  console.log("  どう直す: " + t.how);
  console.log(`  （${t.model}・${t.ms}ms・入力${t.usage?.input ?? "?"} 出力${t.usage?.output ?? "?"}トークン）`);
})();
