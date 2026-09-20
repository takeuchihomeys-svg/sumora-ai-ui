// scripts/verify-apply-readiness-brain.ts
// 実行: npx tsx --env-file=.env.local scripts/verify-apply-readiness-brain.ts
//
// 2026-09-20 竹内「ここなら申込になりそうなお客さんだと分析して、そこから申込の流れにいく形」:
//   申込が近い合図をブレインに渡した効果を**本番のブレインで**確かめる。
//   generate-reply 経由では確かめられない（本文のプロンプトは既存のブレイン判断を使うだけで、
//   リクエストで渡した履歴ではブレインは走らない）。
//
// 書き込みを伴うのでテスト会話「YUMA」だけを使い、**入れたメッセージは必ず消す**（副作用を片付ける）。
// analyzeConversation は分析結果を返すだけ（保存は analyzeAndSaveBrainMeta の仕事）なので、
// conversations.suggested_aix_meta は書き換わらない＝AIX要対応の通知も出ない。
export {};
import { createClient } from "@supabase/supabase-js";
import { analyzeConversation } from "../app/lib/brain-core";
import { detectApplyReadiness, buildApplyReadinessBrainNote, type ApplyMsg } from "../app/lib/apply-readiness";

const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA（竹内さん本人のテスト会話）
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const MARK = "[申込予測テスト]"; // 消す時の目印（本文には出ない・テスト直後に必ず削除する）

/** 前田さんの型: 見積書まで進み申込を決めかけているが、**まだ一度も内覧していない** */
const SCENE: Array<{ sender: string; text: string; days: number }> = [
  { sender: "staff", text: "YUMAさんお世話になっております！！ お部屋お送りさせて頂きます！！", days: 5 },
  { sender: "customer", text: "この物件いいですね！ 気に入りました", days: 4 },
  { sender: "staff", text: "最大限割引しました初期費用の御見積書となります！！ お手隙の際にご査収ください😌！！", days: 3 },
  { sender: "customer", text: "ありがとうございます！ 入居日はいつからになりますか？", days: 2 },
  { sender: "customer", text: "審査は厳しいですか？ 必要な書類はありますか？", days: 1 },
  { sender: "staff", text: "独立系の保証会社となりますのでご安心ください！！", days: 1 },
  { sender: "customer", text: "こちらのお部屋、申し込もうか迷っています", days: 0 },
];

async function main() {
  // ── 先に純関数が何と言うかを見る ──
  const msgs: ApplyMsg[] = SCENE.map((s) => ({ sender: s.sender, text: s.text, createdAt: ago(s.days) }));
  const r = detectApplyReadiness(msgs, Date.now());
  console.log(`── 純関数の判定: ${r.level} ${r.score}点`);
  console.log(`   ${r.reason}`);
  console.log(`── ブレインに渡す文:${buildApplyReadinessBrainNote(r)}\n`);

  // ── YUMA に場面を作る ──
  const rows = SCENE.map((s) => ({
    conversation_id: CONV, sender: s.sender, text: `${s.text} ${MARK}`,
    created_at: ago(s.days), is_aix_generated: false,
  }));
  const { data: inserted, error: insErr } = await sb.from("messages").insert(rows).select("id");
  if (insErr) { console.error("入れられなかった:", insErr.message); process.exit(1); }
  const ids = (inserted ?? []).map((x) => x.id as string);
  console.log(`── YUMA に ${ids.length} 通入れた（テスト後に消す）\n`);

  try {
    const { data: conv } = await sb.from("conversations").select("status, property_customer_id, customer_name").eq("id", CONV).maybeSingle();
    const c = conv as { status: string | null; property_customer_id: string | null; customer_name: string | null } | null;
    const t0 = Date.now();
    const meta = await analyzeConversation(CONV, false, c?.status ?? "proposing", c?.property_customer_id ?? null, "verify-apply-readiness", { customerName: c?.customer_name ?? "YUMA" });
    if (!meta) { console.log("── ブレインが判断を返さなかった"); return; }
    const action = meta.action || "なし";
    console.log(`── ブレインの判断（${Date.now() - t0}ms）──`);
    console.log(`  AIX          : ${action}`);
    console.log(`  reply_mode   : ${(meta as { reply_mode?: string }).reply_mode ?? "-"}`);
    console.log(`  購買シグナル  : ${(meta as { purchase_signal_level?: string }).purchase_signal_level ?? "-"}`);
    console.log(`  姿勢          : ${(meta as { engagement_stance?: string }).engagement_stance ?? "-"}`);
    console.log(`  返信の方向    : ${(meta as { reply_direction?: string }).reply_direction ?? "-"}`);
    const ns = (meta as { next_steps?: unknown }).next_steps;
    if (ns) console.log(`  次の手順      : ${typeof ns === "string" ? ns : JSON.stringify(ns)}`);
    // ★ 見たいのはここ: 内覧が抜けている場面で、ブレインが内覧の AIX を選べたか
    const dir = `${action} ${(meta as { reply_direction?: string }).reply_direction ?? ""} ${typeof ns === "string" ? ns : JSON.stringify(ns ?? "")}`;
    // ※ 「内覧に向かうのが正解」ではない（実データでは申込到達の29%が内覧なし・audit-apply-viewing-need.ts）。
    //    どちらに倒れたかを**記録するだけ**にする。
    console.log(`\n  内覧に向かった  : ${/viewing_invite|viewing_schedule|内覧|ご案内/.test(dir) ? "はい" : "いいえ"}`);
    console.log(`  申込に向かった  : ${/application_push|application_confirm|申込/.test(dir) ? "はい" : "いいえ"}`);
  } finally {
    // ── 必ず片付ける ──
    if (ids.length) {
      const { error: delErr } = await sb.from("messages").delete().in("id", ids);
      console.log(`\n── 片付け: ${delErr ? `⚠ 消せなかった（${delErr.message}）id=${ids.join(",")}` : `✅ ${ids.length} 通消した`}`);
    }
    // 目印が残っていないか念のため確認
    const { data: left } = await sb.from("messages").select("id").eq("conversation_id", CONV).like("text", `%${MARK}%`);
    console.log(`   目印の残り: ${(left ?? []).length === 0 ? "なし" : `⚠ ${(left ?? []).length}件`}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
