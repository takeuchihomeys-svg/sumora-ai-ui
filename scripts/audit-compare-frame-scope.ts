// scripts/audit-compare-frame-scope.ts
// 「お送りさせて頂きましたお部屋の中でも」（比較の形）が出た回を、その時の束（直近の AIX【物件ピックアップした】）で分けて数える（読むだけ・LLM なし・費用0）。
// 2026-10-06 竹内（R・F asecia fonte 302 の物件オススメ）「複数の物件送った中で1件オススメする時は お送りさせて頂きましたお部屋の中でも使う。1件だけの場合は使わない」
//
//   分け方: 束の中（束の直後1時間以内・束に2部屋以上・推す部屋が束の中か分からない時も含む）／束1部屋／束から時間が空いた・束なし／束に無い部屋
//   出口の変換（fixRecommendClosing の compareAllowed=false）を誤りの回に当てて、前後を並べる（目で読む）
// 実行: npx tsx --env-file=.env.local scripts/audit-compare-frame-scope.ts [--days=180] [--show=12]
import { createClient } from "@supabase/supabase-js";
import { loadRecommendBundleFacts } from "../app/lib/recommend-bundle-server";
import { bundleCompareOk, compareFrameExitAllowed } from "../app/lib/recommendation-frame";
import { fixRecommendClosing, hasComparisonFrame } from "../app/lib/recommend-closing";
import { starHeadOf } from "../app/lib/recommendation-gaps";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const SHOW = parseInt(String(args.show ?? "12"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;

/** 比較の形の後ろの物件名（「中でも特にF asecia fonte 302号室が」→ F asecia fonte） */
function nameAfterFrame(text: string): string | null {
  const m = text.match(/中でも(?:特に)?[\s、]*([^\n、。！!]{2,40}?)(?:[\s　]*[0-9０-９A-Za-z-]{2,5}[\s　]*(?:号室)?)?(?:が|は|、)/);
  return m ? m[1].trim() : null;
}

/** 比較の形のあたり（前後60字）。後は前と同じ位置 */
function around(text: string, ref?: string): string {
  const at = Math.max(0, (ref ?? text).search(/中でも/) - 60);
  return text.slice(at, at + 150).replace(/\n+/g, " / ");
}

async function pageAll(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    out = out.concat(rows);
    if (rows.length < 1000) break;
  }
  return out;
}

type Kind = "bundle_ok" | "bundle_one" | "out_of_time" | "not_in_bundle" | "unknown";
const LABEL: Record<Kind, string> = {
  bundle_ok: "複数の束の中（束の直後1時間・2部屋以上）",
  bundle_one: "束が1部屋だけ",
  out_of_time: "束から1時間超・束なし",
  not_in_bundle: "推す部屋が束に無い",
  unknown: "束が読めない",
};

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const gen = await pageAll((a, b) => sb.from("aix_generate_log").select("conversation_id, created_at, generated_text, conditions_snapshot")
    .eq("action_type", "property_recommendation").gte("created_at", since).ilike("generated_text", "%中でも%").order("created_at").range(a, b));
  const sent = await pageAll((a, b) => sb.from("messages").select("conversation_id, created_at, text").neq("sender", "customer")
    .gte("created_at", since).ilike("text", "%中でも%").order("created_at").range(a, b));
  const corpora: Array<{ src: string; rows: Array<{ cid: string; t: number; text: string }> }> = [
    { src: "AIX の生成（物件オススメの1通目・2通目）", rows: gen.map((r) => ({ cid: r.conversation_id, t: Date.parse(r.created_at), text: String(r.generated_text ?? "") })) },
    { src: "実送信（スタッフの送信・AI の下書きをそのまま送った物を含む）", rows: sent.map((r) => ({ cid: r.conversation_id, t: Date.parse(r.created_at), text: String(r.text ?? "") })) },
  ];
  for (const c of corpora) {
    const rows = c.rows.filter((r) => r.cid && r.cid !== YUMA_CONVERSATION_ID && hasComparisonFrame(r.text));
    const cnt: Record<Kind, number> = { bundle_ok: 0, bundle_one: 0, out_of_time: 0, not_in_bundle: 0, unknown: 0 };
    const show: Record<Kind, string[]> = { bundle_ok: [], bundle_one: [], out_of_time: [], not_in_bundle: [], unknown: [] };
    let exitChanged = 0, exitEmpty = 0;
    const exitByKind: Record<Kind, number> = { bundle_ok: 0, bundle_one: 0, out_of_time: 0, not_in_bundle: 0, unknown: 0 };
    for (const r of rows) {
      // 推す部屋: 直前（30分以内）の物件オススメの🌟 → 本文の比較の形の後ろの名前
      const { data: rec } = await sb.from("aix_usage_logs").select("generated_text, created_at").eq("conversation_id", r.cid).eq("aix_type", "property_recommendation")
        .lte("created_at", new Date(r.t + 60_000).toISOString()).gte("created_at", new Date(r.t - 30 * 60_000).toISOString()).order("created_at", { ascending: false }).limit(1);
      const star = starHeadOf(String((rec ?? [])[0]?.generated_text ?? r.text))?.name ?? nameAfterFrame(r.text);
      const f = await loadRecommendBundleFacts(sb as never, r.cid, star, r.t - 1_000);
      let k: Kind;
      if (f.hoursSinceLastBundle === undefined) k = "unknown";
      else if (f.starInLastBundle === false) k = "not_in_bundle";
      else if (bundleCompareOk({ priorSentPropertyCount: 0, priorBulkSendCount: 0, priorSingleSendCount: 0, hoursSinceLastSend: null, hoursSinceLastBundle: f.hoursSinceLastBundle, starInLastBundle: f.starInLastBundle ?? null }) !== true) k = "out_of_time";
      else if ((f.bundleSize ?? 0) === 1) k = "bundle_one";
      else k = "bundle_ok";
      cnt[k]++;
      if (k !== "bundle_ok") {
        // 出口は「確かな時だけ」（束から1時間超・束の後に手で送った画像が無い）。シナリオは比較でない側（followup_single）として当てる
        const exitAllowed = compareFrameExitAllowed("followup_single", f.hoursSinceLastBundle, f.manualImagesAfterBundle ?? true);
        const ex = fixRecommendClosing(r.text, { sentPropertyCount: 99, compareAllowed: exitAllowed, notViewable: false });
        if (ex.applied.includes("comparison_frame")) exitByKind[k]++;
        if (ex.applied.includes("comparison_frame")) exitChanged++; else exitEmpty++;
        if (show[k].length < SHOW) {
          const h = f.hoursSinceLastBundle == null ? "束なし" : `束から${f.hoursSinceLastBundle.toFixed(1)}時間`;
          show[k].push(`${ex.applied.includes("comparison_frame") ? "【出口で外す】" : "【出口は掛けない】"}${new Date(r.t).toISOString().slice(0, 16)} ${r.cid.slice(0, 8)} ｜${h}・手の画像${f.manualImagesAfterBundle ? "あり" : "なし"}・束${f.bundleSize ?? "?"}部屋 ｜推す: ${star ?? "?"} ｜束: ${(f.members ?? []).slice(0, 6).join("・")}\n      前: ${around(r.text)}\n      後: ${around(ex.text, r.text)}`);
        }
      } else if (show.bundle_ok.length < 4) {
        show.bundle_ok.push(`${new Date(r.t).toISOString().slice(0, 16)} 束から${(f.hoursSinceLastBundle ?? 0).toFixed(2)}時間・束${f.bundleSize}部屋 ｜推す: ${star} ｜${r.text.replace(/\n+/g, " / ").slice(0, 100)}`);
      }
    }
    console.log(`\n=== ${c.src}: 比較の形 ${rows.length}回（${DAYS}日・YUMA を除く）===`);
    for (const k of Object.keys(cnt) as Kind[]) console.log(`  ${LABEL[k]}: ${cnt[k]}`);
    console.log(`  出口（確かな時だけ外す）を誤りの側に当てた: 外した ${exitChanged}・外さない ${exitEmpty}（内訳 ${(Object.keys(exitByKind) as Kind[]).filter((k) => exitByKind[k]).map((k) => `${LABEL[k]} ${exitByKind[k]}`).join("・")}）`);
    for (const k of Object.keys(show) as Kind[]) {
      if (!show[k].length) continue;
      console.log(`  ── ${LABEL[k]} の例`);
      for (const s of show[k]) console.log(`   ${s}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
