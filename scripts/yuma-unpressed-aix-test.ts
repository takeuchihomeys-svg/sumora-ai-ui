// scripts/yuma-unpressed-aix-test.ts — 押されない AIX（保証会社について／物件を探す／内覧挨拶）の文を、本番の過去の番で作り直してスタッフの手打ちと比べる
//
// 2026-10-07 竹内「文の質をあげてボタンとしてつかっていく」「設計知見と協力して改善する」（AIX の判断のずれの調査で、提案されても押されない3種）
//   本番の番（ブレインが提案した番・スタッフが手で答えた番）を読み（読むだけ）、申込の書類の手前で切り、名前は YUMA・番号は伏せ、
//   開発サーバの /api/aix/action に YUMA の会話として渡す（送らない・DB に書くのは aix_generate_log の YUMA の行だけ）。
//   近さ = スタッフの手打ちとの2文字の重なり（Dice）。固定の文（LLM なし）と「会話を合わせる」（LLM）を分けて出す。
//
// 実行（手順書 memory/test_protocol_brain.md）:
//   LLM_TEST_MODE=deepseek-all LINE_STAFF_GROUP_ID=invalid … npx next dev --webpack -p 3471   ← 開発サーバ
//   LLM_TEST_MODE=deepseek-all SIM_BASE=http://localhost:3471 npx tsx --env-file=.env.local scripts/yuma-unpressed-aix-test.ts [--only=g,ps,gv] [--n=1] [--out=<json>]
//   最後: LLM_TEST_FINAL_CLAUDE=1 で起動し直して --n=1
import { requireTestServer } from "./lib/dev-server-test-guard";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { cutBeforeApplicationMaterial } from "../app/lib/test-pii-guard";
import { maskPII } from "../app/lib/pii-mask";
import { YUMA_CONVERSATION_ID as Y } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const BASE = process.env.SIM_BASE ?? "http://localhost:3471";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg("n", "1"));
const ONLY = arg("only", "g,ps,gv").split(",");
const OUT = arg("out");

type Scene = {
  key: string; group: "g" | "ps" | "gv"; label: string;
  /** スタッフの手打ちの文の一部（この文を「人」として比べる・その直前までを会話に） */
  staffMatch: string; day: string;
  action: string; body: Record<string, unknown>;
  /** 固定（LLM なし）と会話を合わせる（LLM）の両方を回す */
  both?: boolean;
};
const SCENES: Scene[] = [
  // ── 保証会社について（お客様の「保証会社どこですか」への答え・ブレインが guarantor_info を提案した番を含む）
  { key: "g_napp", group: "g", label: "保証会社 1件（ナップ・独立系）", staffMatch: "保証会社はナップ賃貸保証となります", day: "2026-09-30",
    action: "guarantor_info", both: true, body: { properties: [{ name: "レジュールアッシュ北大阪GRAND STAGE", company: "ナップ", type: "independent" }], parallel: false } },
  { key: "g_casa", group: "g", label: "保証会社 1件（Casa・独立系）", staffMatch: "株式会社Casaという独立系", day: "2026-08-22",
    action: "guarantor_info", both: true, body: { properties: [{ name: "エスポワール", company: "Casa", type: "independent" }], parallel: false } },
  { key: "g_2ban", group: "g", label: "保証会社 1件・1番手/2番手（シノケン・ほっと保証）", staffMatch: "1番手の保証会社はシノケン", day: "2026-09-25",
    action: "guarantor_info", both: true, body: { properties: [{ name: "ハーモニーテラス今林 202号室", company: "シノケンコミュニケーションズ", type: "independent" }, { name: "ハーモニーテラス今林 202号室", company: "ほっと保証", type: "independent" }], parallel: false } },
  { key: "g_kowa", group: "g", label: "保証会社 1件（興和アシスト・種類は不明）＋ブラックでも通るか", staffMatch: "保証会社興和アシスト", day: "2026-10-04",
    action: "guarantor_info", both: true, body: { properties: [{ name: "H-maison大正VII 106号室", company: "興和アシスト", type: "unknown" }], parallel: false } },
  { key: "g_els", group: "g", label: "保証会社 1件・2社（エルズ・日本セーフティ）＋きついですか", staffMatch: "保証会社はエルズサポートと日本セーフティ", day: "2026-06-01",
    action: "guarantor_info", both: true, body: { properties: [{ name: "マンションサンパール", company: "エルズサポート", type: "independent" }, { name: "マンションサンパール", company: "日本セーフティー", type: "independent" }], parallel: false } },
  // ── 物件を探す（条件を受けて「ピックアップしお送りさせて頂きます」の約束）
  { key: "ps_yuko", group: "ps", label: "物件を探す（わがままですみません→受けて探す）", staffMatch: "ご満足頂くお部屋でご入居頂くのが1番です", day: "2026-09-17",
    action: "property_search", body: {} },
  { key: "ps_noguchi", group: "ps", label: "物件を探す（家賃を上げて再ピックアップ）", staffMatch: "家賃をもう少し上げたご条件で、中央区・浪速区全域から", day: "2026-09-27",
    action: "property_search", body: {} },
  { key: "ps_yuito", group: "ps", label: "物件を探す（10月後半入居を優先）", staffMatch: "豊中市内全域から、10月後半ご入居可能なお部屋を優先して", day: "2026-10-04",
    action: "property_search", body: {} },
  { key: "ps_miou", group: "ps", label: "物件を探す（大国町・1K 7畳以上）", staffMatch: "大国町エリアで1K・7畳以上のお部屋を新たにピックアップ", day: "2026-09-27",
    action: "property_search", body: {} },
  { key: "ps_matsuura", group: "ps", label: "物件を探す（ペット可・なんば梅田に出やすい）", staffMatch: "ペット可のお部屋を中心に、なんば・梅田に出やすいエリアから", day: "2026-09-30",
    action: "property_search", body: {} },
  // ── 内覧挨拶（当日の内覧前・内覧後）
  { key: "gv_b1", group: "gv", label: "内覧前（15時）", staffMatch: "本日15時にお部屋ご案内させて頂きます", day: "2026-10-06",
    action: "greeting_viewing", body: { sub_mode: "before", viewing_time: "15:00" } },
  { key: "gv_b2", group: "gv", label: "内覧前（16時）", staffMatch: "本日16時お部屋ご案内させて頂きます", day: "2026-10-05",
    action: "greeting_viewing", body: { sub_mode: "before", viewing_time: "16:00" } },
  { key: "gv_b3", group: "gv", label: "内覧前（13時）", staffMatch: "本日13時お部屋ご案内させて頂きます", day: "2026-10-01",
    action: "greeting_viewing", body: { sub_mode: "before", viewing_time: "13:00" } },
  { key: "gv_a1", group: "gv", label: "内覧後（申込誘導）", staffMatch: "お気に召されましたらお申込しお部屋抑えさせて頂きます！！", day: "2026-09-19",
    action: "greeting_viewing", body: { sub_mode: "after", after_type: "apply_guide" } },
  { key: "gv_a2", group: "gv", label: "内覧後（新着を探す）", staffMatch: "引き続き2DK以上のマンションタイプのお部屋で", day: "2026-10-05",
    action: "greeting_viewing", body: { sub_mode: "after", after_type: "search_new" } },
];

const norm = (s: string) => s.replace(/\s+/g, "");
function dice(a: string, b: string): number {
  const g = (s: string) => { const m = new Map<string, number>(); const t = norm(s); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = g(a), B = g(b); let inter = 0, tot = 0;
  for (const [k, v] of A) { inter += Math.min(v, B.get(k) ?? 0); tot += v; }
  for (const [, v] of B) tot += v;
  return tot ? (2 * inter) / tot : 0;
}

type Msg = { sender: string; text: string; created_at: string; is_aix_generated: boolean | null };
/** 呼びかけ（「〇〇さん」）と表示名を YUMA に、番号・メールは伏せる */
function maskWith(names: string[]) {
  return (t: string) => {
    let s = t;
    for (const n of names.filter((x) => x && x.length >= 1).sort((a, b) => b.length - a.length)) s = s.split(`${n}さん`).join("YUMAさん").split(`${n}様`).join("YUMA様");
    s = s.replace(/(^|\n)([^\s、。！？!?\n【】「」（）・]{1,10})さん(?=[\n⏎お本！!、ご]|$)/g, (_m, a: string) => `${a}YUMAさん`);
    return maskPII(s, names);
  };
}

async function buildScene(sc: Scene): Promise<{ recent: Array<Record<string, unknown>>; staff: string; customer: string } | null> {
  const dayStart = `${sc.day}T00:00:00+09:00`, dayEnd = `${sc.day}T23:59:59+09:00`;
  const { data: hits } = await sb.from("messages").select("conversation_id, created_at, text").neq("sender", "customer").ilike("text", `%${sc.staffMatch}%`).gte("created_at", new Date(dayStart).toISOString()).lte("created_at", new Date(dayEnd).toISOString()).limit(1);
  const hit = (hits ?? [])[0] as { conversation_id: string; created_at: string; text: string } | undefined;
  if (!hit) { console.warn(`[${sc.key}] 実送信が見つからない`); return null; }
  const { data: conv } = await sb.from("conversations").select("customer_name").eq("id", hit.conversation_id).single();
  const { data: prev } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", hit.conversation_id).lt("created_at", hit.created_at).order("created_at", { ascending: false }).limit(14);
  const rows = ((prev ?? []) as Msg[]).reverse().filter((m) => m.text);
  const cut = cutBeforeApplicationMaterial(rows);
  // 呼び名: スタッフが行頭で呼んだ名前（「Sさん」等）と表示名
  const called = new Set<string>([String((conv as { customer_name?: string } | null)?.customer_name ?? "").trim()]);
  for (const m of [...rows, { sender: "staff", text: hit.text } as Msg]) if (m.sender !== "customer") { const mm = /^([^\s、。！？\n【】「」（）・]{1,10})さん/.exec(m.text ?? ""); if (mm) called.add(mm[1]); }
  for (const n of [...called]) for (const part of n.split(/[\s　]+/)) if (part.length >= 1) called.add(part);   // 表示名「野口 太郎」の姓だけの呼びかけも
  const mask = maskWith([...called].filter(Boolean));
  const shift = Date.now() - 60_000 - Date.parse(hit.created_at);   // 実送信の1分前＝今
  const recent = cut.kept.map((m) => {
    const at = new Date(Date.parse(m.created_at) + shift).toISOString();
    return { sender: m.sender === "customer" ? "customer" : "staff", text: mask(m.text), createdAt: at, rawCreatedAt: at, isAix: !!m.is_aix_generated };
  });
  const lastCustomer = [...recent].reverse().find((m) => m.sender === "customer");
  return { recent, staff: mask(hit.text), customer: String(lastCustomer?.text ?? "") };
}

async function gen(sc: Scene, recent: Array<Record<string, unknown>>, extra: Record<string, unknown>): Promise<{ text: string; ms: number; notice?: string; error?: string }> {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/aix/action`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: sc.action, account: "sumora", conversation_id: Y, customer_name: "YUMA", recent_messages: recent, ...sc.body, ...extra }),
    signal: AbortSignal.timeout(240_000),
  });
  const j = await r.json().catch(() => ({})) as { ok?: boolean; message_text?: string; notice?: string; error?: string };
  return { text: String(j.message_text ?? ""), ms: Date.now() - t0, notice: j.notice, error: j.ok === false || !r.ok ? String(j.error ?? `HTTP ${r.status}`) : undefined };
}

async function main() {
  await requireTestServer(BASE, "yuma-unpressed-aix-test");
  const out: Array<Record<string, unknown>> = [];
  for (const sc of SCENES.filter((s) => ONLY.includes(s.group) || ONLY.includes(s.key))) {
    const b = await buildScene(sc);
    if (!b) continue;
    console.log(`\n━━━━ ${sc.label}（${sc.key}）\n客: ${b.customer.replace(/\n/g, "⏎").slice(0, 140)}\n人: ${b.staff.replace(/\n/g, "⏎")}`);
    const modes: Array<[string, Record<string, unknown>]> = sc.both ? [["固定", { conversation_match: false }], ["会話", { conversation_match: true }]] : [["", {}]];
    for (const [mode, extra] of modes) {
      for (let i = 0; i < N; i++) {
        const g = await gen(sc, b.recent, extra);
        const sim = g.error ? 0 : dice(g.text, b.staff);
        console.log(`AI${mode ? `(${mode})` : ""}#${i + 1} 近さ=${sim.toFixed(2)} ${g.ms}ms${g.error ? ` ✖ ${g.error}` : ""}${g.notice ? ` ⚠ ${g.notice.replace(/\n/g, " ").slice(0, 80)}` : ""}\n   ${g.text.replace(/\n/g, "⏎")}`);
        out.push({ key: sc.key, group: sc.group, mode, i, sim, text: g.text, staff: b.staff, error: g.error ?? null });
      }
    }
  }
  const by = new Map<string, number[]>();
  for (const r of out) { const k = `${r.group}${r.mode ? `:${r.mode}` : ""}`; by.set(k, [...(by.get(k) ?? []), Number(r.sim)]); }
  console.log("\n== 近さの平均（スタッフの手打ち）");
  for (const [k, v] of by) console.log(`  ${k}: ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)}（${v.length}回・失敗 ${out.filter((r) => `${r.group}${r.mode ? `:${r.mode}` : ""}` === k && r.error).length}）`);
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
