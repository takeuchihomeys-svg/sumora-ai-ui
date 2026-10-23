// scripts/blueprint-pattern-candidates.ts — 文の設計図の場面の型（writing-blueprint-patterns.ts）ごとに、試験の問題の候補を本番の会話から拾う
//   読むだけ・LLM なし・DB に書かない・spec.json に足さない（正解は竹内さんの実送信＝人が読んで brain-exam-add.ts --add で足す）
//   個人情報: 申込の書類が出た会話の番は捨てる（applicationMaterialReason）・文は maskExamText で伏せる・置き場は .claude/exam-cache（倉庫に上げない）
// 実行: npx tsx --env-file=.env.local scripts/blueprint-pattern-candidates.ts [--days=120] [--per=4]
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectBlueprintPatterns, type BlueprintPatternId, type PatternMsg, PATTERN_DECISION } from "../app/lib/writing-blueprint-patterns";
import { applicationMaterialReason } from "../app/lib/test-pii-guard";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { maskExamText } from "./lib/brain-exam-mask";
import { EXAM_BRAIN_DIR } from "./lib/exam-brain-io";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
type Msg = PatternMsg & { id?: string; conversation_id?: string; created_at: string; staff_writer?: string | null; is_aix_generated?: boolean | null; image_url?: string | null };
const ms = (s: string) => Date.parse(s);
const one = (s: string) => s.replace(/\s+/g, " ").trim();

(async () => {
  const days = Number(arg("days", "120")), per = Number(arg("per", "4"));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let rows: Msg[] = [];
  for (let o = 0; o < 40000; o += 1000) {
    const r = await sb.from("messages").select("id, conversation_id, sender, text, created_at").eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: false }).range(o, o + 999);
    if (r.error) throw new Error(r.error.message);
    rows = rows.concat((r.data ?? []) as Msg[]);
    if ((r.data ?? []).length < 1000) break;
  }
  const spec = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as Array<{ conv: string; at: string }>;
  const got = new Map<BlueprintPatternId, number>();
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let looked = 0;
  for (const m of rows) {
    if (!m.conversation_id || isTestConversation(m.conversation_id) || applicationMaterialReason(m.text)) continue;
    const text = String(m.text ?? "");
    if (text.length < 4 || text.length > 300) continue;
    // 安く先に絞る（会話を読まずに文だけで当たる型）
    const cheap = detectBlueprintPatterns({ scene: resolveReplyScene({ customerText: text }).scene, customerText: text }).map((h) => h.id).filter((id) => id !== "kasa_promise_only");
    if (!cheap.length && !/犬|猫|ペット|駐車|楽器|ピアノ|空いて|初期費用/.test(text)) continue;
    const key = `${m.conversation_id}|${m.created_at.slice(0, 13)}`;
    if (seen.has(key) || spec.some((s) => s.conv === m.conversation_id && Math.abs(ms(s.at) - ms(m.created_at)) < 6 * 3600_000)) continue;
    seen.add(key);
    if (++looked > 1500) break;
    const { data: nx } = await sb.from("messages").select("sender, text, created_at, staff_writer, is_aix_generated, image_url").eq("conversation_id", m.conversation_id).gt("created_at", m.created_at).order("created_at").limit(8);
    const seq = (nx ?? []) as Msg[];
    if (seq[0]?.sender === "customer") continue; // 連投の途中
    let e = 0; while (e < seq.length && seq[e].sender !== "customer" && ms(seq[e].created_at) - ms(m.created_at) < 2 * 3600_000) e++;
    const staff = seq.slice(0, e);
    const w = new Set(staff.map((x) => x.staff_writer).filter(Boolean));
    if (!staff.length || !w.has("takeuchi") || w.has("employee")) continue;
    const { data: bf } = await sb.from("messages").select("sender, text, created_at, is_aix_generated, image_url").eq("conversation_id", m.conversation_id).lte("created_at", m.created_at).order("created_at", { ascending: false }).limit(30);
    const before = ((bf ?? []) as Msg[]).reverse().map((x) => ({ ...x, createdAt: x.created_at, isAix: x.is_aix_generated, imageUrl: x.image_url }));
    if (before.some((x) => applicationMaterialReason(x.text))) continue;
    const sentCount = before.filter((x) => x.sender === "staff" && (x.is_aix_generated || x.image_url)).length;
    const hits = detectBlueprintPatterns({ scene: resolveReplyScene({ customerText: text }).scene, customerText: text, messages: before, propertiesSentCount: sentCount })
      .map((h) => h.id).filter((id) => id !== "kasa_promise_only" && id !== "mirror_notation");
    const pick = hits.find((id) => (got.get(id) ?? 0) < per);
    if (!pick) continue;
    got.set(pick, (got.get(pick) ?? 0) + 1);
    out.push({
      type: pick, decision: PATTERN_DECISION[pick], conv: m.conversation_id, at: m.created_at, alsoHits: hits,
      before: before.slice(-4, -1).map((x) => `${x.sender === "customer" ? "C" : x.is_aix_generated ? "S[AIX]" : "S"}: ${one(maskExamText(x.text ?? "", null)).slice(0, 140)}`),
      customer: one(maskExamText(text, null)),
      gold: one(maskExamText(staff.map((x) => `${x.is_aix_generated ? "【AIX】" : ""}${x.text ?? ""}`).join("\n―\n"), null)).slice(0, 400),
    });
  }
  mkdirSync(join(EXAM_BRAIN_DIR, "question-candidates"), { recursive: true });
  const f = join(EXAM_BRAIN_DIR, "question-candidates", `blueprint-patterns-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`候補 ${out.length}（読んだ番 ${looked}）: ${[...got].map(([k, v]) => `${k} ${v}`).join("・")}\n置き場: ${f}`);
  for (const c of out) console.log(`■ [${c.type}/${c.decision}] ${c.conv} ${c.at}\n   客「${String(c.customer).slice(0, 120)}」\n   竹内さん「${String(c.gold).slice(0, 200)}」`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
