// scripts/read-check-sheet.ts — 「Claude が一通を読む細かさ」を物差しにした点検の手順（読むだけ・LLM なし・API 費用0）
//
// 2026-11-22 作業員K2（台帳 #441・竹内さんの決定 11/13 KB 54461655「Claude が一通を読む細かさを物差しにして、ブレインの読み・届け・文の組み立てで
//   細分化できていない所・具体的でない所・強化できていない所を見つけ続けて強化する」・P0 ecd7b961「一通を両側から細かく読む」）。
//   ブレインの欄の粗さはブレイン自身の出力からは見えない＝細かく読める読み手（Claude のセッション）が同じ番を読んで並べる。
//
// 回し方（毎週・毎朝の拾い上げ #41 と同じ回し方に入れる）:
//   ① --phase=build: 竹内さん本人が答えた番を選び、1番1枚の読みの紙（伏せた会話・ブレインの記録の要点・ブレインと書き手に届いた材料の塊の名前・
//      下書き・竹内さんの実送信）と、空の印の表（marks.json）を書く（DB は読むだけ・LLM なし）。紙は scratchpad に置く（伏せた会話が入る＝倉庫に上げない）
//   ② Claude のセッションで紙を1枚ずつ読み、印の表に4つの抜けを付ける（API 費用0）:
//      none_stage  … 無い段: 竹内さんが読んで使った事に、ブレインの欄がそもそも無い（例: 誰に向けた言葉か・気持ちの向き）
//      coarse      … 粗い段: 欄はあるが粗い（例: 物件は合っているが号室・どの点か が無い）
//      not_reached … 届かない欄: ブレインは読めているのに、書き手（下書き）に届いていない（材料の塊の名前に無い・下書きに出ていない）
//      unused      … 使われない欄: 書き手に届いているのに、文に使われていない
//      各印は { kind, field（欄の名前・自由）, note（短く・お客様の文や名前を入れない） }
//   ③ --phase=apply --marks=<marks.json>: 欄ごと・種類ごとに数え、弱い所の台帳（brain_weaknesses）に key=read-check:<kind>:<field> で足す（同じ鍵は回数を足す）
//
// 実行:
//   npx tsx --env-file=<鍵の .env> scripts/read-check-sheet.ts --phase=build [--days=3] [--n=10] [--out=<scratchpad のフォルダ>]
//   npx tsx --env-file=<鍵の .env> scripts/read-check-sheet.ts --phase=apply --marks=<marks.json> [--dry]
// 個人情報: 会話は maskPII と名前の置き換え（〇〇さん）を通す。台帳には欄の名前と数・番の id だけ（お客様の文・名前は入れない）。YUMA・テストの会話は外す
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { maskPII } from "../app/lib/pii-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const PHASE = arg("phase", "build");
export const MARK_KINDS = ["none_stage", "coarse", "not_reached", "unused"] as const;
export type MarkKind = typeof MARK_KINDS[number];
export type Mark = { kind: MarkKind; field: string; note?: string };
export type SheetMarks = { turnId: number; conv8: string; marks: Mark[] };
const KIND_JA: Record<MarkKind, string> = { none_stage: "無い段", coarse: "粗い段", not_reached: "届かない欄", unused: "使われない欄" };

const nameMask = (t: string) => maskPII(String(t ?? "")).replace(/[A-Za-z0-9_-]+さん|[^\s！!、。「」]{1,6}さん/g, "〇〇さん").replace(/\s+/g, " ").trim();

/** 印の表を数える（純関数・テスト用に export） */
export function tallyMarks(sheets: ReadonlyArray<SheetMarks>): Array<{ key: string; kind: MarkKind; field: string; n: number; turns: number[] }> {
  const m = new Map<string, { key: string; kind: MarkKind; field: string; n: number; turns: number[] }>();
  for (const s of sheets) for (const mk of s.marks ?? []) {
    if (!MARK_KINDS.includes(mk.kind)) continue;
    const field = String(mk.field ?? "").trim().replace(/\s+/g, "_").slice(0, 40) || "unknown";
    const key = `read-check:${mk.kind}:${field}`;
    const x = m.get(key) ?? { key, kind: mk.kind, field, n: 0, turns: [] };
    x.n++; if (!x.turns.includes(s.turnId)) x.turns.push(s.turnId);
    m.set(key, x);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

async function build() {
  const days = Number(arg("days", "3")), n = Number(arg("n", "10"));
  const out = arg("out", "");
  if (!out) throw new Error("--out=<scratchpad のフォルダ> が要る（伏せた会話が入る紙を倉庫の外に置く）");
  mkdirSync(out, { recursive: true });
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: turns, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, staff_first_at, staff_texts, staff_aix, draft_first, scene_key, verdict, brain_action, brain_reply_mode, materials")
    .gte("customer_turn_at", since).not("staff_first_at", "is", null).order("customer_turn_at", { ascending: false }).limit(n * 8);
  if (error) throw new Error(error.message);
  const sheets: string[] = []; const marks: SheetMarks[] = [];
  for (const t of (turns ?? []) as Array<Record<string, any>>) {
    if (marks.length >= n) break;
    if (isTestConversation(t.conversation_id)) continue;
    // 竹内さん本人が答えた番だけ（その番の後の最初のこちらの手打ちの通の書き手）
    const { data: first } = await sb.from("messages").select("staff_writer, text, created_at").eq("conversation_id", t.conversation_id).neq("sender", "customer").gt("created_at", t.customer_turn_at).order("created_at").limit(4);
    const tk = ((first ?? []) as Array<{ staff_writer: string | null; text: string | null }>).filter((x) => x.text);
    if (!tk.length || tk[0].staff_writer !== "takeuchi") continue;
    const { data: ctx } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", t.conversation_id).lte("created_at", t.customer_turn_at).order("created_at", { ascending: false }).limit(8);
    if (((ctx ?? []) as Array<{ text: string | null }>).some((m) => /【お申込者様記入欄】/.test(m.text ?? ""))) continue; // 申込以降は対象外
    const { data: bd } = await sb.from("brain_decision_logs").select("digest, created_at").eq("conversation_id", t.conversation_id).lte("created_at", t.staff_first_at).order("created_at", { ascending: false }).limit(1);
    const dg = ((bd ?? [])[0] as { digest?: Record<string, unknown> } | undefined)?.digest ?? {};
    const mat = (t.materials ?? {}) as { brain?: { blocks?: unknown }; reply?: { fetched?: unknown; spec?: unknown } };
    const L: string[] = [];
    L.push(`## 番 ${t.id}（会話 ${String(t.conversation_id).slice(0, 8)}・お客様 ${String(t.customer_turn_at).slice(0, 16)}・場面 ${t.scene_key ?? "-"}・見張りの判定 ${JSON.stringify(t.verdict)}）`, "");
    L.push("### 会話（古い順・伏せた）");
    for (const m of ((ctx ?? []) as Array<{ sender: string; text: string | null; image_url: string | null; is_aix_generated: boolean | null }>).reverse()) L.push(`- [${m.sender === "customer" ? "客" : m.is_aix_generated ? "AIX" : "店"}] ${m.image_url && !m.text ? "[画像]" : nameMask(m.text ?? "").slice(0, 220)}`);
    L.push("", "### ブレインの記録の要点（brain_decision_logs.digest）");
    L.push("```json", JSON.stringify(dg, null, 0).slice(0, 2500), "```");
    L.push("", `### 届いた材料の塊の名前: ブレイン ${JSON.stringify(mat.brain?.blocks ?? null).slice(0, 600)}・書き手 ${JSON.stringify(mat.reply?.fetched ?? null).slice(0, 600)}`);
    L.push("", `### 道: ブレイン ${t.brain_reply_mode ?? "-"}／${t.brain_action ?? "-"}・竹内さん AIX ${JSON.stringify((t.staff_aix ?? []).map((a: { aix_type?: string }) => a.aix_type))}`);
    L.push("", "### 下書き（最初）", nameMask(String(t.draft_first ?? "")).slice(0, 600) || "（無し）");
    L.push("", "### 竹内さんの実送信", ...tk.slice(0, 3).map((x) => `- ${nameMask(x.text ?? "").slice(0, 400)}`), "", "---", "");
    sheets.push(L.join("\n"));
    marks.push({ turnId: t.id, conv8: String(t.conversation_id).slice(0, 8), marks: [] });
  }
  writeFileSync(join(out, "read-check-sheets.md"), `# 読みの細かさの点検の紙（${new Date().toISOString().slice(0, 10)}・${marks.length}番）\n\n印の種類: ${MARK_KINDS.map((k) => `${k}=${KIND_JA[k]}`).join("・")}\n\n${sheets.join("\n")}`);
  writeFileSync(join(out, "read-check-marks.json"), JSON.stringify(marks, null, 1));
  console.log(`紙 ${marks.length}番 → ${join(out, "read-check-sheets.md")}／印の表 → ${join(out, "read-check-marks.json")}`);
}

async function apply() {
  const sheets = JSON.parse(readFileSync(arg("marks"), "utf8")) as SheetMarks[];
  const rows = tallyMarks(sheets);
  const dry = process.argv.includes("--dry");
  const now = new Date().toISOString();
  for (const r of rows) {
    console.log(`${KIND_JA[r.kind]}｜${r.field}｜${r.n}回（番 ${r.turns.join(",")}）`);
    if (dry) continue;
    const { data: cur } = await sb.from("brain_weaknesses").select("id, occurrences, evidence").eq("key", r.key).maybeSingle();
    const ev = { source: "read-check（#441・Claude が読む細かさの点検）", kind: r.kind, field: r.field, turns: r.turns.slice(0, 20) };
    if (cur) await sb.from("brain_weaknesses").update({ occurrences: Number((cur as { occurrences?: number }).occurrences ?? 0) + r.n, last_seen: now, updated_at: now, evidence: { ...(((cur as { evidence?: Record<string, unknown> }).evidence) ?? {}), ...ev } }).eq("id", (cur as { id: number }).id);
    else await sb.from("brain_weaknesses").insert({ key: r.key, title: `読みの細かさの点検: ${KIND_JA[r.kind]}（${r.field}）`, area: "brain", symptom: `Claude の読みと並べて ${KIND_JA[r.kind]}（${r.field}）が ${r.n}回`, status: "open", occurrences: r.n, first_seen: now, last_seen: now, evidence: ev });
  }
  console.log(`${dry ? "（下見）" : ""}弱い所の台帳へ ${rows.length}行`);
}

if (process.argv[1]?.includes("read-check-sheet")) (PHASE === "apply" ? apply() : build()).catch((e) => { console.error(e); process.exit(1); });
