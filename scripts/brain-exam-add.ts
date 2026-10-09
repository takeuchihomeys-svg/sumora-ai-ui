// scripts/brain-exam-add.ts — ブレインの試験の問題を作る・足す（読むだけ・LLM を呼ばない・本番の DB に書かない）
//
// 2026-10-08 竹内さん①「読み違えた実例を正解つきの試験問題にして、ブレインを直すたびに全部解かせ、前より悪くならないか確かめる」
//   正解（spec.json）は人が決める。竹内さんが実際に取った行動（返信／約束／AIX の種類×ピッカー）と返信の要点（何に答えた・何を約束した・何を言わなかった）。
//   正解が決まらない番は入れない（推測しない）。申込以降・社内・YUMA は入れない。会話は申込の書類の手前で切り、名前・番号を伏せる。
//
// 置き場所: scripts/brain-exam/spec.json（正解・人が書く）／scripts/brain-exam/problems.json（会話の写し・伏せた物・このスクリプトが作る）
//
// 使い方:
//   ① 全部を作り直す（spec.json → problems.json）
//      npx tsx --env-file=.env.local scripts/brain-exam-add.ts --rebuild
//   ② 本番の見張りで見つけた新しい読み違いの候補を並べる（竹内さんの番で、ブレインの判断と竹内さんの行動が違った番・足すコマンドの雛形つき）
//      npx tsx --env-file=.env.local scripts/brain-exam-add.ts --suggest [--days=14] [--limit=30]
//   ②' 10/09: 竹内さんの番でブレインと違った AIX の番（手打ちでもスタッフだけが知る中身の番）の候補
//      npx tsx --env-file=.env.local scripts/brain-exam-add.ts --suggest-sends [--days=45] [--limit=120] [--out=<json>]
//      試験に足りない場面（画像・内覧の後・閉じる・不安）の候補: --suggest-scenes [--days=45] [--per=15]
//      正解を書いた配列をまとめて足す: --add-batch=<json>（ExamSpec の配列・id なし）
//   ③ 1問足す（正解は自分で決めて書く。決まらない番は足さない）
//      npx tsx --env-file=.env.local scripts/brain-exam-add.ts --add --conv=<会話id> --at=<お客様の最後の通の ISO> --type=出し切り \
//        --accept=返信,AIX:zenryoku_support --must-not=2段:pickup,AIX:物件 --ask="もう少し探して|reply|新着を随時確認し出次第お送りする" \
//        [--ask=…] [--ng="…"] [--tags=謝罪] --why="竹内さんがそうした理由（会話から言える事だけ）"
//   accept / must-not の符号は scripts/lib/brain-exam-score.ts の先頭（返信・2段:<種類>・なし・AIX:<action>[/<ピッカー>]・AIX:物件）。
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { cutBeforeApplicationMaterial, applicationMaterialReason } from "../app/lib/test-pii-guard";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { subSceneOf } from "../app/lib/reply-subscene";
import { APPLY_FORM_RE } from "../app/lib/customer-sim-shadow";
import { STAFF_FAIL_RE } from "../app/lib/post-apply-brain-gate";
import { addressNamesOf, maskExamText } from "./lib/brain-exam-mask";
import { rollbackPcToTurn, type PcAsOf, type PcHist } from "./lib/brain-exam-pc";

export const EXAM_DIR = "scripts/brain-exam";
export const SPEC_FILE = `${EXAM_DIR}/spec.json`;
export const PROBLEMS_FILE = `${EXAM_DIR}/problems.json`;

export type ExamAsk = { q: string; route: "reply" | "promise" | "aix" | "none"; point: string; /** 10/09: 他にも正解の答え方（例 q038 物件オススメの AIX が第一・探す約束も可） */ routes?: Array<"reply" | "promise" | "aix" | "none"> };
export type ExamSpec = {
  id: string; type: string; tags?: string[]; source: string; conv: string; at: string;
  accept: string[]; mustNot?: string[]; asks?: ExamAsk[]; ng?: string[]; why: string; addedAt?: string; addedBy?: string;
  /** 決まりが入ったら正解が変わる番（10/08: 出し切り＝search-exhausted が入ったら全力サポートだけ。brain-exam.ts の acceptOf） */
  acceptWhen?: { searchExhausted?: string[]; /** 10/09: 全力サポートが正解の時の依頼（答え方は aix＝AIX の文で応える） */ searchExhaustedAsks?: ExamAsk[]; note?: string };
  /** 10/09: 日付をずらさない（月の家賃の計算など、ずらすと月の言い方と食い違う問題） */
  noDateShift?: boolean;
  /** 2026-10-09 主語の抜け: 今の番の物件の正解（竹内さんの返事が指した建物）。ブレインの current_property と照らす（brain-exam-score.judgeCurrentProperty） */
  property?: string;
};
export type ExamMsg = { s: "customer" | "staff"; t: string; aix: boolean; ago: number };
export type ExamProblem = ExamSpec & {
  sub: string; hourJst: number; customer: string; context: ExamMsg[]; pc: Record<string, unknown> | null;
  staffText: string; prodBrain: { action: string | null; mode: string | null; cp: string | null; src: string | null; dir: string } | null;
  builtAt: string;
  /** その番の時点の台帳の行（10/09: 本番のブレインが読む送付・見積・内覧・ピックアップ・AIX の記録。brain-exam.ts が YUMA に写す） */
  ledger?: Record<string, LedgerRow[]>;
  /** 10/09: 条件の行をその番の時点に巻き戻した中身（brain-exam-pc.rollbackPcToTurn） */
  pcAsOf?: PcAsOf | null;
};
export type LedgerRow = { ago: number; row: Record<string, unknown> };

/** YUMA の条件の行に写す列（yuma-r10-brain-replay と同じ・要約と人物像は空にする） */
export const PC_FIELDS = ["desired_area", "floor_plan", "rent_min", "rent_max", "move_in_time", "preferences", "ng_points", "walk_minutes", "pet", "floor_area_min", "floor_area_max", "commute_station", "commute_minutes", "area_mode", "initial_cost_limit", "building_age", "other_requests", "occupants", "property_send_count", "last_property_sent_at", "ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"] as const;
/**
 * 10/09 試験の穴①: REPLAY_FLOOR は YUMA の過去の記録を隠すので、messages だけ写すと本番のブレインが読む台帳（送付件数・見積送付済・内覧・
 *   ピックアップの準備・全力サポートの送付・未履行の宣言）が空になる。その番の時点（at 以前）の行を写しておき、試験の時に YUMA へ入れる。
 *   time＝線（floor）で見られる列・times＝写す時に場面の時刻へずらす列（at より後の値は null＝その時点では未来）・drop＝写さない列（大きい・外部キー）
 *   ⚠ 写さない: scheduled_messages（実際に送られる）・line_tasks／calendar_events（通知・画面に出る）・completions（グループへ告知）
 */
export const LEDGER_TABLES: Record<string, { time: string; times: string[]; dates?: string[]; limit: number; drop: string[]; byPc?: boolean }> = {
  aix_usage_logs: { time: "created_at", times: ["created_at", "sent_at"], limit: 40, drop: ["property_example_backfilled_at", "adapt_example_backfilled_at"] },
  sent_properties: { time: "sent_at", times: ["sent_at", "recruitment_checked_at"], limit: 40, drop: ["pickup_id"], byPc: true },
  property_pickups: { time: "created_at", times: ["created_at", "sent_at", "seen_at", "expired_at"], limit: 40, drop: ["pdf_text", "pdf_url", "pdf_blob_url", "page_image_url", "agent_image_url", "trim_image_url", "image_lines", "image_analysis", "complete_group_id"], byPc: true },
  estimate_records: { time: "created_at", times: ["created_at", "estimated_at"], limit: 30, drop: [], byPc: true },
  viewings: { time: "created_at", times: ["created_at"], dates: ["viewing_date"], limit: 10, drop: [] },
  viewing_history: { time: "created_at", times: ["created_at", "updated_at"], dates: ["scheduled_date", "actual_date"], limit: 10, drop: ["viewing_report", "viewing_report_at"] },
  sent_facts: { time: "created_at", times: ["created_at", "sent_at"], limit: 40, drop: [] },
};
function maskDeep(v: unknown, mask: (s: string) => string): unknown {
  if (typeof v === "string") { const m = mask(v); return m.length > 3000 ? m.slice(0, 3000) : m; }
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, mask));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskDeep(x, mask)]));
  return v;
}
async function ledgerSnapshot(conv: string, pcId: string | null, at: string, mask: (s: string) => string): Promise<Record<string, LedgerRow[]>> {
  const out: Record<string, LedgerRow[]> = {};
  for (const [t, c] of Object.entries(LEDGER_TABLES)) {
    let q = sb.from(t).select("*").lte(c.time, at).order(c.time, { ascending: false }).limit(c.limit);
    q = c.byPc && pcId ? q.or(`conversation_id.eq.${conv},property_customer_id.eq.${pcId}`) : q.eq("conversation_id", conv);
    const { data, error } = await q;
    if (error) { console.warn(`  台帳 ${t}: ${error.message}`); continue; }
    out[t] = ((data ?? []) as Array<Record<string, unknown>>).reverse().filter((r) => !applicationMaterialReason(JSON.stringify(r))).map((r) => {
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (c.drop.includes(k)) continue;
        if (c.times.includes(k) && k !== c.time && typeof v === "string" && ms(v) > ms(at)) { row[k] = null; continue; } // その時点では未来
        row[k] = k === "customer_name" ? "YUMA" : maskDeep(v, mask);
      }
      return { ago: Math.round((ms(at) - ms(String(r[c.time]))) / 60_000), row };
    });
  }
  return out;
}

const PC_BLANK = new Set(["ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"]);

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ?? "");
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const argAll = (k: string) => args.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3));
const flag = (k: string) => args.includes(`--${k}`);
const ms = (s: string) => Date.parse(s);
const jstHour = (iso: string) => new Date(ms(iso) + 9 * 3600_000).getUTCHours();
const oneLine = (s: string) => String(s ?? "").replace(/\n/g, "⏎");

type Msg = { id: number | string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer?: string | null };

/** 1問の会話を作る。作れない時は理由（文字列）を返す */
export async function buildProblem(spec: ExamSpec): Promise<ExamProblem | string> {
  if (isTestConversation(spec.conv)) return "テスト・社内の会話";
  const { data: conv } = await sb.from("conversations").select("customer_name, property_customer_id").eq("id", spec.conv).maybeSingle();
  const { data } = await sb.from("messages").select("id, sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", spec.conv).lte("created_at", spec.at).order("created_at", { ascending: false }).limit(60);
  const msgs = ((data ?? []) as Msg[]).reverse();
  let end = msgs.length - 1; while (end >= 0 && msgs[end].sender !== "customer") end--;
  if (end < 0) return "お客様の通が無い";
  let start = end; while (start - 1 >= 0 && msgs[start - 1].sender === "customer") start--;
  let ctx = msgs.slice(Math.max(0, start - 29), start);
  const cust = msgs.slice(start, end + 1);
  const cut = cutBeforeApplicationMaterial([...ctx, ...cust]);
  if (cut.cutAt !== null) {
    // 審査落ちで切り替えた後の番（対象）だけは、切り替え（否決の連絡）より後の通だけで場面を作る（test_protocol 6・設計知見 cd3f3974 の追記）
    const all = [...ctx, ...cust];
    let lastPii = -1; all.forEach((m, i) => { if (cutBeforeApplicationMaterial([m]).cutAt !== null) lastPii = i; });
    const failIdx = all.findIndex((m, i) => i > lastPii && m.sender !== "customer" && STAFF_FAIL_RE.test(m.text ?? ""));
    if (failIdx < 0 || failIdx >= ctx.length || lastPii >= ctx.length) return `申込の書類・個人の値（${cut.reason}）が場面に入っている`;
    ctx = ctx.slice(failIdx);
  }
  // 申込以降（申込へ（push 以外）を押した・申込フォームを送った後。否決の後は戻す）
  const { data: presses } = await sb.from("aix_usage_logs").select("aix_type, app_sub_mode, created_at").eq("conversation_id", spec.conv).lte("created_at", spec.at);
  const postStarts = [
    ...((presses ?? []) as Array<{ aix_type: string | null; app_sub_mode: string | null; created_at: string }>).filter((p) => p.aix_type === "application_push" && (p.app_sub_mode ?? "") !== "push").map((p) => ms(p.created_at)),
    ...msgs.filter((m) => m.sender !== "customer" && APPLY_FORM_RE.test(m.text ?? "")).map((m) => ms(m.created_at)),
  ].sort((a, b) => a - b);
  if (postStarts.length) {
    const last = postStarts[postStarts.length - 1];
    if (!msgs.some((m) => STAFF_FAIL_RE.test(m.text ?? "") && ms(m.created_at) > last)) return "申込以降の番";
  }
  const name = (conv?.customer_name as string | null) ?? null;
  // こちらの文の呼び名は番の後の竹内さんの文も含めて集める（正解の文の伏せにも使う）
  const { data: after } = await sb.from("messages").select("id, sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", spec.conv).gt("created_at", spec.at).order("created_at").limit(12);
  const afterMsgs = (after ?? []) as Msg[];
  const names = addressNamesOf([...msgs, ...afterMsgs].filter((m) => m.sender !== "customer").map((m) => m.text ?? ""));
  const mask = (s: string | null) => maskExamText(s, name, names);
  const at = ms(spec.at);
  const context: ExamMsg[] = [...ctx, ...cust].map((m) => ({ s: m.sender === "customer" ? "customer" : "staff", t: mask(m.text) || "[画像]", aix: !!m.is_aix_generated, ago: Math.round((at - ms(m.created_at)) / 60_000) }));
  // 竹内さんの実送信（次のお客様の通まで・最初の通から30分）
  const nextCust = afterMsgs.find((m) => m.sender === "customer");
  const staffAfter = afterMsgs.filter((m) => m.sender !== "customer" && (!nextCust || ms(m.created_at) < ms(nextCust.created_at)));
  const s0 = staffAfter[0] ? ms(staffAfter[0].created_at) : 0;
  const staffText = staffAfter.filter((m) => ms(m.created_at) - s0 <= 30 * 60_000).map((m) => `${m.is_aix_generated ? "【AIX】" : ""}${mask(m.text)}`).join("\n―\n");
  // 本番のブレイン（竹内さんが見た判断）
  const { data: bl } = await sb.from("brain_decision_logs").select("created_at, suggested_action, suggested_reply_mode, suggested_check_pattern, decision_source, digest")
    .eq("conversation_id", spec.conv).gte("created_at", new Date(ms(cust[0].created_at) - 60_000).toISOString()).lte("created_at", new Date(s0 || at + 3600_000).toISOString()).order("created_at", { ascending: false }).limit(1);
  const b = (bl ?? [])[0] as { suggested_action: string | null; suggested_reply_mode: string | null; suggested_check_pattern: string | null; decision_source: string | null; digest: Record<string, unknown> | null } | undefined;
  // 条件の行（伏せる）。10/09: 今の値でなく、その番の時点に巻き戻す（rollbackPcToTurn・未来の値を見せない）
  let pc: Record<string, unknown> | null = null;
  let pcAsOf: PcAsOf | null = null;
  const pcId = (conv?.property_customer_id as string | null) ?? null;
  const ledger = await ledgerSnapshot(spec.conv, pcId, spec.at, (x) => mask(x));
  if (pcId) {
    const { data: row } = await sb.from("property_customers").select([...PC_FIELDS, "created_at"].join(", ")).eq("id", pcId).maybeSingle();
    if (row) {
      const { data: hist } = await sb.from("property_condition_history").select("changed_field, old_value, created_at").eq("property_customer_id", pcId).gt("created_at", spec.at).order("created_at", { ascending: true });
      const custTimes = [...ctx, ...cust].filter((m) => m.sender === "customer").map((m) => m.created_at);
      const r = rollbackPcToTurn(row as unknown as Record<string, unknown>, (hist ?? []) as PcHist[], spec.at, ledger, custTimes.length > cust.length ? custTimes[custTimes.length - cust.length - 1] : null);
      pcAsOf = r.asOf;
      if (r.pc) pc = Object.fromEntries(PC_FIELDS.map((k) => { const v = r.pc![k]; return [k, PC_BLANK.has(k) ? null : typeof v === "string" ? mask(v) : v ?? null]; }));
    }
  }
  const custText = cust.map((m) => m.text ?? "").join("\n");
  const prevStaff = [...ctx].reverse().find((m) => m.sender !== "customer");
  const scene = resolveReplyScene({ customerText: custText }).scene;
  return {
    ...spec,
    sub: subSceneOf({ customerText: custText, prevStaffText: prevStaff?.text ?? null, scene }),
    hourJst: jstHour(spec.at),
    customer: mask(custText).slice(0, 600),
    context, pc, staffText,
    prodBrain: b ? { action: b.suggested_action, mode: b.suggested_reply_mode, cp: b.suggested_check_pattern, src: b.decision_source, dir: String(b.digest?.dir ?? "").slice(0, 160) } : null,
    builtAt: new Date().toISOString(),
    ledger,
    pcAsOf,
  };
}

export function readSpec(): ExamSpec[] { return existsSync(SPEC_FILE) ? JSON.parse(readFileSync(SPEC_FILE, "utf8")) as ExamSpec[] : []; }
export function readProblems(): ExamProblem[] { return existsSync(PROBLEMS_FILE) ? JSON.parse(readFileSync(PROBLEMS_FILE, "utf8")) as ExamProblem[] : []; }

async function rebuild(only: string[] = []) {
  const spec = readSpec();
  const prev = new Map(readProblems().map((p) => [p.id, p]));
  const out: ExamProblem[] = [];
  const skipped: string[] = [];
  for (const s of spec) {
    if (only.length && !only.includes(s.id)) { const p = prev.get(s.id); if (p) out.push(p); continue; }
    const r = await buildProblem(s);
    if (typeof r === "string") { skipped.push(`${s.id}（${s.type}）: ${r}`); continue; }
    out.push(r);
    console.log(`${r.id} [${r.type}] ${r.sub} 客「${oneLine(r.customer).slice(0, 60)}」 正解=${r.accept.join("|")}`);
  }
  writeFileSync(PROBLEMS_FILE, JSON.stringify(out, null, 1));
  console.log(`\n問題 ${out.length} 問（spec ${spec.length}）→ ${PROBLEMS_FILE}`);
  if (skipped.length) console.log(`作れなかった ${skipped.length}:\n  ${skipped.join("\n  ")}`);
  const c = new Map<string, number>(); for (const p of out) c.set(p.type, (c.get(p.type) ?? 0) + 1);
  console.log(`型ごと: ${[...c].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
}

async function add() {
  const conv = arg("conv"), at = arg("at"), type = arg("type"), why = arg("why");
  const accept = arg("accept").split(",").map((x) => x.trim()).filter(Boolean);
  if (!conv || !at || !type || !accept.length || !why) throw new Error("--conv --at --type --accept --why は必須（正解が決まらない番は足さない）");
  const asks: ExamAsk[] = argAll("ask").map((a) => { const [q, route, point] = a.split("|"); if (!/^(reply|promise|aix|none)$/.test(route ?? "")) throw new Error(`--ask の答え方は reply|promise|aix|none: ${a}`); return { q, route: route as ExamAsk["route"], point: point ?? "" }; });
  const spec = readSpec();
  if (spec.some((s) => s.conv === conv && Math.abs(ms(s.at) - ms(at)) < 60_000)) throw new Error("同じ番はもう入っています");
  const n = spec.reduce((m, s) => Math.max(m, Number(s.id.slice(1)) || 0), 0) + 1;
  const s: ExamSpec = {
    id: `q${String(n).padStart(3, "0")}`, type, tags: arg("tags").split(",").filter(Boolean), source: arg("source", "本番の見張り（brain-exam-add --add）"),
    conv, at, accept, mustNot: arg("must-not").split(",").map((x) => x.trim()).filter(Boolean), asks, ng: argAll("ng"), why,
    addedAt: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10), addedBy: arg("by", "brain-exam-add"),
    ...(arg("property") ? { property: arg("property") } : {}),
  };
  const built = await buildProblem(s);
  if (typeof built === "string") throw new Error(`この番は問題にできません: ${built}`);
  writeFileSync(SPEC_FILE, JSON.stringify([...spec, s], null, 1));
  writeFileSync(PROBLEMS_FILE, JSON.stringify([...readProblems(), built], null, 1));
  console.log(`足した: ${s.id} [${type}] ${built.sub}\n  客「${oneLine(built.customer).slice(0, 120)}」\n  竹内さん「${oneLine(built.staffText).slice(0, 160)}」\n  当時のブレイン: ${JSON.stringify(built.prodBrain)}`);
}

/** 本番の見張りから候補を並べる（竹内さんの番・ブレインの判断の道と竹内さんの道が違う番）。正解は人が読んで決める */
async function suggest() {
  const days = Number(arg("days", "14")), limit = Number(arg("limit", "30"));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, verdict, verdict_detail, brain_action, brain_reply_mode, scene_key, draft_last")
    .gte("customer_turn_at", since).order("customer_turn_at", { ascending: false }).limit(2000);
  if (error) throw new Error(error.message);
  const have = readSpec();
  type W = { conversation_id: string; customer_turn_at: string; verdict: string | null; verdict_detail: Record<string, unknown> | null; brain_action: string | null; brain_reply_mode: string | null; scene_key: string | null; draft_last: string | null };
  const rows = ((data ?? []) as W[]).filter((w) => {
    const d = w.verdict_detail ?? {};
    if (d.staff_writer !== "takeuchi") return false;
    if (have.some((s) => s.conv === w.conversation_id && Math.abs(ms(s.at) - ms(w.customer_turn_at)) < 6 * 3600_000)) return false;
    // 道が違う（AIX の番を返信にした／返信の番を AIX にした）か、返信の中身が違う（different・acts の食い違い）
    return w.verdict === "different" || (d.path === "AIX" && w.brain_reply_mode !== "aix") || (d.path === "返信" && w.brain_reply_mode === "aix") || (Array.isArray(d.missing_acts) && (d.missing_acts as unknown[]).length > 0);
  }).slice(0, limit);
  console.log(`候補 ${rows.length}（${days}日・竹内さんの番・まだ入っていない番）。読んで正解が決まる番だけ --add で足す\n`);
  for (const w of rows) {
    const { data: nx } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", w.conversation_id).gte("created_at", w.customer_turn_at).order("created_at").limit(10);
    const seq = (nx ?? []) as Msg[];
    let k = 0; while (k < seq.length && seq[k].sender === "customer") k++;
    const cust = seq.slice(0, k);
    let e = k; while (e < seq.length && seq[e].sender !== "customer" && e - k < 3) e++;
    const staff = seq[k] ? { ...seq[k], text: seq.slice(k, e).map((x) => x.text ?? "").join("⏎―⏎") } : undefined;
    const d = w.verdict_detail ?? {};
    console.log(`■ ${w.conversation_id} ${w.customer_turn_at.slice(0, 16)} ${w.scene_key ?? ""} verdict=${w.verdict} 道=${d.path ?? "-"} ブレイン=${w.brain_reply_mode === "aix" ? `AIX:${w.brain_action}` : "返信"} 抜け=${JSON.stringify(d.missing_acts ?? [])}`);
    console.log(`  客「${oneLine(maskExamText(cust.map((x) => x.text ?? "").join("\n"), null)).slice(0, 160)}」`);
    console.log(`  竹内さん「${oneLine(maskExamText(staff?.text ?? "", null)).slice(0, 160)}」`);
    console.log(`  下書き「${oneLine(maskExamText(w.draft_last ?? "", null)).slice(0, 100)}」`);
    console.log(`  → 足すなら: --add --conv=${w.conversation_id} --at=${cust[cust.length - 1]?.created_at ?? w.customer_turn_at} --type=… --accept=… --must-not=… --ask="…|reply|…" --why="…"\n`);
  }
}


// ─── 10/09 --suggest-sends: 竹内さんの番で、ブレインと違った AIX の番（＋手打ちでもスタッフだけが知る中身の番）の候補 ─────────────
//   源: brain_decision_logs（actual_aix_type・matched）× aix_usage_logs（押した AIX・ピッカー）× messages（書き手 staff_writer）。
//   竹内さん（10/09）: スタッフだけが知る事は AIX の番。手打ちで送った物でも中身（募集中・募集終了・退去予定・候補日時・待ち合わせ・見積の金額）を見て AIX の番にする。
//   正解は人が読んで決める（--add-batch で足す）。申込以降・テスト会話・もう入っている番は外す。伏せて出す。
//   出力: 画面に読む用・--out=<json> に候補（conv・at・押した AIX・竹内さんの文・ブレイン・場面の印）
const STAFF_ONLY_RE = /募集中|募集終了|申込(?:が)?入って|退去予定|空室|確認(?:させて頂きましたところ|しましたところ|した所)|管理会社に確認|ご案内可能です|\d{1,2}[:：]\d{2}|現地(?:エントランス)?(?:お)?待ち合わせ|初期費用[：:]\s*[\d,]+円|割引させて頂き/;
async function suggestSends() {
  const days = Number(arg("days", "45")), limit = Number(arg("limit", "120"));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const page = async <T,>(t: string, cols: string, f: (q: any) => any = (q) => q): Promise<T[]> => {
    let all: T[] = [];
    for (let o = 0; o < 40000; o += 1000) { const { data, error } = await f(sb.from(t).select(cols).gte("created_at", since)).order("created_at").range(o, o + 999); if (error) throw new Error(`${t}: ${error.message}`); all = all.concat((data ?? []) as T[]); if ((data ?? []).length < 1000) break; }
    return all;
  };
  type BL = { conversation_id: string; created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; suggested_check_pattern: string | null; decision_source: string | null; actual_aix_type: string | null; actual_check_pattern: string | null; actual_at: string | null; matched: boolean | null; scene_key: string | null };
  type AX = { conversation_id: string; created_at: string; aix_type: string; check_pattern: string | null; picker_choices: unknown };
  const bl = await page<BL>("brain_decision_logs", "conversation_id, created_at, suggested_action, suggested_reply_mode, suggested_check_pattern, decision_source, actual_aix_type, actual_check_pattern, actual_at, matched, scene_key");
  const ax = await page<AX>("aix_usage_logs", "conversation_id, created_at, aix_type, check_pattern, picker_choices");
  const axBy = new Map<string, AX[]>(); for (const a of ax) axBy.set(a.conversation_id, [...(axBy.get(a.conversation_id) ?? []), a]);
  const have = readSpec();
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  // 判断の記録は同じ番に何行もある → 番（会話×最後のお客様の通）ごとに最後の1行
  for (const b of [...bl].reverse()) {
    if (out.length >= limit * 3) break;
    if (isTestConversation(b.conversation_id)) continue;
    const t = ms(b.created_at);
    const { data: before } = await sb.from("messages").select("id, sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", b.conversation_id).lte("created_at", b.created_at).order("created_at", { ascending: false }).limit(8);
    const lastCust = ((before ?? []) as Msg[]).find((m) => m.sender === "customer");
    if (!lastCust) continue;
    const key = `${b.conversation_id}|${lastCust.created_at}`;
    if (seen.has(key)) continue; seen.add(key);
    if (have.some((s) => s.conv === b.conversation_id && Math.abs(ms(s.at) - ms(lastCust.created_at)) < 6 * 3600_000)) continue;
    // 番の後のこちらの送信（次のお客様の通まで・2時間以内）
    const { data: nx } = await sb.from("messages").select("id, sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", b.conversation_id).gt("created_at", lastCust.created_at).order("created_at").limit(12);
    const seq = (nx ?? []) as Msg[];
    let e = 0; while (e < seq.length && seq[e].sender !== "customer" && ms(seq[e].created_at) - ms(lastCust.created_at) < 2 * 3600_000) e++;
    const staff = seq.slice(0, e).filter((m) => m.sender !== "customer");
    if (!staff.length) continue;
    const writers = new Set(staff.map((m) => m.staff_writer).filter(Boolean));
    if (!writers.has("takeuchi") || writers.has("employee")) continue; // 竹内さんの番だけ
    const pressed = (axBy.get(b.conversation_id) ?? []).filter((a) => ms(a.created_at) >= ms(lastCust.created_at) && ms(a.created_at) - ms(lastCust.created_at) < 2 * 3600_000 && (!seq[e] || ms(a.created_at) < ms(seq[e].created_at)));
    const manual = staff.filter((m) => !m.is_aix_generated).map((m) => m.text ?? "").join("\n");
    const manualStaffOnly = !pressed.length && STAFF_ONLY_RE.test(manual);
    if (!pressed.length && !manualStaffOnly) continue;
    const brainAix = b.suggested_reply_mode === "aix" ? b.suggested_action : null;
    const actual = pressed[0]?.aix_type ?? "(手打ち)";
    if (pressed.length && brainAix === actual && !flag("include-matched")) continue; // ブレインと同じ（--include-matched で回帰の物差し用に残す）
    if (flag("include-matched") && !pressed.length) continue;
    const ctx = ((before ?? []) as Msg[]).slice(0, 6).reverse();
    out.push({
      conv: b.conversation_id, at: lastCust.created_at, actual, actualCp: pressed[0]?.check_pattern ?? null, pressedAll: pressed.map((a) => `${a.aix_type}${a.check_pattern ? `/${a.check_pattern}` : ""}`),
      manualStaffOnly, brain: brainAix ? `AIX:${brainAix}${b.suggested_check_pattern ? `/${b.suggested_check_pattern}` : ""}` : "返信", src: b.decision_source, scene: b.scene_key,
      customer: maskExamText(ctx.filter((m) => m.sender === "customer" && ms(m.created_at) >= ms(lastCust.created_at) - 10 * 60_000).map((m) => m.text ?? "").join("\n"), null).slice(0, 300),
      before: ctx.map((m) => `${m.sender === "customer" ? "C" : m.is_aix_generated ? "S[AIX]" : "S"}: ${oneLine(maskExamText(m.text ?? "", null)).slice(0, 140)}`),
      staff: oneLine(maskExamText(staff.map((m) => `${m.is_aix_generated ? "【AIX】" : ""}${m.text ?? ""}`).join("\n―\n"), null)).slice(0, 500),
    });
  }
  const pick = out.slice(0, limit);
  const c = new Map<string, number>(); for (const o of pick) c.set(String(o.actual), (c.get(String(o.actual)) ?? 0) + 1);
  console.log(`候補 ${pick.length}（${days}日・竹内さんの番・ブレインと違った AIX の番＋手打ちでスタッフだけが知る中身の番）: ${[...c].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}\n`);
  for (const o of pick) {
    console.log(`■ ${o.conv} ${String(o.at).slice(0, 16)} 押した=${(o.pressedAll as string[]).join(",") || "(手打ち・スタッフだけが知る中身)"} ブレイン=${o.brain}（${o.src ?? "-"}）`);
    for (const l of o.before as string[]) console.log(`   ${l}`);
    console.log(`  竹内さん「${String(o.staff).slice(0, 220)}」\n`);
  }
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify(pick, null, 1));
}

/** 10/09 --add-batch=<json>: 人が正解を書いた ExamSpec の配列（id なし）をまとめて足す。作れない番は飛ばして理由を出す */
async function addBatch() {
  const items = JSON.parse(readFileSync(arg("add-batch"), "utf8")) as Array<Omit<ExamSpec, "id">>;
  const spec = readSpec(), probs = readProblems();
  let n = spec.reduce((m, s) => Math.max(m, Number(s.id.slice(1)) || 0), 0);
  const skipped: string[] = [];
  for (const it of items) {
    if (!it.conv || !it.at || !it.type || !it.accept?.length || !it.why) { skipped.push(`${it.conv}: 必須が無い`); continue; }
    if (spec.some((s) => s.conv === it.conv && Math.abs(ms(s.at) - ms(it.at)) < 60_000)) { skipped.push(`${it.conv} ${it.at}: もう入っている`); continue; }
    const s: ExamSpec = { ...it, id: `q${String(n + 1).padStart(3, "0")}`, addedAt: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10), addedBy: it.addedBy ?? "brain-exam-add --add-batch" } as ExamSpec;
    const built = await buildProblem(s);
    if (typeof built === "string") { skipped.push(`${it.conv} ${it.at}（${it.type}）: ${built}`); continue; }
    n++; spec.push(s); probs.push(built);
    console.log(`足した: ${s.id} [${s.type}] 客「${oneLine(built.customer).slice(0, 60)}」 正解=${s.accept.join("|")}`);
  }
  writeFileSync(SPEC_FILE, JSON.stringify(spec, null, 1));
  writeFileSync(PROBLEMS_FILE, JSON.stringify(probs, null, 1));
  console.log(`\n足した ${items.length - skipped.length}・飛ばした ${skipped.length}${skipped.length ? `\n  ${skipped.join("\n  ")}` : ""}`);
}


// ─── 10/09 --suggest-scenes: 試験に足りない場面（画像・内覧の後・閉じる・不安）の竹内さんの番の候補（正解は人が読んで決める） ─────────
const SCENE_RES: Array<[string, RegExp]> = [
  ["画像", /^\s*\[画像\]/],
  ["内覧の後", /(?:本日|今日)は?(?:ありがとう|有難う)|内覧(?:ありがとう|させて頂き)|見に行けて|実際に見て|見てきました/],
  ["不安", /不安|心配|大丈夫(?:です)?か|通ります?か|通らない|厳しい(?:です)?か|ブラック|滞納|夜職|無職|審査/],
  ["閉じる", /^(?:はい|了解|わかりました|分かりました|承知)?[！!。、\s]*(?:ありがとうございます|ありがとう|よろしくお願いします|お願いします)[！!。😊🙇‍♀️🙇‍♂️🙏\s]*$/],
];
async function suggestScenes() {
  const days = Number(arg("days", "45")), per = Number(arg("per", "15"));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let data: Array<Msg & { conversation_id: string }> = [];
  for (let o = 0; o < 20000; o += 1000) { const r = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, staff_writer").eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: false }).range(o, o + 999); if (r.error) throw new Error(r.error.message); data = data.concat((r.data ?? []) as typeof data); if ((r.data ?? []).length < 1000) break; }
  const have = readSpec();
  const got = new Map<string, number>();
  const seenConv = new Set<string>();
  for (const m of data) {
    if (isTestConversation(m.conversation_id) || seenConv.has(m.conversation_id)) continue;
    const scene = SCENE_RES.find(([, re]) => re.test(m.text ?? ""))?.[0];
    if (!scene || (got.get(scene) ?? 0) >= per) continue;
    if (have.some((s) => s.conv === m.conversation_id && Math.abs(ms(s.at) - ms(m.created_at)) < 6 * 3600_000)) continue;
    const { data: nx } = await sb.from("messages").select("id, sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", m.conversation_id).gt("created_at", m.created_at).order("created_at").limit(8);
    const seq = (nx ?? []) as Msg[];
    if (seq[0]?.sender === "customer") continue; // 連投の途中（最後の通で作る）
    let e = 0; while (e < seq.length && seq[e].sender !== "customer" && ms(seq[e].created_at) - ms(m.created_at) < 2 * 3600_000) e++;
    const staff = seq.slice(0, e);
    const w = new Set(staff.map((x) => x.staff_writer).filter(Boolean));
    if (!staff.length || !w.has("takeuchi") || w.has("employee")) continue;
    const { data: bf } = await sb.from("messages").select("sender, text, is_aix_generated, created_at").eq("conversation_id", m.conversation_id).lt("created_at", m.created_at).order("created_at", { ascending: false }).limit(4);
    seenConv.add(m.conversation_id); got.set(scene, (got.get(scene) ?? 0) + 1);
    console.log(`■ [${scene}] ${m.conversation_id} ${m.created_at}`);
    for (const x of ((bf ?? []) as Msg[]).reverse()) console.log(`   ${x.sender === "customer" ? "C" : x.is_aix_generated ? "S[AIX]" : "S"}: ${oneLine(maskExamText(x.text ?? "", null)).slice(0, 140)}`);
    console.log(`   C(今): ${oneLine(maskExamText(m.text ?? "", null)).slice(0, 200)}`);
    console.log(`  竹内さん「${oneLine(maskExamText(staff.map((x) => `${x.is_aix_generated ? "【AIX】" : ""}${x.text ?? ""}`).join("\n―\n"), null)).slice(0, 300)}」\n`);
  }
  console.log(`場面ごと: ${[...got].map(([k, v]) => `${k} ${v}`).join("・")}`);
}

if (require.main === module) {
  (async () => {
    if (flag("rebuild")) await rebuild(arg("only").split(",").filter(Boolean));
    else if (flag("add")) await add();
    else if (flag("suggest")) await suggest();
    else if (flag("suggest-sends")) await suggestSends();
    else if (flag("suggest-scenes")) await suggestScenes();
    else if (arg("add-batch")) await addBatch();
    else console.log("使い方: --rebuild [--only=q001,q002] ／ --suggest [--days=14] ／ --add --conv= --at= --type= --accept= --why= [--must-not=] [--ask=] [--ng=] [--tags=]");
  })().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
