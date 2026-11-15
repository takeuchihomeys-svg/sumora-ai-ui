// scripts/tsunagi-prod.ts — 本番の竹内さんの番のつなぎの外れを分ける（読むだけ・LLM なし・費用 0）
//   2026-11-15 作業員H（統括役の頼み 2・4）。型と外れの分けは scripts/lib/tsunagi.ts（テスト付き）。
//   見張りの番（line_watch_turns）のうち、最初のスタッフの通が竹内さん本人（messages.staff_writer=takeuchi・AIX でない）の番だけ、
//   竹内さんの実送信（staff_texts・番の全部）× 下書き（draft_last）を比べ、外れを「入れていない／種類／強さ／位置／入れない所に入れた」に分け、
//   根を仮に振り分ける（材料が届いていない／場面の読み違い／AIX の番の取り違え）。根は決まった計算の仮＝例を目で読んで直す。
//   JST 9〜22時は --days=7 まで（それより長いのは夜に）。使い方: npx tsx --env-file=<.env.local> scripts/tsunagi-prod.ts [--days=7] [--show=20]
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { tsunagiMiss, TSUNAGI_MISS_JA, TSUNAGI_JA, type TsunagiMiss } from "./lib/tsunagi";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const days = Number(arg("days") ?? "7"), show = Number(arg("show") ?? "0");
const jstHour = (new Date().getUTCHours() + 9) % 24;
if (days > 7 && jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.error("営業時間は --days=7 まで（DB の重い読みは22時以降）"); process.exit(1); }

type W = { id: number; conversation_id: string; customer_turn_at: string; scene_key: string | null; brain_action: string | null; draft_last: string | null; staff_texts: Array<{ at?: string; text?: string }> | null; staff_aix: Array<{ aix_type?: string }> | null };
const AIX_CARRIES = /viewing|meeting|estimate|application|recommend|property_send/;
/** 根の仮の振り分け */
export function rootOf(miss: TsunagiMiss, w: Pick<W, "brain_action" | "staff_aix">, draftKind: string): "材料が届いていない" | "場面の読み違い" | "AIX の番の取り違え" | null {
  if (miss === "ok" || miss === "both_none") return null;
  const staffAix = (w.staff_aix ?? []).map((a) => String(a.aix_type ?? "")).filter(Boolean);
  const brainAix = !!w.brain_action && w.brain_action !== "reply" && w.brain_action !== "none";
  // 竹内さんは AIX で次の一手を持たせた／ブレインは AIX と言ったのに文で誘った・誘わない＝返信か AIX かの分け
  if (staffAix.some((a) => AIX_CARRIES.test(a)) !== (brainAix && AIX_CARRIES.test(String(w.brain_action)))) return "AIX の番の取り違え";
  // 下書きが探す約束・次の連絡の約束に寄った（送った資料・答えの材料から誘えなかった）
  if ((miss === "missing" || miss === "kind") && draftKind === "next_contact") return "材料が届いていない";
  return "場面の読み違い";
}

async function read(sb: SupabaseClient): Promise<W[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const out: W[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, scene_key, brain_action, draft_last, staff_texts, staff_aix")
      .gte("customer_turn_at", since).not("draft_last", "is", null).order("customer_turn_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as W[]));
    if ((data ?? []).length < 1000) break;
  }
  return out.filter((w) => !isTestConversation(w.conversation_id) && (w.staff_texts ?? []).some((s) => s.text));
}
async function writerOf(sb: SupabaseClient, w: W): Promise<string | null> {
  const first = (w.staff_texts ?? []).find((s) => s.at);
  if (!first?.at) return null;
  const t = Date.parse(first.at);
  const { data } = await sb.from("messages").select("staff_writer, is_aix_generated").eq("conversation_id", w.conversation_id).neq("sender", "customer")
    .gte("created_at", new Date(t - 2000).toISOString()).lte("created_at", new Date(t + 2000).toISOString()).limit(1);
  const m = ((data ?? []) as Array<{ staff_writer: string | null; is_aix_generated: boolean }>)[0];
  return m && !m.is_aix_generated ? m.staff_writer : null;
}

if (process.argv[1] && /tsunagi-prod\.ts$/.test(process.argv[1])) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await read(sb);
  const missN = new Map<TsunagiMiss, number>(), rootN = new Map<string, number>(), oldEl = { has: 0, hit: 0 };
  const ex: string[] = [];
  let n = 0;
  for (const w of ws) {
    if ((await writerOf(sb, w)) !== "takeuchi") continue;
    n++;
    const texts = (w.staff_texts ?? []).map((s) => String(s.text ?? "")).filter(Boolean);
    const r = tsunagiMiss(texts, String(w.draft_last ?? ""));
    missN.set(r.miss, (missN.get(r.miss) ?? 0) + 1);
    if (r.t.kind === "viewing" || r.t.kind === "apply") { oldEl.has++; if (r.d.kind === r.t.kind) oldEl.hit++; }
    const root = rootOf(r.miss, w, r.d.kind);
    if (root) rootN.set(`${TSUNAGI_MISS_JA[r.miss]}｜${root}`, (rootN.get(`${TSUNAGI_MISS_JA[r.miss]}｜${root}`) ?? 0) + 1);
    if (root && ex.length < show) ex.push(`#${w.id} ${w.scene_key ?? "?"} 外れ=${TSUNAGI_MISS_JA[r.miss]} 根(仮)=${root} 竹内=${TSUNAGI_JA[r.t.kind]}${r.t.msg ? `(${r.t.msg}通目・${r.t.strength})` : ""} 下書き=${TSUNAGI_JA[r.d.kind]}${r.d.strength ? `(${r.d.strength})` : ""} ブレイン=${w.brain_action ?? "-"} 竹内のAIX=${(w.staff_aix ?? []).map((a) => a.aix_type).join(",") || "-"}`);
  }
  console.log(`竹内さん本人の番 ${n}（${days}日）・今の物差し（内覧・申込の誘いだけ）で比べられる番 ${oldEl.has}（当たり ${oldEl.hit}）→ 新しい型で比べられる番 ${n - (missN.get("both_none") ?? 0)}`);
  for (const [k, v] of [...missN.entries()].sort((a, b) => b[1] - a[1])) console.log(`${TSUNAGI_MISS_JA[k]}\t${v}`);
  console.log("\n外れ｜根（仮）"); for (const [k, v] of [...rootN.entries()].sort((a, b) => b[1] - a[1])) console.log(`${k}\t${v}`);
  if (ex.length) { console.log("\n例"); for (const e of ex) console.log(e); }
})();
