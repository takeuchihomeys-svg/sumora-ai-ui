// scripts/audit-draft-diff-types.ts — 見張り（line_watch_turns）の「AI の下書き × スタッフが送った文」を中身の型に分けて場面ごとに数える（読むだけ・LLM なし）
//   分け方は app/lib/draft-diff-types.ts（主の型1つ＋中身の型 足した/消した）。場面は reply-scene.resolveReplyScene（お客様の番の文）。
//   対象: 直近 N 日・返信の番（verdict_detail.path=返信）・スタッフの返事のまとまりあり・YUMA/身内の会話と自動返信の期間は除く。
//   下書きは判定と同じ選び方（verdict_detail.draft_src=first なら draft_first・stale/none は「下書きなし」）。
//   例は伏せ字（名前・数字・カタカナの語・URL）で短く出す。出力はこの端末だけ（ファイルに書かない）。
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-diff-types.ts [--days=30] [--examples=3] [--writer=all|takeuchi|employee] [--why-no-draft]
//   --why-no-draft（2026-10-20）: 「下書きなし」の番だけを、なぜ無かったかの訳に分けて数える（読むだけ）。訳は上から先に当たった物:
//     phantom_turn    … 番の鍵（customer_turn_at）のお客様の発言が今は無い（消えた・時刻が変わった）＝同じ番の重複行（本物の行は別にある）
//     backfill        … 埋め戻しの番（当時の下書きの記録が無い）
//     capture_missing … 見張りの控え（conversations のトリガー）に何も入っていない＝記録の止まり（送信の記録 ai_reply_examples に下書きがあれば「作られていたが控えに無い」）
//     post_apply      … その番の時点で本人確認書類・収入証明・申込へ押下（戻しより後）・申込以降の印＝下書きの関所（post-apply.ts）が止めた。見張りは status だけで「返信」に数える
//     stale           … 下書きはあったが連投の途中の発言向け（比べない）
//     sentinel        … 印だけ（[返信不要] 等）
//     night           … 夜（JST 22〜9）に届き、9:00 より前にスタッフが返した
//     staff_fast      … 返信生成の呼び出しより前にスタッフが返した
//     not_generated   … 返信生成の呼び出しが窓の中に1回も無い（sweep のブレインだけ等）
//     generated_lost  … 返信生成は呼ばれたが控えに下書きが無い
import { createClient } from "@supabase/supabase-js";
import { classifyDraftDiff, maskText, PRIMARY_TYPES, PRIMARY_JA, CONTENT_JA, type ContentType, type DraftDiff } from "../app/lib/draft-diff-types";
import { resolveReplyScene, REPLY_SCENE_JA, type ReplyScene } from "../app/lib/reply-scene";
import { isTestConversation } from "../app/lib/test-conversations";
import { isStaffOnlyReport } from "../app/lib/text-diff-types";
import { cleanDraft } from "../app/lib/line-watch-judge";
import { writerFromText, writerFromEdit, inAutoReplyPeriod, type StaffWriter } from "../app/lib/staff-writer";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const EXAMPLES = Number(arg("examples", "3"));
const WRITER = arg("writer", "all");
const WHY = process.argv.includes("--why-no-draft");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 200_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const SCENES: ReplyScene[] = ["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply", "other"];
type WatchRow = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; conv_status: string | null; draft_last: string | null; draft_first: string | null; draft_sentinel: string | null; brain_at: string | null; brain_reply_mode: string | null; final_check: unknown; staff_texts: Array<{ at: string; text: string; burst: boolean }> | null; verdict_detail: Record<string, unknown> | null };
type Row = { w: WatchRow; reason: string; staffOnly: boolean; cid: string; at: string; scene: ReplyScene; writer: StaffWriter | null; draftSrc: string; diff: DraftDiff; draft: string; staff: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const watch = await readAll<WatchRow>((f, t) =>
    sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, conv_status, draft_last, draft_first, draft_sentinel, brain_at, brain_reply_mode, final_check, staff_texts, verdict_detail").gte("customer_turn_at", since).order("customer_turn_at").range(f, t));
  const msgs = await readAll<{ conversation_id: string; sender: string; created_at: string; text: string | null }>((f, t) =>
    sb.from("messages").select("conversation_id, sender, created_at, text").eq("sender", "customer").gte("created_at", since).order("created_at").order("id").range(f, t));
  const mBy = new Map<string, typeof msgs>();
  for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  const pathCount = new Map<string, number>();
  const rows: Row[] = [];
  for (const w of watch) {
    if (isTestConversation(w.conversation_id)) continue;
    const vd = w.verdict_detail ?? {};
    const path = String(vd.path ?? "(なし)"); pathCount.set(path, (pathCount.get(path) ?? 0) + 1);
    if (path !== "返信") continue;
    const burst = (w.staff_texts ?? []).filter((t) => t.burst);
    if (!burst.length) continue;
    const staff = burst.map((t) => t.text).join("\n").trim();
    if (!staff) continue;
    const at = burst[0].at;
    if (inAutoReplyPeriod(at)) continue;
    const src = String(vd.draft_src ?? "");
    const draft = src === "stale" || src === "none" ? "" : (cleanDraft(src === "first" ? w.draft_first : w.draft_last).text ?? "");
    const cust = (mBy.get(w.conversation_id) ?? []).filter((m) => m.created_at >= w.customer_turn_at && m.created_at <= (w.customer_last_at ?? w.customer_turn_at)).map((m) => m.text ?? "").join("\n");
    const writer = draft ? (writerFromEdit(draft, staff).writer ?? writerFromText(staff).writer) : writerFromText(staff).writer;
    if (WRITER !== "all" && (WRITER === "unknown" ? writer : writer !== WRITER)) continue;
    rows.push({ w, reason: String(vd.reason ?? ""), staffOnly: isStaffOnlyReport(staff), cid: w.conversation_id, at, scene: resolveReplyScene({ customerText: cust }).scene, writer: writer ?? null, draftSrc: src || "(なし)", diff: classifyDraftDiff(draft, staff), draft, staff });
  }
  if (WHY) return whyNoDraft(rows, since, mBy);
  console.log(`見張りの番 ${watch.length}（path: ${[...pathCount].map(([k, v]) => `${k} ${v}`).join("・")}）→ 返信の番で送った文あり ${rows.length}`);
  console.log(`書き手: 竹内 ${rows.filter((r) => r.writer === "takeuchi").length}・従業員 ${rows.filter((r) => r.writer === "employee").length}・不明 ${rows.filter((r) => !r.writer).length}`);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  const byScene = (list: Row[], s: ReplyScene) => list.filter((r) => r.scene === s);

  console.log(`\n■ 主の型 × 場面（件数）`);
  console.log(["型", "全体", ...SCENES.map((s) => REPLY_SCENE_JA[s])].join(" | "));
  console.log(["(番の数)", String(rows.length), ...SCENES.map((s) => String(byScene(rows, s).length))].join(" | "));
  for (const p of PRIMARY_TYPES) {
    const c = (l: Row[]) => l.filter((r) => r.diff.primary === p).length;
    console.log([PRIMARY_JA[p], `${c(rows)}(${pct(c(rows), rows.length)})`, ...SCENES.map((s) => String(c(byScene(rows, s))))].join(" | "));
  }
  // 下書きなしの訳（見張りの判定の reason）と、差し替え・足し引きのうち「送った文がスタッフだけが知る事の報告」の数（＝書く役ではなく AIX／ブレインの道の話）
  { const m = new Map<string, number>(); for (const r of rows.filter((r) => r.diff.primary === "no_draft")) m.set(r.reason || "(なし)", (m.get(r.reason || "(なし)") ?? 0) + 1);
    console.log(`  下書きなしの訳: ${[...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
    for (const p of ["replaced", "content_edit"] as const) { const l = rows.filter((r) => r.diff.primary === p); console.log(`  ${PRIMARY_JA[p]} ${l.length} のうち送った文がスタッフだけが知る事の報告: ${l.filter((r) => r.staffOnly).length}`); } }
  const withDraft = rows.filter((r) => r.diff.primary !== "no_draft");
  console.log(`\n■ 中身の型 × 場面（下書きあり ${withDraft.length} 番・1番に複数）多い順`);
  console.log(["型", "全体", ...SCENES.map((s) => REPLY_SCENE_JA[s])].join(" | "));
  const keys = Object.keys(CONTENT_JA) as ContentType[];
  const cnt = (l: Row[], k: ContentType) => l.filter((r) => r.diff.content.includes(k)).length;
  const sorted = keys.filter((k) => cnt(withDraft, k)).sort((a, b) => cnt(withDraft, b) - cnt(withDraft, a));
  for (const k of sorted) console.log([CONTENT_JA[k], `${cnt(withDraft, k)}(${pct(cnt(withDraft, k), withDraft.length)})`, ...SCENES.map((s) => String(cnt(byScene(withDraft, s), k)))].join(" | "));

  console.log(`\n■ 書き手ごと（中身の型の上位）`);
  for (const w of ["takeuchi", "employee"] as const) {
    const l = withDraft.filter((r) => r.writer === w);
    console.log(`  ${w}（${l.length}）: ` + sorted.slice(0, 10).map((k) => `${CONTENT_JA[k].replace(/（.*）/, "")} ${cnt(l, k)}`).join("・"));
  }

  if (EXAMPLES > 0) {
    console.log(`\n■ 例（伏せ字・各型 ${EXAMPLES} 件まで・新しい順）`);
    for (const k of sorted.slice(0, 12)) {
      console.log(`\n◆ ${CONTENT_JA[k]}`);
      const [dir, kind] = k.split(":") as ["added" | "removed", string];
      for (const r of withDraft.filter((r) => r.diff.content.includes(k)).slice(-EXAMPLES).reverse()) {
        const hit = (dir === "added" ? r.diff.added : r.diff.removed).find((x) => x.kind === kind)?.text;
        console.log(`  [${REPLY_SCENE_JA[r.scene]}・${r.cid.slice(0, 6)}・${r.at.slice(0, 10)}] ${dir === "added" ? "足した" : "消した"}: ${hit ? maskText(hit) : "(文全体の有無)"}`);
        if (!hit) console.log(`      下書き: ${maskText(r.draft, 60)}\n      送った: ${maskText(r.staff, 60)}`);
      }
    }
    for (const p of ["replaced", "no_draft"] as const) {
      console.log(`\n◆ ${PRIMARY_JA[p]}（場面別）: ` + SCENES.map((s) => `${REPLY_SCENE_JA[s]} ${byScene(rows, s).filter((r) => r.diff.primary === p).length}`).join("・"));
      for (const r of rows.filter((r) => r.diff.primary === p).slice(-EXAMPLES).reverse()) {
        console.log(`  [${REPLY_SCENE_JA[r.scene]}・${r.cid.slice(0, 6)}・src=${r.draftSrc}] 下書き: ${maskText(r.draft, 50) || "(なし)"}\n      送った: ${maskText(r.staff, 60)}`);
      }
    }
  }
}
// ── --why-no-draft ──
const JST = 9 * 3_600_000;
const jstHour = (iso: string) => new Date(Date.parse(iso) + JST).getUTCHours();
/** その発言の後の 9:00 JST（UTC ms） */
function nineAmAfter(iso: string): number {
  const t = Date.parse(iso) + JST; const d = new Date(t); d.setUTCHours(9, 0, 0, 0);
  if (d.getTime() <= t) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime() - JST;
}
type WhyNoDraft = "phantom_turn" | "backfill" | "capture_missing" | "post_apply" | "stale" | "sentinel" | "night" | "staff_fast" | "not_generated" | "generated_lost";
const WHY_ORDER: WhyNoDraft[] = ["phantom_turn", "capture_missing", "post_apply", "backfill", "stale", "sentinel", "night", "staff_fast", "not_generated", "generated_lost"];
const WHY_JA: Record<WhyNoDraft, string> = {
  phantom_turn: "番の鍵のお客様の発言が今は無い（消えた・時刻が変わった＝同じ番の重複行）", capture_missing: "見張りの控えが空（記録の止まり）", backfill: "埋め戻しの番（当時の下書き記録なし）", post_apply: "申込以降の関所で止めた（見張りは返信に数える）",
  stale: "連投の途中向けの古い下書き（比べない）", sentinel: "印だけ", night: "夜の見送り中に返した", staff_fast: "生成より先にスタッフが返した",
  not_generated: "返信生成が呼ばれていない", generated_lost: "生成は呼ばれたが控えに無い",
};
type Ctx = { phantom: boolean; gens: number; firstGenMs: number | null; sweepOnly: boolean; docMs: number | null; pushMs: number | null; backMs: number | null; badge: boolean; exampleDraft: boolean };
function classifyNoDraft(r: Row, c: Ctx): WhyNoDraft {
  const w = r.w;
  if ((w.verdict_detail as Record<string, unknown> | null)?.backfill) return "backfill";
  if (c.phantom) return "phantom_turn";
  if (!w.brain_at && !w.draft_first && !w.draft_last && !w.draft_sentinel && !w.final_check) return "capture_missing";
  const appMs = Math.max(c.docMs ?? -Infinity, c.pushMs ?? -Infinity);
  if (c.badge || (Number.isFinite(appMs) && !(c.backMs !== null && c.backMs > appMs))) return "post_apply";
  if (r.draftSrc === "stale") return "stale";
  if (w.draft_sentinel || r.reason === "sentinel_only") return "sentinel";
  const custLast = w.customer_last_at ?? w.customer_turn_at;
  const staffMs = Date.parse(r.at);
  const h = jstHour(custLast);
  if ((h >= 22 || h < 9) && staffMs < nineAmAfter(custLast)) return "night";
  if (c.firstGenMs === null) return staffMs - Date.parse(custLast) < 3 * 60_000 ? "staff_fast" : "not_generated";
  if (c.firstGenMs > staffMs) return "staff_fast";
  return "generated_lost";
}
function countBy<T>(l: T[], f: (x: T) => string): Map<string, number> { const m = new Map<string, number>(); for (const x of l) m.set(f(x), (m.get(f(x)) ?? 0) + 1); return m; }
const fmt = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join("・");
function median(v: number[]): number { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); }

async function whyNoDraft(all: Row[], since: string, custBy: Map<string, Array<{ created_at: string }>>) {
  const rows = all.filter((r) => r.diff.primary === "no_draft");
  const cids = [...new Set(rows.map((r) => r.cid))];
  type CR = { conversation_id: string; created_at: string };
  // llm_usage_logs は大きい（試験の行が多い）ので会話ごとに1つずつ読む（まとめて in で読むと statement timeout）
  const llm: Array<CR & { route: string | null }> = [];
  for (const cid of cids) {
    llm.push(...await readAll<CR & { route: string | null }>((f, t) => sb.from("llm_usage_logs").select("conversation_id, created_at, route").eq("conversation_id", cid).gte("created_at", since)
      .in("route", ["/api/generate-reply", "/api/generate-draft-bg-async", "/api/cron/brain-sweep"]).range(f, t)));
  }
  const [docs, push, convs, ex] = await Promise.all([
    readAll<CR>((f, t) => sb.from("messages").select("conversation_id, created_at").in("conversation_id", cids).eq("sender", "customer").in("image_type", ["id_document", "income_document"]).order("id").range(f, t)),
    readAll<CR>((f, t) => sb.from("aix_usage_logs").select("conversation_id, created_at").in("conversation_id", cids).eq("aix_type", "application_push").order("id").range(f, t)),
    readAll<{ id: string; is_post_apply: boolean | null; deepseek_cutoff_at: string | null; status_manual_back_at: string | null }>((f, t) =>
      sb.from("conversations").select("id, is_post_apply, deepseek_cutoff_at, status_manual_back_at").in("id", cids).range(f, t)),
    readAll<CR & { ai_draft: string | null }>((f, t) => sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft").in("conversation_id", cids).gte("created_at", since).order("id").range(f, t)),
  ]);
  const by = <T extends CR>(l: T[]) => { const m = new Map<string, T[]>(); for (const x of l) { const k = String(x.conversation_id); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); } return m; };
  const llmBy = by(llm), docBy = by(docs), pushBy = by(push), exBy = by(ex);
  const convBy = new Map(convs.map((c) => [String(c.id), c]));
  const lastBefore = (l: CR[] | undefined, ms: number) => { const v = (l ?? []).map((x) => Date.parse(x.created_at)).filter((x) => x <= ms); return v.length ? Math.max(...v) : null; };
  const out: Array<{ r: Row; why: WhyNoDraft; c: Ctx }> = [];
  for (const r of rows) {
    const from = Date.parse(r.w.customer_turn_at) - 60_000, to = Date.parse(r.at);
    const custLast = Date.parse(r.w.customer_last_at ?? r.w.customer_turn_at);
    const inWin = (llmBy.get(r.cid) ?? []).filter((x) => { const t = Date.parse(x.created_at); return t >= from && t <= to; });
    const gens = inWin.filter((x) => x.route !== "/api/cron/brain-sweep").map((x) => Date.parse(x.created_at)).sort((a, b) => a - b);
    const cv = convBy.get(r.cid);
    const backs = [cv?.status_manual_back_at, cv?.deepseek_cutoff_at].filter((x): x is string => !!x).map((x) => Date.parse(x));
    const c: Ctx = {
      phantom: !(custBy.get(r.cid) ?? []).some((m) => Date.parse(m.created_at) === Date.parse(r.w.customer_turn_at)),
      gens: gens.length, firstGenMs: gens.length ? gens[0] : null,
      sweepOnly: inWin.some((x) => x.route === "/api/cron/brain-sweep") && !gens.length,
      docMs: lastBefore(docBy.get(r.cid), custLast), pushMs: lastBefore(pushBy.get(r.cid), custLast),
      backMs: backs.length ? Math.max(...backs) : null,
      badge: cv?.is_post_apply === true, // 今の印（番の時点の値は残っていない）
      exampleDraft: (exBy.get(r.cid) ?? []).some((e) => { const t = Date.parse(e.created_at); return t >= from && t <= to + 30 * 60_000 && !!cleanDraft(e.ai_draft).text; }),
    };
    out.push({ r, why: classifyNoDraft(r, c), c });
  }
  const W = ["takeuchi", "employee", "unknown"];
  const wOf = (r: Row) => String(r.writer ?? "unknown");
  console.log(`下書きなしの番 ${rows.length}（返信の番 ${all.length}・見張りの reason: ${fmt(countBy(rows, (r) => r.reason))}）`);
  console.log(["訳", "計", ...W, "見張りの reason"].join(" | "));
  for (const k of WHY_ORDER) {
    const l = out.filter((x) => x.why === k); if (!l.length) continue;
    console.log([`${k}（${WHY_JA[k]}）`, String(l.length), ...W.map((w) => String(l.filter((x) => wOf(x.r) === w).length)), fmt(countBy(l.map((x) => x.r), (r) => r.reason))].join(" | "));
  }
  const cm = out.filter((x) => x.why === "capture_missing");
  if (cm.length) console.log(`\n■ 控えが空: 日付 ${[...countBy(cm.map((x) => x.r), (r) => r.w.customer_turn_at.slice(5, 10))].sort().map(([d, n]) => `${d} ${n}`).join("・")}／窓で返信生成の呼び出しあり ${cm.filter((x) => x.c.gens).length}・送信の記録に下書きあり ${cm.filter((x) => x.c.exampleDraft).length}`);
  const pa = out.filter((x) => x.why === "post_apply");
  if (pa.length) console.log(`■ 申込以降: 書類 ${pa.filter((x) => (x.c.docMs ?? -1) >= (x.c.pushMs ?? -1) && (x.c.docMs ?? -1) > 0).length}・申込へ押下 ${pa.filter((x) => (x.c.pushMs ?? -1) > (x.c.docMs ?? -1)).length}・印だけ ${pa.filter((x) => x.c.docMs === null && x.c.pushMs === null).length}／見張りの段階 ${fmt(countBy(pa.map((x) => x.r), (r) => r.w.conv_status ?? "(なし)"))}／会話 ${new Set(pa.map((x) => x.r.cid)).size}`);
  const ng = out.filter((x) => x.why === "not_generated");
  if (ng.length) console.log(`■ 生成なし: sweep のブレインだけ ${ng.filter((x) => x.c.sweepOnly).length}・ブレインの道 ${fmt(countBy(ng.map((x) => x.r), (r) => r.w.brain_reply_mode ?? "(なし)"))}・スタッフまでの中央値 ${median(ng.map((x) => (Date.parse(x.r.at) - Date.parse(x.r.w.customer_last_at ?? x.r.w.customer_turn_at)) / 60_000))}分`);
  const tba = out.filter((x) => x.r.reason === "text_but_aix");
  if (tba.length) console.log(`■ text_but_aix（ブレインは返信・スタッフは AIX を押した・下書きなし）${tba.length}: 訳 ${fmt(countBy(tba, (x) => x.why))}／押した AIX ${fmt(countBy(tba, (x) => String((((x.r.w.verdict_detail ?? {}) as { staff_aix?: string[] }).staff_aix ?? ["?"])[0])))}`);
  if (EXAMPLES > 0) for (const k of WHY_ORDER) {
    const l = out.filter((x) => x.why === k).slice(-EXAMPLES).reverse(); if (!l.length) continue;
    console.log(`\n◆ ${k}`);
    for (const x of l) console.log(`  [${x.r.cid.slice(0, 6)}・${x.r.w.customer_turn_at.slice(0, 16)}・${x.r.reason}・${wOf(x.r)}・生成${x.c.gens}] 送った: ${maskText(x.r.staff, 50)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
