// scripts/feeling-conductor-count.ts — 気持ち・状況の表（feeling-conductor-table）どおりに統括が選べたかを竹内さんの番で数える（読むだけ・LLM なし・費用0）
//   2026-11-15 作業員I（統括の土台③・設計図 memory/design_docs/feeling_conductor_linkage_1115.md の段5）
//   竹内さんの番＝line_watch_turns の番のうち、その番のスタッフの送信（返信・AIX）に竹内さん本人（messages.staff_writer=takeuchi）が入っている番。申込以降・対象外の番は外す
//   読み＝その番のブレインの記録（brain_decision_logs.digest.ms＝気持ちの状態|不安の向き|迷い・q＝問い）。強さ（latent）は digest に無い＝強さ3の行は当たらない（材料が届いていない・報告に出す）
//   状況＝その番より前の aix_usage_logs（御見積書の数・待ち合わせ場所を送ったか）
//   比べる: ①重点（conductor-focus.focusOfTakeuchiTurn）②一手の強さ（next-move-types.nextMoveFromText の強さ → 押す/添える/待つ/引く）④次に送る物（AIX の種類・申込で抑える）
//   「？」の行（興味が薄い・不満・離れかけ・家族に相談）: 竹内さんの一手の分布を出し、5番以上で6割以上そろえば案・そろわなければ推奨つきの問いの案
// 実行（DB を読む＝営業時間 9〜22時は避ける）: npx tsx --env-file=<鍵の .env> scripts/feeling-conductor-count.ts [--days=60] [--out=<md>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { decideFromFeeling, FEELING_ROWS, OPEN_ROWS, PUSH_LEVEL_JA, type PushLevel, type FeelingDecision } from "../app/lib/feeling-conductor-table";
import { focusOfTakeuchiTurn, FOCUS_LABEL, type Focus } from "../app/lib/conductor-focus";
import { nextMoveFromText, type NextStrength } from "../app/lib/next-move-types";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60"));
const OUT = arg("out");

type Turn = { conversation_id: string; customer_turn_at: string; customer_last_at: string | null; scene_key: string | null; staff_texts: Array<{ at: string; text: string | null }> | null; staff_aix: Array<{ at: string; aix_type: string }> | null };
type Brain = { at: number; ms: string | null; q: string[] };
type Aix = { at: number; t: string };

/** 竹内さんの一手の強さ（文から・網）→ 表の言葉 */
export const STRENGTH_TO_PUSH: Record<NextStrength, PushLevel> = { strong: "push", invite: "add", together: "add", door: "wait", none: "pull" };
/** 申込以降は対象外（project_post_apply_out_of_scope）: 申込・審査・契約の場面の番を外す網 */
const POST_APPLY_RE = /対象外|申込済|審査中|契約/;

export type CountRow = { id: string; read: string; n: number; focus: [number, number]; push: [number, number]; next: [number, number]; ex: string[] };
export type OpenTally = { id: string; read: string; n: number; acts: Record<string, number> };

/** 1番を比べる（純関数・テストできる形） */
export function compareTurn(d: FeelingDecision, act: { route: "aix" | "reply"; aixTypes: string[]; text: string }): { focus: boolean | null; push: boolean | null; next: boolean | null; tkFocus: Focus | null; tkPush: PushLevel } {
  const aix0 = act.aixTypes[0] ?? null;
  const tkFocus = focusOfTakeuchiTurn({ route: act.route, aixType: aix0, text: act.text });
  const nm = nextMoveFromText(act.text);
  const tkPush = act.route === "aix" && !act.text.trim() ? "add" : STRENGTH_TO_PUSH[nm.strength];
  const next = d.next == null ? null
    : d.next.aix ? act.aixTypes.includes(d.next.aix)
    : d.next.dest === "apply" ? (nm.dest === "apply" || act.aixTypes.includes("application_push"))
    : d.next.dest ? nm.dest === d.next.dest : null;
  return { focus: d.focus ? tkFocus === d.focus : null, push: d.push ? tkPush === d.push : null, next, tkFocus, tkPush };
}

const actLabel = (act: { route: "aix" | "reply"; aixTypes: string[]; text: string }) => {
  if (act.route === "aix") return `AIX:${act.aixTypes[0]}`;
  const nm = nextMoveFromText(act.text);
  return `返信:${nm.dest}/${PUSH_LEVEL_JA[STRENGTH_TO_PUSH[nm.strength]]}`;
};

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const turns: Turn[] = [];
  for (let f = 0; ; f += 1000) {
    const r = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, scene_key, staff_texts, staff_aix").gte("customer_turn_at", since).order("id").range(f, f + 999);
    if (r.error) throw new Error(r.error.message);
    turns.push(...((r.data ?? []) as Turn[]));
    if ((r.data ?? []).length < 1000) break;
  }
  const withStaff = turns.filter((t) => (t.staff_texts?.length || t.staff_aix?.length) && !POST_APPLY_RE.test(t.scene_key ?? ""));
  const convIds = [...new Set(withStaff.map((t) => t.conversation_id))];
  const tkAt = new Map<string, number[]>(), brains = new Map<string, Brain[]>(), aixs = new Map<string, Aix[]>();
  const push = <T,>(m: Map<string, T[]>, k: string, v: T) => { const a = m.get(k) ?? []; a.push(v); m.set(k, a); };
  for (let i = 0; i < convIds.length; i += 100) {
    const ids = convIds.slice(i, i + 100);
    const [tk, bd, au] = await Promise.all([
      sb.from("messages").select("conversation_id, created_at").in("conversation_id", ids).eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).limit(5000),
      sb.from("brain_decision_logs").select("conversation_id, created_at, digest").in("conversation_id", ids).gte("created_at", since).limit(20000),
      sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type, sent_at").in("conversation_id", ids).limit(20000),
    ]);
    for (const e of [tk.error, bd.error, au.error]) if (e) throw new Error(e.message);
    for (const r of (tk.data ?? []) as Array<{ conversation_id: string; created_at: string }>) push(tkAt, r.conversation_id, Date.parse(r.created_at));
    for (const r of (bd.data ?? []) as Array<{ conversation_id: string; created_at: string; digest: { ms?: string; q?: string[] } | null }>) push(brains, r.conversation_id, { at: Date.parse(r.created_at), ms: r.digest?.ms ?? null, q: Array.isArray(r.digest?.q) ? r.digest!.q! : [] });
    for (const r of (au.data ?? []) as Array<{ conversation_id: string; created_at: string; aix_type: string | null; sent_at: string | null }>) if (r.aix_type && r.sent_at) push(aixs, r.conversation_id, { at: Date.parse(r.sent_at), t: r.aix_type });
  }

  const rows = new Map<string, CountRow>(FEELING_ROWS.map((r) => [r.id, { id: r.id, read: r.read, n: 0, focus: [0, 0], push: [0, 0], next: [0, 0], ex: [] }]));
  const opens = new Map<string, OpenTally>(OPEN_ROWS.map((r) => [r.id, { id: r.id, read: r.read, n: 0, acts: {} }]));
  let tkTurns = 0, withRead = 0, decided = 0, made = 0, matched = 0;
  const pairs: Record<string, number> = {}; // 2026-11-21 作業員K2: 表の重点 → 竹内さんの重点（前に開いた約束＝見積・確認の AIX が番の前にあるか）
  const states: Record<string, number> = {};
  for (const t of withStaff) {
    const t0 = Date.parse(t.customer_turn_at), t1 = Date.parse(t.customer_last_at ?? t.customer_turn_at);
    const stAts = [...(t.staff_texts ?? []).map((s) => Date.parse(s.at)), ...(t.staff_aix ?? []).map((a) => Date.parse(a.at))];
    const isTk = stAts.some((a) => (tkAt.get(t.conversation_id) ?? []).some((x) => Math.abs(x - a) < 15 * 60_000));
    if (!isTk) continue;
    tkTurns++;
    const b = (brains.get(t.conversation_id) ?? []).filter((x) => x.at >= t0 - 60_000 && x.at <= t1 + 30 * 60_000).sort((a, z) => a.at - z.at)[0];
    if (!b?.ms) continue;
    withRead++;
    const [state, anx, hes] = b.ms.split("|");
    states[state || "?"] = (states[state || "?"] ?? 0) + 1;
    const [at, dir] = (anx ?? "").split(":");
    const meta = { customer_mindset: { state: state || null, anxiety: at ? { target: at, direction: dir ?? "" } : null, hesitation: hes || null }, customer_questions: b.q };
    const before = (aixs.get(t.conversation_id) ?? []).filter((x) => x.at < t0);
    const d = decideFromFeeling(meta, { estimatesSent: before.filter((x) => x.t === "estimate_sheet").length, viewing: before.some((x) => x.t === "meeting_place") ? "place_sent" : "none" });
    const act = { route: (t.staff_aix?.length ? "aix" : "reply") as "aix" | "reply", aixTypes: (t.staff_aix ?? []).map((a) => a.aix_type), text: (t.staff_texts ?? []).map((s) => s.text ?? "").join("\n") };
    for (const o of d.open) { const x = opens.get(o)!; x.n++; const k = actLabel(act); x.acts[k] = (x.acts[k] ?? 0) + 1; }
    if (!d.rows.length) continue;
    decided++;
    const c = compareTurn(d, act);
    { const open = before.some((x) => x.t === "estimate_sheet" || x.t === "property_check_result"); const k = `${d.focus ?? "-"} → ${c.tkFocus ?? "-"}${c.tkFocus === "promise_keep" ? `（前に見積・確認の AIX ${open ? "あり" : "なし"}）` : ""}`; pairs[k] = (pairs[k] ?? 0) + 1; }
    for (const id of d.rows) {
      const r = rows.get(id)!; r.n++;
      if (c.focus != null && d.focusFrom === id) { r.focus[1]++; if (c.focus) r.focus[0]++; }
      if (c.push != null && (d.pushFrom ?? "").startsWith(id)) { r.push[1]++; if (c.push) r.push[0]++; }
      if (c.next != null && d.nextFrom === id) { r.next[1]++; if (c.next) r.next[0]++; }
      if (r.ex.length < 3) r.ex.push(`${t.conversation_id.slice(0, 8)}@${t.customer_turn_at.slice(0, 16)} 竹内=${actLabel(act)}・重点 ${c.tkFocus ?? "-"}`);
    }
    for (const v of [c.focus, c.push, c.next]) if (v != null) { made++; if (v) matched++; }
  }
  const pct = (a: number, b: number) => (b ? `${a}/${b}（${Math.round((a / b) * 100)}%）` : "-");
  const L: string[] = [];
  L.push(`# 気持ち・状況の表どおりに選べた割合（竹内さんの番・${DAYS}日・${new Date().toISOString().slice(0, 10)}）`, "");
  L.push(`- 竹内さんの番 ${tkTurns}・その番のブレインの気持ちの記録がある番 ${withRead}・表の行に当たった番 ${decided}`);
  L.push(`- 表が決めた判断のうち竹内さんの一手と合った数: ${pct(matched, made)}`);
  L.push(`- 状態の内訳: ${Object.entries(states).sort((a, z) => z[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  L.push(`- ⚠ 強さ（latent_five/latent_read）は記録の digest に無い＝「審査の不安・強さ3」「刺さっている・強さ3」は数えられない（材料が届いていない）。入居までの日数・内覧の日程も記録に無い（時間が迫る・内覧の段階は近似）`, "");
  L.push("## 行ごと（決定のある行）", "", "| 行 | 読み | 番 | ①重点 | ②強さ | ④次に送る物 | 例 |", "|---|---|---|---|---|---|---|");
  for (const r of rows.values()) L.push(`| ${r.id} | ${r.read} | ${r.n} | ${pct(...r.focus)} | ${pct(...r.push)} | ${pct(...r.next)} | ${r.ex.join("<br>")} |`);
  L.push("", "## 「？」の行（決定が無い）: 竹内さんの一手の分布", "");
  for (const o of opens.values()) {
    const top = Object.entries(o.acts).sort((a, z) => z[1] - a[1]);
    const share = o.n ? (top[0]?.[1] ?? 0) / o.n : 0;
    const verdict = o.n >= 5 && share >= 0.6 ? `案: 「${top[0][0]}」（${top[0][1]}/${o.n}）を表の行にする` : `問いの案（推奨: ${top[0] ? `${top[0][0]}（${top[0][1]}/${o.n}）` : "番が無い"}・型が見えない＝番 ${o.n}${o.n >= 5 ? `・一番多い一手でも ${Math.round(share * 100)}%` : "が5未満"}）`;
    L.push(`- ${o.read}（${o.id}）: 番 ${o.n}・${top.slice(0, 5).map(([k, v]) => `${k} ${v}`).join("／") || "-"} → ${verdict}`);
  }
  L.push("", "## 表の重点 → 竹内さんの重点（行に当たった番）", "", ...Object.entries(pairs).sort((a, z) => z[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`));
  L.push("", `重点の名前: ${Object.entries(FOCUS_LABEL).map(([k, v]) => `${k}=${v}`).join("・")}`);
  const md = L.join("\n");
  if (OUT) { writeFileSync(OUT, md); console.log(`書いた: ${OUT}`); }
  console.log(md);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
