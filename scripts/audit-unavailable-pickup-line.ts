// 「募集に出ていない」報告の最後の1行（引き続き…ピックアップしてお送りします）を、実送信で検算する（読み取りのみ）
//
// 2026-09-23 竹内「場面の部分と文の構成の部分に着眼して実際のLINEと生成される文の違いを分析する」
//
// 【発端・私の測り違い】audit-check-result-structure.ts は aix_action を
//   property_check_result* でまとめて数えていた。型ごとに割ると全く違う:
//     property_check_result_available   (67件) ピックアップ 実送信 0.0% ／ AI  1.5%  ← ズレていない
//     property_check_result_unavailable (20件) ピックアップ 実送信35.0% ／ AI100.0%  ← ここが穴
//   available は per-property の固定テンプレなので元から揃っていた。混ぜたので穴の場所を取り違えた。
//
// 【何を測るか】unavailable の本文はコードの固定テンプレ（route.ts の buildUnavailableMessage /
//   conversation_match 側の cmBuild）で、最後の1行を**必ず**書く。実送信は何%か。
//   さらに「この会話で直前にピックアップを宣言していたか」で割る（行動台帳と同じ STAFF_PICKUP_DECL_RE を使う）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-unavailable-pickup-line.ts [DAYS=365] [SHOW=0]
import { createClient } from "@supabase/supabase-js";
import { STAFF_PICKUP_DECL_RE } from "../app/lib/reply-context";
import { waitedUsedLastTime } from "../app/lib/waited-scope";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** この場面か（募集に出ていない／募集終了の報告） */
const SCENE_RE = /募集に出ていない|募集(が)?終了して/;

type Ex = { id: string; conversation_id: string | null; sent_reply: string | null; ai_draft: string | null; created_at: string; sent_at: string | null; aix_action: string | null };
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };

async function main() {
  const days = Number(process.env.DAYS ?? 365);
  const SHOW = Number(process.env.SHOW ?? 0);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const rows: Ex[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, sent_reply, ai_draft, created_at, sent_at, aix_action")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Ex[]; rows.push(...r); if (r.length < 1000) break;
  }
  const scene = rows.filter((r) => SCENE_RE.test(r.sent_reply ?? "") && r.conversation_id);
  console.log(`「募集に出ていない」を伝えた実送信 ${scene.length}通（${days}日・会話IDあり）\n`);

  // 会話ごとに直近のスタッフ発言をまとめて取る
  const convIds = [...new Set(scene.map((r) => r.conversation_id as string))];
  const msgsByConv = new Map<string, Msg[]>();
  for (let i = 0; i < convIds.length; i += 30) {
    const chunk = convIds.slice(i, i + 30);
    const { data } = await sb.from("messages")
      .select("conversation_id, sender, text, created_at")
      .in("conversation_id", chunk).eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - (days + 30) * 86400_000).toISOString())
      .order("created_at");
    for (const m of (data ?? []) as Msg[]) {
      const arr = msgsByConv.get(m.conversation_id) ?? [];
      arr.push(m); msgsByConv.set(m.conversation_id, arr);
    }
  }

  const hasPickup = (t: string) => STAFF_PICKUP_DECL_RE.test(t);
  const atOf = (r: Ex) => new Date(r.sent_at ?? r.created_at).getTime();
  /** この送信より前 windowDays 以内に、この会話でピックアップを宣言していたか */
  const promisedBefore = (r: Ex, windowDays: number) => {
    const at = atOf(r);
    const list = msgsByConv.get(r.conversation_id as string) ?? [];
    return list.some((m) => {
      const t = new Date(m.created_at).getTime();
      return t < at - 60_000 && t > at - windowDays * 86400_000 && hasPickup(m.text ?? "");
    });
  };

  console.log(`① この場面の実送信で最後の1行（ピックアップ宣言）は何%あるか`);
  const withLine = scene.filter((r) => hasPickup(r.sent_reply ?? ""));
  console.log(`   ${withLine.length}/${scene.length}（${pct(withLine.length, scene.length)}）`);
  console.log(`   ⚠ コードの固定テンプレは 100% 書いている（route.ts buildUnavailableMessage / cmBuild）`);

  console.log(`\n② 「直前にピックアップを宣言していたか」で割る（窓を変えて検算）`);
  for (const w of [3, 7, 14, 30]) {
    const yes = scene.filter((r) => promisedBefore(r, w));
    const no = scene.filter((r) => !promisedBefore(r, w));
    const yesLine = yes.filter((r) => hasPickup(r.sent_reply ?? "")).length;
    const noLine = no.filter((r) => hasPickup(r.sent_reply ?? "")).length;
    const zero = noLine === 0 ? "  ← 宣言なし側が 0件（誤削除0で落とせる）" : `  ← 宣言なし側に ${noLine}件ある（落とすと誤削除）`;
    console.log(`   ${String(w).padStart(2)}日: 宣言あり ${yesLine}/${yes.length}（${pct(yesLine, yes.length)}） ／ 宣言なし ${noLine}/${no.length}（${pct(noLine, no.length)}）${zero}`);
  }

  console.log(`\n③ AIX を押した回だけで比べる（下書きと実送信が両方ある）`);
  const aix = scene.filter((r) => (r.aix_action ?? "").startsWith("property_check_result") && (r.ai_draft ?? "").trim());
  const aixDraftLine = aix.filter((r) => hasPickup(r.ai_draft ?? "")).length;
  const aixSentLine = aix.filter((r) => hasPickup(r.sent_reply ?? "")).length;
  console.log(`   ${aix.length}件中 下書き ${aixDraftLine}（${pct(aixDraftLine, aix.length)}） ／ 実送信 ${aixSentLine}（${pct(aixSentLine, aix.length)}）`);

  console.log(`\n③-2 分かれ目を他の軸でも探す（誤削除0になる線があるか）`);
  const axes: Array<[string, (r: Ex) => boolean]> = [
    ["同じ通で物件も送っている（🌟・号室）", (r) => /🌟|[0-9０-９]{2,4}号室/.test(r.sent_reply ?? "")],
    ["件数入りの冒頭（お送り頂きました物件N件）", (r) => /物件\s*[0-9０-９]+\s*件/.test(r.sent_reply ?? "")],
    ["物件名入りの冒頭", (r) => !/お送り頂きました物件(\s*[0-9０-９]+\s*件)?につきまして/.test(r.sent_reply ?? "")],
    ["「お待たせ」で始めている", (r) => /お待たせ(致しました|いたしました|しました)/.test(r.sent_reply ?? "")],
    ["「お世話になっております」がある", (r) => /お世話になっております/.test(r.sent_reply ?? "")],
    ["AIX を押した回", (r) => !!(r.aix_action ?? "").startsWith("property_check_result")],
  ];
  for (const [label, f] of axes) {
    const yes = scene.filter(f), no = scene.filter((r) => !f(r));
    const y = yes.filter((r) => hasPickup(r.sent_reply ?? "")).length;
    const n = no.filter((r) => hasPickup(r.sent_reply ?? "")).length;
    const flag = y === 0 || n === 0 ? "  ← 片側が0（線になりうる）" : "";
    console.log(`   ${label.padEnd(34)} 当てはまる ${y}/${yes.length}（${pct(y, yes.length)}） ／ 当てはまらない ${n}/${no.length}（${pct(n, no.length)}）${flag}`);
  }

  console.log(`\n③-3 会話ごとに揃っているか（＝担当者の癖なら会話内で一致する）`);
  const byConv = new Map<string, Ex[]>();
  for (const r of scene) { const a = byConv.get(r.conversation_id as string) ?? []; a.push(r); byConv.set(r.conversation_id as string, a); }
  const multi = [...byConv.values()].filter((a) => a.length >= 2);
  const consistent = multi.filter((a) => new Set(a.map((r) => hasPickup(r.sent_reply ?? ""))).size === 1).length;
  console.log(`   2通以上ある会話 ${multi.length}件中、書く/書かないが揃っているのは ${consistent}件（${pct(consistent, multi.length)}）`);

  // ③-4 冒頭の挨拶: 固定テンプレは 100%「お世話になっております」で、「お待たせ致しました」を一度も書かない。
  //   2026-09-21 に available 側へ入れた軸（前回もお待たせで書き出したか・55.8% 対 22.6%）が
  //   この場面でも分かれるかを、本番と同じ waitedUsedLastTime で検算する。
  console.log(`\n③-4 冒頭の挨拶（この場面の実送信）`);
  const matase = scene.filter((r) => /お待たせ(致しました|いたしました|しました)/.test(r.sent_reply ?? ""));
  console.log(`   「お待たせ」で書き出している ${matase.length}/${scene.length}（${pct(matase.length, scene.length)}）／ コードの固定テンプレは 0%`);
  const prevUsed = (r: Ex) => {
    const at = atOf(r);
    const prior = (msgsByConv.get(r.conversation_id as string) ?? [])
      .filter((m) => new Date(m.created_at).getTime() < at - 60_000)
      .map((m) => m.text ?? "");
    return waitedUsedLastTime(prior);
  };
  const py = scene.filter(prevUsed), pn = scene.filter((r) => !prevUsed(r));
  const pyM = py.filter((r) => /お待たせ(致しました|いたしました|しました)/.test(r.sent_reply ?? "")).length;
  const pnM = pn.filter((r) => /お待たせ(致しました|いたしました|しました)/.test(r.sent_reply ?? "")).length;
  console.log(`   前回もお待たせで書き出した ${pyM}/${py.length}（${pct(pyM, py.length)}） ／ そうでない ${pnM}/${pn.length}（${pct(pnM, pn.length)}）`);
  // 固定テンプレの1行目「〇〇さんお世話になっております！！」は実送信で何%か（過半数でなければ必須にできない）
  const openKind = (t: string) => {
    const head = (t.split("\n").find((l) => l.trim()) ?? "").trim();
    if (/お待たせ/.test(head)) return "お待たせ";
    if (/お世話になっております/.test(head)) return "お世話になっております";
    if (/(募集状況|確認|お送り(頂|いただ)き)/.test(head)) return "いきなり報告";
    if (/(さん|様)\s*$/.test(head)) return "名前だけ";
    return "その他";
  };
  const kinds = new Map<string, number>();
  for (const r of scene) { const k = openKind(r.sent_reply ?? ""); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  console.log(`   1行目の内訳（固定テンプレは「〇〇さんお世話になっております！！」を 100%）:`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`      ${k.padEnd(22)} ${String(n).padStart(3)}件（${pct(n, scene.length)}）`);

  if (SHOW > 0) {
    console.log(`\n④ 宣言なしなのに書いた実物（あれば・誤削除になる側）`);
    const bad = scene.filter((r) => !promisedBefore(r, 7) && hasPickup(r.sent_reply ?? "")).slice(0, SHOW);
    if (bad.length === 0) console.log(`   なし`);
    for (const r of bad) console.log(`   ・${one(r.sent_reply ?? "").slice(0, 140)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
