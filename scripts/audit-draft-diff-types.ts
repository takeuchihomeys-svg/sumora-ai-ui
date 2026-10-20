// scripts/audit-draft-diff-types.ts — 見張り（line_watch_turns）の「AI の下書き × スタッフが送った文」を中身の型に分けて場面ごとに数える（読むだけ・LLM なし）
//   分け方は app/lib/draft-diff-types.ts（主の型1つ＋中身の型 足した/消した）。場面は reply-scene.resolveReplyScene（お客様の番の文）。
//   対象: 直近 N 日・返信の番（verdict_detail.path=返信）・スタッフの返事のまとまりあり・YUMA/身内の会話と自動返信の期間は除く。
//   下書きは判定と同じ選び方（verdict_detail.draft_src=first なら draft_first・stale/none は「下書きなし」）。
//   例は伏せ字（名前・数字・カタカナの語・URL）で短く出す。出力はこの端末だけ（ファイルに書かない）。
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-diff-types.ts [--days=30] [--examples=3] [--writer=all|takeuchi|employee]
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
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 200_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const SCENES: ReplyScene[] = ["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply", "other"];
type Row = { reason: string; staffOnly: boolean; cid: string; at: string; scene: ReplyScene; writer: StaffWriter | null; draftSrc: string; diff: DraftDiff; draft: string; staff: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const watch = await readAll<{ conversation_id: string; customer_turn_at: string; customer_last_at: string | null; draft_last: string | null; draft_first: string | null; staff_texts: Array<{ at: string; text: string; burst: boolean }> | null; verdict_detail: Record<string, unknown> | null }>((f, t) =>
    sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, draft_last, draft_first, staff_texts, verdict_detail").gte("customer_turn_at", since).order("customer_turn_at").range(f, t));
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
    rows.push({ reason: String(vd.reason ?? ""), staffOnly: isStaffOnlyReport(staff), cid: w.conversation_id, at, scene: resolveReplyScene({ customerText: cust }).scene, writer: writer ?? null, draftSrc: src || "(なし)", diff: classifyDraftDiff(draft, staff), draft, staff });
  }
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
main().catch((e) => { console.error(e); process.exit(1); });
