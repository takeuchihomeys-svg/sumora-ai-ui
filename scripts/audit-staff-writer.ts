// scripts/audit-staff-writer.ts — 書き手（竹内さん／従業員）の判定を実データで確かめる（読むだけ・LLM なし・DB は読むだけ）
//   2026-10-08 竹内「竹内のLINEか従業員のLINEかで考える方がかなり分析の質が変わる」「竹内でも鈴木って名乗っている」
//   ①手打ちの送信（AIX・定型文・下書きそのままを除く）5/30〜 に app/lib/staff-writer の判定を付けた分布・確からしさ
//   ②手掛かりの検算（他の手掛かりで決まった通での当たり方＝co-training の形）・時刻・曜日・名乗り（判定に使わない）
//   ③グループの発言（speaker_user_id＝本人が分かる・唯一の正解）での当たり方
//   ④同じ会話・同じ日に両方が出る所・近くの通から埋める（文脈）の当たり方（決まった通を隠して当てる）
//   --out=<jsonl> で 1通1行（id・判定）を書き出す → scripts/backfill-staff-writer.ts が読む
// 実行: npx tsx --env-file=.env.local scripts/audit-staff-writer.ts [--since=2026-05-30] [--out=<path>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { coreOf, dice } from "../app/lib/text-diff-types";
import { cleanDraft } from "../app/lib/line-watch-judge";
import { isMaterialOnlyText } from "../app/lib/daily-greeting";
import { writerFromText, writerFromContext, WRITER_CUES, cannedSkeleton, CANNED_MIN_CONVERSATIONS, inAutoReplyPeriod, type WriterLabel } from "../app/lib/staff-writer";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-05-30");
const OUT = arg("out", "");
const CTX_MIN = Number(arg("ctx-min", "30")); // 文脈で埋める時の前後の幅（分）
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 1_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type M = { id: string; conversation_id: string; created_at: string; text: string | null; is_aix_generated: boolean | null; line_message_id: string | null; speaker_user_id: string | null; speaker_name: string | null };
const isMedia = (t: string) => /^\[(?:画像|動画|スタンプ|ファイル|位置情報|音声)\]/.test(t.trim());
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000);

async function main() {
  const msgs = (await readAll<M>((f, t) => sb.from("messages").select("id, conversation_id, created_at, text, is_aix_generated, line_message_id, speaker_user_id, speaker_name").eq("sender", "staff").gte("created_at", SINCE).order("created_at").order("id").range(f, t)))
    .filter((m) => !isTestConversation(m.conversation_id) && (m.text ?? "").trim() && !isMedia(m.text ?? ""));
  const aix = await readAll<{ conversation_id: string; sent_at: string | null; created_at: string; generated_text: string | null; line_message_id: string | null }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, sent_at, created_at, generated_text, line_message_id").gte("created_at", SINCE).range(f, t));
  const ex = await readAll<{ conversation_id: string | null; sent_reply: string | null; ai_draft: string | null; created_at: string; sent_at: string | null }>((f, t) => sb.from("ai_reply_examples").select("conversation_id, sent_reply, ai_draft, created_at, sent_at").eq("entry_source", "line_reply").gte("created_at", SINCE).range(f, t));
  const tpls = await readAll<{ text: string | null }>((f, t) => sb.from("templates").select("text").range(f, t));
  const settings = await readAll<{ key: string; value: string | null }>((f, t) => sb.from("hanbancyo_settings").select("key, value").in("key", ["staff_line_user_ids", "suzuki_line_user_id"]).range(f, t));
  console.log(`スタッフの文 ${msgs.length}（${SINCE}〜・画像等とテストの会話を除く）`);

  const aixIds = new Set(aix.map((a) => a.line_message_id).filter(Boolean) as string[]);
  const aixBy = new Map<string, typeof aix>(); for (const a of aix) (aixBy.get(a.conversation_id) ?? aixBy.set(a.conversation_id, []).get(a.conversation_id)!).push(a);
  const exBy = new Map<string, typeof ex>(); for (const e of ex) (exBy.get(e.conversation_id ?? "") ?? exBy.set(e.conversation_id ?? "", []).get(e.conversation_id ?? "")!).push(e);
  const tplCores = tpls.map((t) => coreOf((t.text ?? "").replace(/アカウント名|〇〇|◯/g, ""))).filter((c) => c.length > 10);
  const srcOf = (m: M): "group" | "aix" | "asis" | "edited" | "template" | "material" | "hand" => {
    if (m.speaker_user_id) return "group";
    if (isMaterialOnlyText(m.text)) return "material";
    const t = (m.text ?? "").trim(); const ms = Date.parse(m.created_at); const core = coreOf(t);
    if (m.is_aix_generated || (m.line_message_id && aixIds.has(m.line_message_id))) return "aix";
    for (const a of aixBy.get(m.conversation_id) ?? []) { const at = Date.parse(a.sent_at ?? a.created_at); if (Math.abs(at - ms) <= 2 * 3600_000 && a.generated_text && dice(coreOf(a.generated_text), core) >= 0.85) return "aix"; }
    let best: (typeof ex)[number] | null = null; let bd = 0;
    for (const e of exBy.get(m.conversation_id) ?? []) { const at = Date.parse(e.sent_at ?? e.created_at); if (Math.abs(at - ms) > 30 * 60_000) continue; const d = dice(coreOf(e.sent_reply ?? ""), core); if (d > bd) { bd = d; best = e; } }
    if (best && bd >= 0.9) { const dr = cleanDraft(best.ai_draft).text; if (dr && dr.trim() === t) return "asis"; if (dr) return "edited"; }
    if (core.length > 10 && tplCores.some((c) => dice(c, core) >= 0.85)) return "template";
    return "hand";
  };
  // 定型の文（同じ骨が ${CANNED_MIN_CONVERSATIONS} 会話以上）＝昔の AIX・定型文の出力。文の癖では決めない
  const skelConvs = new Map<string, Set<string>>();
  for (const m of msgs) { const k = cannedSkeleton(m.text); if (k.length < 10) continue; (skelConvs.get(k) ?? skelConvs.set(k, new Set()).get(k)!).add(m.conversation_id); }
  const isCanned = (m: M) => { const k = cannedSkeleton(m.text); return k.length >= 10 && (skelConvs.get(k)?.size ?? 0) >= CANNED_MIN_CONVERSATIONS; };
  const rows = msgs.map((m) => { let src: string = srcOf(m); if (src === "hand" && isCanned(m)) src = "canned"; if ((src === "hand" || src === "canned") && inAutoReplyPeriod(m.created_at)) src = "auto"; const w = src === "canned" || src === "auto" ? { writer: null, confidence: "unknown" as const, score: 0, cues: ["定型"] } : writerFromText(m.text ?? ""); const d = jst(m.created_at); return { m, src, w, hour: d.getUTCHours(), dow: d.getUTCDay(), day: d.toISOString().slice(0, 10) }; });

  // ① 出所ごとの分布
  console.log(`\n■ ① 出所ごとの判定（確か／たぶん／不明）`);
  for (const src of ["hand", "edited", "canned", "auto", "asis", "template", "material", "aix", "group"] as const) {
    const l = rows.filter((r) => r.src === src); if (!l.length) continue;
    const c = (w: string | null, cf: string) => l.filter((r) => r.w.writer === w && r.w.confidence === cf).length;
    console.log(`  ${src.padEnd(8)} ${String(l.length).padStart(6)}通  竹内 確か ${pct(c("takeuchi", "sure"), l.length)}・たぶん ${pct(c("takeuchi", "likely"), l.length)}／従業員 確か ${pct(c("employee", "sure"), l.length)}・たぶん ${pct(c("employee", "likely"), l.length)}／不明 ${pct(l.filter((r) => !r.w.writer).length, l.length)}`);
  }
  const human = rows.filter((r) => r.src === "hand" || r.src === "edited");

  // ② 手掛かりの検算: 手掛かり k を外した残りで決まった通で、k が出た時の向きの当たり
  console.log(`\n■ ② 手掛かりの検算（その手掛かりを除いて決まった手打ち・直しの通で、手掛かりが出た通の向き）`);
  for (const cue of WRITER_CUES) {
    let hit = 0, n = 0;
    for (const r of human) {
      const t = r.m.text ?? ""; if (!cue.re.test(t)) continue;
      const w = writerFromText(t, { exclude: [cue.key] }); if (!w.writer || w.confidence === "unknown") continue;
      n++; if (w.writer === cue.writer) hit++;
    }
    console.log(`  ${cue.key.padEnd(12)}（${cue.writer === "takeuchi" ? "竹内" : "従業員"}）出た通 ${human.filter((r) => cue.re.test(r.m.text ?? "")).length}・他で決まった ${n} の中で同じ向き ${pct(hit, n)}`);
  }
  // 時刻・曜日（判定には使っていない）
  const dec = human.filter((r) => r.w.writer && r.w.confidence !== "unknown");
  const band = (h: number) => (h < 9 ? "0〜9時" : h < 10 ? "9〜10時" : h < 21 ? "10〜21時" : "21〜24時");
  console.log(`\n■ ② 時刻・曜日（文の癖で決まった手打ち・直し ${dec.length}通・判定には使わない）`);
  for (const b of ["0〜9時", "9〜10時", "10〜21時", "21〜24時"]) { const l = dec.filter((r) => band(r.hour) === b); console.log(`  ${b.padEnd(8)} ${String(l.length).padStart(5)}通 竹内 ${pct(l.filter((r) => r.w.writer === "takeuchi").length, l.length)}`); }
  for (let d = 0; d < 7; d++) { const l = dec.filter((r) => r.dow === d); console.log(`  ${"日月火水木金土"[d]}曜 ${String(l.length).padStart(5)}通 竹内 ${pct(l.filter((r) => r.w.writer === "takeuchi").length, l.length)}`); }
  // 従業員がいない時間（夜21〜朝10時＝平日 10〜21時の勤務・竹内さんの前提）の通を「竹内さんの正解」とみなした時の外れ（＝従業員と誤る率の上限の目安）
  const off = human.filter((r) => r.hour < 10 || r.hour >= 21);
  for (const cf of ["sure", "likely"] as const) { const l = off.filter((r) => r.w.confidence === cf); console.log(`  夜21〜朝10時の${cf === "sure" ? "確か" : "たぶん"} ${l.length}通で従業員と判定 ${pct(l.filter((r) => r.w.writer === "employee").length, l.length)}`); }
  const months = [...new Set(dec.map((r) => r.day.slice(0, 7)))].sort();
  console.log(`  月: ${months.map((mo) => { const l = dec.filter((r) => r.day.startsWith(mo)); return `${mo.slice(5)}月 竹内 ${pct(l.filter((r) => r.w.writer === "takeuchi").length, l.length)}(${l.length})`; }).join("・")}`);
  // 名乗り（判定に使わない・竹内さんも「鈴木」と名乗る）
  console.log(`\n■ ② 名乗り（判定に使わない）`);
  for (const [name, re] of [["竹内と申します", /竹内と申します/], ["鈴木と申します", /鈴木と申します/], ["担当の鈴木", /担当(?:の|させて頂きます|させていただきます)?鈴木/], ["代表の竹内", /代表の竹内/]] as const) {
    const l = human.filter((r) => re.test(r.m.text ?? "")); const d = l.filter((r) => r.w.writer && r.w.confidence !== "unknown");
    console.log(`  ${name.padEnd(10)} ${l.length}通・決まった ${d.length} の中で竹内 ${pct(d.filter((r) => r.w.writer === "takeuchi").length, d.length)}`);
  }

  // ③ グループの発言（本人が分かる）
  const ids = settings.flatMap((s) => String(s.value ?? "").split(/[\s,]+/)).filter(Boolean);
  const suzuki = settings.find((s) => s.key === "suzuki_line_user_id")?.value ?? "";
  console.log(`\n■ ③ グループの発言（発言者の LINE が分かる・唯一の正解） スタッフの個人 ID ${ids.length}`);
  const grp = rows.filter((r) => r.src === "group");
  for (const who of [...new Set(grp.map((r) => r.m.speaker_name ?? "?"))]) {
    const l = grp.filter((r) => (r.m.speaker_name ?? "?") === who);
    console.log(`  ${who}${l[0]?.m.speaker_user_id === suzuki ? "（suzuki_line_user_id）" : ""}: ${l.length}通 竹内 ${l.filter((r) => r.w.writer === "takeuchi").length}・従業員 ${l.filter((r) => r.w.writer === "employee").length}・不明 ${l.filter((r) => !r.w.writer).length}`);
  }

  // ④ 文脈（同じ会話・同じ日）
  const byConvDay = new Map<string, typeof human>();
  for (const r of human) { const k = `${r.m.conversation_id}|${r.day}`; (byConvDay.get(k) ?? byConvDay.set(k, []).get(k)!).push(r); }
  let both = 0, onlyOne = 0, bothMsgs = 0;
  for (const l of byConvDay.values()) { const ws = new Set(l.filter((r) => r.w.writer && r.w.confidence !== "unknown").map((r) => r.w.writer)); if (ws.size === 2) { both++; bothMsgs += l.length; } else if (ws.size === 1) onlyOne++; }
  console.log(`\n■ ④ 同じ会話・同じ日（手打ち・直し）: 決まった通が1人だけ ${onlyOne}・両方 ${both}（${bothMsgs}通）＝${pct(both, both + onlyOne)}`);
  // 文脈で埋める＋検算（決まった通を1通ずつ隠して近くの通から当てる）
  const labelsByConv = new Map<string, Array<{ at: number; label: WriterLabel }>>();
  for (const r of human) { const k = r.m.conversation_id; (labelsByConv.get(k) ?? labelsByConv.set(k, []).get(k)!).push({ at: Date.parse(r.m.created_at), label: r.w }); }
  let ok = 0, ng = 0, filled = 0, unk = 0;
  for (const [, l] of labelsByConv) {
    for (let i = 0; i < l.length; i++) {
      const me = l[i];
      const ctx = writerFromContext(me.at, l.filter((_, j) => j !== i), CTX_MIN * 60_000);
      if (me.label.confidence === "unknown") { unk++; if (ctx.writer) filled++; continue; }
      if (ctx.writer) { if (ctx.writer === me.label.writer) ok++; else ng++; }
    }
  }
  console.log(`  文脈で当てる（前後 ${CTX_MIN}分・決まった通を隠して当てる）: 当たり ${ok}・外れ ${ng}＝外れ ${pct(ng, ok + ng)}／不明 ${unk}通のうち文脈で埋まる ${filled}（${pct(filled, unk)}）`);

  // 1通ずつの最終の判定（文の癖 → 文脈）
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (r.src === "group") continue; // グループは発言者で決まる（backfill 側で speaker_user_id から）
    if (r.src === "aix" || r.src === "template" || r.src === "asis" || r.src === "material" || r.src === "canned" || r.src === "auto") { out.push({ id: r.m.id, src: r.src, writer: null, source: null, confidence: "unknown" }); continue; }
    let w = r.w; let source = "style";
    if (w.confidence === "unknown") { const c = writerFromContext(Date.parse(r.m.created_at), (labelsByConv.get(r.m.conversation_id) ?? []).filter((x) => x.at !== Date.parse(r.m.created_at)), CTX_MIN * 60_000); if (c.writer) { w = c; source = "style_context"; } }
    out.push({ id: r.m.id, src: r.src, writer: w.writer, source: w.writer ? source : null, confidence: w.confidence, score: r.w.score });
  }
  const fin = out.filter((o) => o.src === "hand" || o.src === "edited");
  console.log(`\n■ 最終（手打ち・直し ${fin.length}通・文の癖＋文脈）: 竹内 確か ${pct(fin.filter((o) => o.writer === "takeuchi" && o.confidence === "sure").length, fin.length)}・たぶん ${pct(fin.filter((o) => o.writer === "takeuchi" && o.confidence === "likely").length, fin.length)}／従業員 確か ${pct(fin.filter((o) => o.writer === "employee" && o.confidence === "sure").length, fin.length)}・たぶん ${pct(fin.filter((o) => o.writer === "employee" && o.confidence === "likely").length, fin.length)}／不明 ${pct(fin.filter((o) => !o.writer).length, fin.length)}`);
  if (OUT) { writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join("\n")); console.log(`書き出し ${OUT}（${out.length}行）`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
