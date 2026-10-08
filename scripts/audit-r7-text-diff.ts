// scripts/audit-r7-text-diff.ts — 7巡目: 返信の番の「AI の下書き × スタッフの実送信」を文の細かい差の型に分けて数える（読むだけ・LLM なし）
//   材料は2つ（重なりは会話＋送信時刻±3分で1つに）:
//     A. ai_reply_examples（entry_source=line_reply・ai_draft あり）＝スタッフが送る時に入力欄にあった下書き × 送った文
//     B. line_watch_turns（見張り・path=返信・draft が stale でない・スタッフの文あり）＝ AI の案 × 返事のまとまりの文
//   場面は reply-scene.resolveReplyScene（お客様の番の文）。YUMA・身内の会話は除く。
//   あわせて「スタッフの書き方の多数派」（同じ期間の手打ちを含む全送信）と AI の下書きの率を場面ごとに並べる＝寄せる先
// 実行: npx tsx --env-file=.env.local scripts/audit-r7-text-diff.ts [--days=30] [--out=scripts/.replay-out/r7-diff.jsonl]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { diffTexts, DIFF_TYPES, DIFF_TYPE_JA, openerKindOf, OPENER_JA, exclaimOf, emojisOf, newlineOf, kanaStyleOf, type DiffType } from "../app/lib/text-diff-types";
import { resolveReplyScene, REPLY_SCENE_JA, type ReplyScene } from "../app/lib/reply-scene";
import { isTestConversation } from "../app/lib/test-conversations";
import { cleanDraft } from "../app/lib/line-watch-judge";
import { subSceneOf } from "../app/lib/reply-subscene";
import { isStaffOnlyReport } from "../app/lib/text-diff-types";
import { writerFromText, writerFromEdit, inAutoReplyPeriod, type StaffWriter } from "../app/lib/staff-writer";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const OUT = arg("out", "scripts/.replay-out/r7-diff.jsonl");
// 2026-10-08 書き手で分ける（竹内「竹内のLINEか従業員のLINEかで考える方がかなり分析の質が変わる」）: takeuchi｜employee｜unknown｜all（既定 all＝旧と同じ）
//   書き手は直した所の表記（app/lib/staff-writer.writerFromEdit）。直した所に手掛かりが無い組は送った文全体（writerFromText）で「たぶん」
const WRITER = arg("writer", "all");
const WRITER_FALLBACK = !process.argv.includes("--writer-edit-only"); // 直した所に手掛かりが無い組を不明にする
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 200_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const SCENES: ReplyScene[] = ["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply", "other"];

type Pair = { writer?: StaffWriter | null; src: "A" | "B"; cid: string; at: string; scene: ReplyScene; customer: string; draft: string; staff: string; watchVerdict?: string | null; watchReason?: string | null; tpo?: string | null; prev?: string; staffOnly?: boolean };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const ex = await readAll<{ conversation_id: string; sent_at: string | null; created_at: string; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; aix_action: string | null; tpo: string | null }>((f, t) =>
    sb.from("ai_reply_examples").select("conversation_id, sent_at, created_at, customer_message, ai_draft, sent_reply, aix_action, tpo:reply_context_snapshot->>tpo_label").eq("entry_source", "line_reply").gte("created_at", since).order("created_at").range(f, t));
  const watch = await readAll<{ conversation_id: string; customer_turn_at: string; customer_last_at: string | null; draft_last: string | null; draft_first: string | null; staff_texts: Array<{ at: string; text: string; burst: boolean }> | null; verdict: string | null; verdict_detail: Record<string, unknown> | null; tpo_label: string | null }>((f, t) =>
    sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, draft_last, draft_first, staff_texts, verdict, verdict_detail, tpo_label").gte("customer_turn_at", since).order("customer_turn_at").range(f, t));
  const msgs = await readAll<{ conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null }>((f, t) =>
    sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  console.log(`例 ${ex.length}・見張り ${watch.length}・messages ${msgs.length}`);
  const mBy = new Map<string, typeof msgs>();
  for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  /** 番の前のこちらの最後の文（何への返事か） */
  const prevStaffBefore = (cid: string, at: string) => {
    const list = mBy.get(cid) ?? []; const T = Date.parse(at);
    let i = list.length - 1; while (i >= 0 && Date.parse(list[i].created_at) > T) i--;
    while (i >= 0 && list[i].sender !== "customer") i--;
    while (i >= 0 && list[i].sender === "customer") i--;
    while (i >= 0 && (list[i].sender === "customer" || !(list[i].text ?? "").trim() || /^[(?:画像|動画)]$/.test((list[i].text ?? "").trim()))) i--;
    return i >= 0 ? list[i].text ?? "" : "";
  };
  const custTextBefore = (cid: string, at: string) => {
    const list = mBy.get(cid) ?? []; const T = Date.parse(at); const out: string[] = [];
    let i = list.length - 1; while (i >= 0 && Date.parse(list[i].created_at) > T) i--;
    while (i >= 0 && list[i].sender !== "customer") i--;
    while (i >= 0 && list[i].sender === "customer") { out.unshift(list[i].text ?? ""); i--; }
    return out.join("\n");
  };

  const pairs: Pair[] = [];
  for (const e of ex) {
    if (isTestConversation(e.conversation_id) || e.aix_action) continue;
    const draft = cleanDraft(e.ai_draft).text ?? "", staff = (e.sent_reply ?? "").trim();
    if (!draft || !staff) continue;
    const at = e.sent_at ?? e.created_at;
    const cust = (e.customer_message ?? "").trim() || custTextBefore(e.conversation_id, at);
    pairs.push({ src: "A", cid: e.conversation_id, at, scene: resolveReplyScene({ customerText: cust }).scene, customer: cust, draft, staff, tpo: e.tpo, prev: prevStaffBefore(e.conversation_id, at), staffOnly: isStaffOnlyReport(staff) });
  }
  for (const w of watch) {
    if (isTestConversation(w.conversation_id)) continue;
    const vd = w.verdict_detail ?? {};
    if (vd.path !== "返信" || vd.draft_src === "stale" || vd.draft_src === "none") continue;
    const draft = cleanDraft(vd.draft_src === "first" ? w.draft_first : w.draft_last).text ?? "";
    const burst = (w.staff_texts ?? []).filter((t) => t.burst);
    if (!draft || !burst.length) continue;
    const staff = burst.map((t) => t.text).join("\n").trim();
    const at = burst[0].at;
    if (pairs.some((p) => p.cid === w.conversation_id && Math.abs(Date.parse(p.at) - Date.parse(at)) < 180_000)) {
      const p = pairs.find((p) => p.cid === w.conversation_id && Math.abs(Date.parse(p.at) - Date.parse(at)) < 180_000)!; p.watchVerdict = w.verdict; p.watchReason = String(vd.reason ?? ""); continue;
    }
    const msgsIn = (mBy.get(w.conversation_id) ?? []).filter((m) => m.sender === "customer" && m.created_at >= w.customer_turn_at && m.created_at <= (w.customer_last_at ?? w.customer_turn_at));
    const cust = msgsIn.map((m) => m.text ?? "").join("\n");
    pairs.push({ src: "B", cid: w.conversation_id, at, scene: resolveReplyScene({ customerText: cust }).scene, customer: cust, draft, staff, prev: prevStaffBefore(w.conversation_id, at), staffOnly: isStaffOnlyReport(staff), watchVerdict: w.verdict, watchReason: String(vd.reason ?? ""), tpo: w.tpo_label });
  }
  for (const p of pairs) { const e = writerFromEdit(p.draft, p.staff); p.writer = e.writer ?? (WRITER_FALLBACK ? writerFromText(p.staff).writer : null); }
  { const c = (w: StaffWriter | null) => pairs.filter((p) => (p.writer ?? null) === w).length; console.log(`書き手（直した所の表記→無ければ文全体）: 竹内 ${c("takeuchi")}・従業員 ${c("employee")}・不明 ${c(null)}`); }
  const keep = pairs.filter((p) => !inAutoReplyPeriod(p.at) && (WRITER === "all" || (WRITER === "unknown" ? !p.writer : p.writer === WRITER)));
  pairs.length = 0; pairs.push(...keep);
  console.log(`組 ${pairs.length}（A ${pairs.filter((p) => p.src === "A").length}・B ${pairs.filter((p) => p.src === "B").length}）`);

  // 型の数え
  const rows = pairs.map((p) => ({ ...p, diff: diffTexts(p.draft, p.staff) }));
  const byScene = new Map<ReplyScene, typeof rows>();
  for (const r of rows) { if (!byScene.has(r.scene)) byScene.set(r.scene, []); byScene.get(r.scene)!.push(r); }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  console.log(`\n■ 全体: 完全一致 ${rows.filter((r) => r.diff.same).length}/${rows.length}（${pct(rows.filter((r) => r.diff.same).length, rows.length)}）・芯が同じ ${rows.filter((r) => r.diff.sameCore).length}・似ている度 平均 ${(rows.reduce((a, r) => a + r.diff.sim, 0) / rows.length).toFixed(2)}`);
  console.log(`\n■ 型ごとの件数（1組に複数）と場面ごと`);
  console.log(["型", "全体", ...SCENES.map((s) => REPLY_SCENE_JA[s])].join(" | "));
  console.log(["(組の数)", String(rows.length), ...SCENES.map((s) => String(byScene.get(s)?.length ?? 0))].join(" | "));
  const typeCount = (list: typeof rows, t: DiffType) => list.filter((r) => r.diff.types.includes(t)).length;
  for (const t of [...DIFF_TYPES].sort((a, b) => typeCount(rows, b) - typeCount(rows, a))) {
    console.log([DIFF_TYPE_JA[t], `${typeCount(rows, t)}(${pct(typeCount(rows, t), rows.length)})`, ...SCENES.map((s) => String(typeCount(byScene.get(s) ?? [], t)))].join(" | "));
  }
  console.log(["完全一致", String(rows.filter((r) => r.diff.same).length), ...SCENES.map((s) => String((byScene.get(s) ?? []).filter((r) => r.diff.same).length))].join(" | "));
  console.log(["似ている度", (rows.reduce((a, r) => a + r.diff.sim, 0) / rows.length).toFixed(2), ...SCENES.map((s) => { const l = byScene.get(s) ?? []; return l.length ? (l.reduce((a, r) => a + r.diff.sim, 0) / l.length).toFixed(2) : "-"; })].join(" | "));

  // 表面だけの差（芯が同じ）の内訳
  const surf = rows.filter((r) => !r.diff.same && r.diff.sameCore);
  console.log(`\n■ 表面だけ違う（芯は同じ）${surf.length}組の型: ` + DIFF_TYPES.map((t) => [t, surf.filter((r) => r.diff.types.includes(t)).length] as const).filter(([, n]) => n).map(([t, n]) => `${DIFF_TYPE_JA[t]} ${n}`).join("・"));

  // 書き方の多数派（スタッフの全送信 vs AI の下書き）
  const staffAll = msgs.filter((m) => m.sender === "staff" && !m.is_aix_generated && !isTestConversation(m.conversation_id) && (m.text ?? "").trim().length > 3);
  const style = (texts: string[]) => {
    const n = texts.length || 1;
    const op = new Map<string, number>(); for (const t of texts) { const k = OPENER_JA[openerKindOf(t)]; op.set(k, (op.get(k) ?? 0) + 1); }
    const ks = { 頂: [0, 0], 下さい: [0, 0], 致し: [0, 0], 出来: [0, 0], 御見積: [0, 0] } as Record<string, [number, number]>;
    for (const t of texts) { const k = kanaStyleOf(t); for (const key of Object.keys(k)) { if (k[key] === "kanji") ks[key][0]++; else if (k[key] === "kana") ks[key][1]++; } }
    const ex = texts.map(exclaimOf); const em = texts.map(emojisOf); const nl = texts.map(newlineOf);
    return {
      n: texts.length,
      opener: [...op].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}${pct(v, n)}`).join(" "),
      kana: Object.entries(ks).filter(([, v]) => v[0] + v[1] >= 5).map(([k, v]) => `${k}:漢${pct(v[0], v[0] + v[1])}`).join(" "),
      double: (ex.reduce((a, e) => a + e.double, 0) / n).toFixed(2), single: (ex.reduce((a, e) => a + e.single, 0) / n).toFixed(2),
      emoji: (em.reduce((a, e) => a + e.length, 0) / n).toFixed(2), emojiAny: pct(em.filter((e) => e.length).length, n),
      lines: (nl.reduce((a, e) => a + e.lines, 0) / n).toFixed(1), blank: pct(nl.filter((e) => e.blank).length, n),
      osewa: pct(texts.filter((t) => /お世話になっております/.test(t)).length, n),
      len: Math.round(texts.reduce((a, t) => a + t.length, 0) / n),
    };
  };
  console.log(`\n■ 書き方の多数派（S=組のスタッフの文・D=組の AI の下書き・H=期間のスタッフの全送信）`);
  const show = (label: string, st: ReturnType<typeof style>) => console.log(`  ${label} n=${st.n} 冒頭[${st.opener}] 表記[${st.kana}] ！！${st.double}/文 ！${st.single}/文 絵文字${st.emoji}/文(${st.emojiAny}) 行${st.lines} 空行あり${st.blank} お世話に${st.osewa} 長さ${st.len}`);
  show("H 全体", style(staffAll.map((m) => m.text!)));
  for (const s of SCENES) {
    const l = byScene.get(s) ?? []; if (l.length < 5) continue;
    console.log(` [${REPLY_SCENE_JA[s]}]`); show("S", style(l.map((r) => r.staff))); show("D", style(l.map((r) => r.draft)));
  }

  // 足した・消した文の多い形（芯の頭20字でまとめる）
  const tally = (key: "added" | "removed") => {
    const m = new Map<string, { n: number; ex: string; scenes: Set<string> }>();
    for (const r of rows) for (const x of r.diff.detail[key]) {
      const k = x.normalize("NFKC").replace(/[\p{Extended_Pictographic}\u{FE0F}！!？?\s]/gu, "").replace(/[0-9]+/g, "#").slice(0, 16);
      const v = m.get(k) ?? { n: 0, ex: x, scenes: new Set() }; v.n++; v.scenes.add(REPLY_SCENE_JA[r.scene]); m.set(k, v);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 25);
  };
  console.log(`\n■ スタッフだけの文（足した）の多い形`); for (const v of tally("added")) console.log(`  ${v.n} [${[...v.scenes].join(",")}] ${v.ex.slice(0, 80)}`);
  console.log(`\n■ AI だけの文（消した）の多い形`); for (const v of tally("removed")) console.log(`  ${v.n} [${[...v.scenes].join(",")}] ${v.ex.slice(0, 80)}`);

  // 小場面（reply-subscene）× 一致（スタッフだけが知る報告＝③ は外す）: 100% に届いたか
  const rowsT = rows.filter((r) => !r.staffOnly);
  console.log(`
■ 小場面ごと（返信の番・③スタッフだけが知る報告 ${rows.length - rowsT.length}組を外した ${rowsT.length}組）★＝完全一致が n に届いた`);
  const subs = new Map<string, typeof rowsT>();
  for (const r of rowsT) { const k = subSceneOf({ customerText: r.customer, prevStaffText: r.prev ?? "", scene: r.scene }); if (!subs.has(k)) subs.set(k, []); subs.get(k)!.push(r); }
  for (const [k, l] of [...subs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const same = l.filter((x) => x.diff.same).length;
    const types = DIFF_TYPES.map((t) => [t, l.filter((x) => x.diff.types.includes(t)).length] as const).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${DIFF_TYPE_JA[t]}${n}`).join(" ");
    console.log(`  ${same === l.length ? "★" : "　"} ${k.padEnd(30)} n=${String(l.length).padStart(3)} 完全 ${same}/${l.length}・近い ${l.filter((x) => x.diff.same || x.diff.sim >= 0.8).length}・似 ${(l.reduce((a, x) => a + x.diff.sim, 0) / l.length).toFixed(2)}  ${types}`);
  }
  mkdirSync("scripts/.replay-out", { recursive: true });
  writeFileSync(OUT, rows.map((r) => JSON.stringify({ src: r.src, cid: r.cid.slice(0, 8), at: r.at, scene: r.scene, sub: subSceneOf({ customerText: r.customer, prevStaffText: r.prev ?? "", scene: r.scene }), staffOnly: r.staffOnly, tpo: r.tpo, watch: r.watchVerdict, watchReason: r.watchReason, customer: r.customer.slice(0, 300), draft: r.draft, staff: r.staff, types: r.diff.types, sim: r.diff.sim, added: r.diff.detail.added, removed: r.diff.detail.removed, para: r.diff.detail.paraphrase, opener: r.diff.detail.opener, emoji: r.diff.detail.emoji, kana: r.diff.detail.kana })).join("\n"));
  console.log(`\n書き出し: ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
