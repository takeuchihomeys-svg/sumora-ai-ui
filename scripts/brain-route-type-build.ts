// scripts/brain-route-type-build.ts — 「返信か AIX かの材料」（app/lib/brain-route-type.ts）の数と手本を作る（LLM なし・費用 0・本番 DB は読むだけ）
//
// 2026-10-14 竹内さん（10/13）「実際の竹内の LINE の判断ができるようにブレインの判断基準の部分も強化する」。物差しは竹内さんの実送信（3b508208）。
// 元: scripts/audit-split-reply-aix.ts --route-out=<jsonl>（番・竹内さんの最初の一手・生の文・指紋）
//   npx tsx --env-file=.env.local scripts/audit-split-reply-aix.ts --days=60 --samples=0 --route-out=scripts/.replay-out/route60.jsonl
//   npx tsx --env-file=.env.local scripts/brain-route-type-build.ts --in=scripts/.replay-out/route60.jsonl [--per-type=14] [--write]
// 竹内さん（staff_writer=takeuchi）の番だけ。申込の書類・個人の値・テスト会話は入れない。名前・電話・メール・URL は伏せる。
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { applicationMaterialReason } from "../app/lib/test-pii-guard";
import { maskPII } from "../app/lib/pii-mask";
import { isAckOnlyTurn } from "../app/lib/ack-topic-scope";
import { routeTypeOf, ROUTE_TYPE_JA, type RouteType, type RouteTypeStat, type RouteExample } from "../app/lib/brain-route-type";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IN = arg("in", "scripts/.replay-out/judge1014/route60.jsonl");
const PER = Number(arg("per-type", "14"));
const WRITE = process.argv.includes("--write");
const OUT = "app/lib/brain-route-type-data.ts";
const AIX_JA: Record<string, string> = {
  物件: "物件ピックアップした／物件オススメ", property_check_result: "物件確認した", estimate_sheet: "見積書送る", viewing_invite: "内覧調整", meeting_place: "待ち合わせ場所",
  application_push: "申込へ", condition_hearing: "条件ヒアリング", cost_explain: "初期費用を説明", cost_breakdown: "初期費用について", phone_call: "電話", guarantor_info: "保証会社について",
  zenryoku_support: "全力サポート", greeting_viewing: "内覧挨拶", followup_revive: "追客フォロー", aix_unlogged: "AIX",
};
const PROMISE_JA: Record<string, string> = { check: "確認", estimate: "見積", pickup: "探す", photo: "撮影" };
type Raw = { conv: string; at: string; writer: string; truth: string; truthFam: string | null; promise: string | null; laterAix: string[]; brain: string; brainKey: string; custRaw: string; prevRaw: string; staffRaw: string; fp: string[] };

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
  const names = ((await sb.from("conversations").select("customer_name").limit(5000)).data ?? []).map((r: { customer_name: string | null }) => (r.customer_name ?? "").trim()).filter((s) => s.length >= 2);
  // 呼び名（〇〇さん・〇〇様）は一覧に無い名前（LINE の表示名と違う呼び名）も伏せる。会社・役割の語は残す
  const KEEP = /^(?:お客|皆|みな|貸主|借主|管理会社|オーナー|大家|ご家族|保証会社|業者|担当|皆々)$/;
  const maskNames = (s: string) => s.replace(/([ぁ-んァ-ヶー一-龯々A-Za-zＡ-Ｚａ-ｚ]{1,8})(さん|様|さま|ちゃん|くん)/g, (m, n: string, h: string) => (KEEP.test(n) ? m : `〇〇${h}`));
  const mask = (s: string) => maskNames(maskPII(String(s ?? ""), names)).replace(/https?:\/\/\S+/g, "〈URL〉").replace(/\s+/g, " ").trim();
  const raws: Raw[] = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const skip: Record<string, number> = {};
  const sk = (k: string) => { skip[k] = (skip[k] ?? 0) + 1; };
  const stats: Partial<Record<RouteType, RouteTypeStat>> = {};
  const cands: RouteExample[] = [];
  for (const r of raws) {
    if (r.writer !== "takeuchi") { sk("竹内さん以外"); continue; }
    if (r.truth === "なし") { sk("何もしない"); continue; }
    if (isTestConversation(r.conv)) { sk("テスト"); continue; }
    if ([r.custRaw, r.staffRaw, r.prevRaw].some((x) => applicationMaterialReason(x))) { sk("申込の書類・個人の値"); continue; }
    const type = routeTypeOf({ customerText: r.custRaw, prevStaffText: r.prevRaw, ackOnly: isAckOnlyTurn(r.custRaw) });
    if (!type) { sk("型なし"); continue; }
    const st = (stats[type] ??= { n: 0, reply: 0, promise: 0, aix: 0 });
    st.n++;
    const isAix = r.truth === "AIX" || r.truth === "2段→AIX";
    if (isAix) st.aix++; else if (r.truth === "2段") st.promise++; else st.reply++;
    const fam = r.truthFam ?? "";
    const actual = isAix ? `AIX【${AIX_JA[fam] ?? fam}】${r.truth === "2段→AIX" ? "（約束の文の後に）" : ""}`
      : r.truth === "2段" ? `約束の返信（${PROMISE_JA[r.promise ?? ""] ?? "約束"}）`
      : "返信";
    const staff = isAix ? "" : Array.from(mask(r.staffRaw)).slice(0, 70).join("");
    const customer = Array.from(mask(r.custRaw)).slice(0, 120).join("");
    if (!customer) { sk("お客様の発言なし"); continue; }
    cands.push({ conv: r.conv, at: r.at, type, customer, prev: Array.from(mask(r.prevRaw)).slice(-60).join(""), actual, staff, fp: r.fp });
  }
  // 型ごとに新しい順・道（返信・約束・AIX）が偏らないように1件ずつ回して PER まで
  const out: RouteExample[] = [];
  const route = (a: string) => (a.startsWith("返信") ? "返信" : a.startsWith("約束") ? "約束" : "AIX");
  for (const t of Object.keys(stats) as RouteType[]) {
    const xs = cands.filter((c) => c.type === t).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const buckets = ["返信", "約束", "AIX"].map((k) => xs.filter((x) => route(x.actual) === k));
    const picked: RouteExample[] = [];
    for (let i = 0; picked.length < PER && buckets.some((b) => b.length > i); i++) for (const b of buckets) if (b[i] && picked.length < PER) picked.push(b[i]);
    out.push(...picked);
  }
  console.log(`# 返信か AIX かの材料（${IN}）｜竹内さんの番 ${Object.values(stats).reduce((a, s) => a + (s?.n ?? 0), 0)}・手本 ${out.length}`);
  console.log(`外した: ${Object.entries(skip).map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`| 型 | 番 | 返信 | 約束の返信（2段） | AIX |`);
  for (const [t, s] of Object.entries(stats).sort((a, b) => (b[1]?.n ?? 0) - (a[1]?.n ?? 0))) console.log(`| ${ROUTE_TYPE_JA[t as RouteType]} | ${s!.n} | ${s!.reply} | ${s!.promise} | ${s!.aix} |`);
  const SHOW = arg("show");
  if (SHOW) for (const e of cands.filter((c) => ROUTE_TYPE_JA[c.type] === SHOW)) console.log(`■ ${e.at.slice(0, 16)} ${e.conv.slice(0, 8)} 前「…${e.prev}」
   客「${e.customer}」
   → ${e.actual}「${e.staff}」`);
  if (!WRITE) { console.log(`\n（dry: ${OUT} は書いていない。--write で書く）`); return; }
  const body = `// app/lib/brain-route-type-data.ts — 自動で作る（scripts/brain-route-type-build.ts --write）。手で直さない。
// 竹内さん（staff_writer=takeuchi）の番の最初の一手（返信／約束の返信＝2段／AIX）を型ごとに数えた物と、伏せた手本。申込以降・申込の書類・テスト会話は入れない。
// 作った日 ${new Date().toISOString().slice(0, 10)}・元 ${IN.replace(/^.*[\\/]/, "")}・手本 ${out.length}件
import type { RouteType, RouteTypeStat, RouteExample } from "./brain-route-type";
export const ROUTE_TYPE_BUILT_AT = ${JSON.stringify(new Date().toISOString())};
export const ROUTE_TYPE_STATS: Partial<Record<RouteType, RouteTypeStat>> = ${JSON.stringify(stats)};
export const ROUTE_EXAMPLES: ReadonlyArray<RouteExample> = ${JSON.stringify(out, null, 0).replace(/\},\{/g, "},\n  {")};
`;
  writeFileSync(OUT, body);
  console.log(`\n書いた: ${OUT}（${out.length}件・${body.length}字）`);
})().catch((e) => { console.error(e); process.exit(1); });
