// 「その場面を分類に足すと、返信の質は上がるのか」を足す前に測る（読み取りのみ）
// 2026-09-23 竹内「続ける／優先順位を考えて行う形で」
//
// 設計知見「分類を増やす前に『増やすと質が上がるのか』を測る — reply_context_snapshot の ruleId × was_ai_used で直接出る」。
//   件数が多い＝効く、ではない。実際に下書きがそのまま送られているなら、分類が無くても困っていない。
//
// 測ること:
//   ① 候補の場面（契約書類の返送待ち・こちらが用意した書類 …）ごとに、
//      その場面で作った下書きが **そのまま送られた率（was_ai_used）と似ている度（ai_similarity）**
//   ② 比較対象: 分類できている場面（other 以外）の同じ数字
//   ③ 優先順位 = 件数 × 質の落ち幅
//
// 実行: npx tsx --env-file=.env.local scripts/audit-staff-kind-effect.ts [DAYS=120]
import { createClient } from "@supabase/supabase-js";
import { classifyLastStaffTurn, analyzeSubstance, classifyCustomerResponse, resolveTurnPair } from "../app/lib/reply-context";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);

/** other に落ちている塊（audit-staff-side-gaps.ts の実測で出た顔ぶれ）。件数順ではなく効果で並べ直すための候補 */
// 2026-09-23 実物を読んで分かったこと: other の中身は「新しい場面」ではなく
//   **既存の種類の判定漏れ**だった（審査状況の確認＝screening_wait／募集終了の報告＝confirmation_reported 等）。
//   種類を増やすのではなく判定を直す話なので、取りこぼしごとに効果を測る。
const CANDIDATES: Array<[string, RegExp]> = [
  ["審査状況の確認（→screening_wait）", /審査状況|審査の(進捗|状況)|審査[^。]{0,10}(確認|待ち|繰り上がり)|1番手[^。]{0,8}審査/],
  ["確認結果の報告（→confirmation_reported）", /募集(が)?終了|管理会社(に|へ)[^。]{0,14}確認(させて)?(いただき|頂き|し)[^。]{0,10}(まし|、|。)|確認[^。]{0,8}とのこと/],
  ["AIXの記録がそのまま本文（→property_send）", /^【AIX/],
  ["書類の依頼（→docs_request）", /(身分証明書|本人確認書類|雇用形態|申込フォーム|お申込みフォーマット)[^。]{0,24}(お送り|ご入力|ご提出|頂け|いただけ)/],
  ["物件を推す一言（→property_send）", /こちらのお部屋[^。]{0,4}(如何|いかが)/],
  ["こちらが用意した書類を渡した", /(ご用意|用意)させて(いただき|頂き)まし|(内定通知書|緊急連絡先|在籍証明|収入証明|住民票)[^。]{0,12}(となります|お送り|ご添付|ご確認)/],
  ["割引の限界を説明した", /(最大限|限界)[^。]{0,12}(割引|価格|金額)|これ以上[^。]{0,8}(割引|お安く)/],
  ["内覧の時間・場所を確定した", /(\d{1,2}[:：]\d{2}|\d{1,2}時)[^。]{0,24}(から|より|にて)?[^。]{0,16}(ご案内|待ち合わせ|集合)させて(いただき|頂き)ます/],
];

type Row = { created_at: string; conversation_id: string | null; customer_message: string | null; was_ai_used: boolean | null; ai_similarity: number | null; reply_context_snapshot: unknown };
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
const pctOf = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const avg = (a: number[]) => (a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length);

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("created_at, conversation_id, customer_message, was_ai_used, ai_similarity, reply_context_snapshot")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  console.log(`直近${days}日の生成の記録 ${rows.length}件`);

  // 生成の記録のスナップショットは形が2種類で、直前のこちらの発言が残っているのは一部だけ。
  //   標本が偏らないよう、会話ログ（messages）から直前のこちらの発言を引き直す
  const msgs: Msg[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[]; msgs.push(...r); if (r.length < 1000) break;
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  /** お客様の発言を会話ログで見つけて、その直前のこちらの発言を返す */
  const staffBefore = (convId: string | null, custMsg: string | null): string | null => {
    if (!convId || !custMsg) return null;
    const list = byConv.get(convId); if (!list) return null;
    const head = custMsg.replace(/\s+/g, " ").trim().slice(0, 24);
    if (head.length < 4) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].sender !== "customer") continue;
      if (!(list[i].text ?? "").replace(/\s+/g, " ").trim().startsWith(head)) continue;
      for (let j = i - 1; j >= 0; j--) {
        if (list[j].sender === "customer") continue;
        const t = (list[j].text ?? "").trim();
        return t && t !== "[画像]" ? t : null;
      }
      return null;
    }
    return null;
  };

  // スナップショットから「直前のこちらの発言」の本文を取り出す（鍵の名前は実物を見て決める）
  const pickLastStaff = (snap: unknown): string | null => {
    if (!snap || typeof snap !== "object") return null;
    const s = snap as Record<string, unknown>;
    // 生成の記録は形が2種類ある（新しい行は stance_sent_lite だけ）。直前のこちらの発言が残っているのは lastStaffMsgHead
    for (const k of ["lastStaffMsgHead", "lastStaffText", "lastStaffMessage", "staffText"]) {
      if (typeof s[k] === "string" && (s[k] as string).trim()) return s[k] as string;
    }
    const tp = s.turnPair as Record<string, unknown> | undefined;
    if (tp && typeof tp.lastStaffText === "string") return tp.lastStaffText;
    return null;
  };
  const withText = rows
    .map((r) => ({ r, staffText: pickLastStaff(r.reply_context_snapshot) ?? staffBefore(r.conversation_id, r.customer_message) }))
    .filter((x) => x.staffText);
  console.log(`   うち直前のこちらの発言が残っている ${withText.length}件`);
  if (withText.length === 0) {
    const sample = rows.find((r) => r.reply_context_snapshot && typeof r.reply_context_snapshot === "object");
    console.log(`   ⚠ 取り出せなかった。スナップショットの鍵: ${sample ? Object.keys(sample.reply_context_snapshot as object).join(", ") : "スナップショット自体が無い"}`);
    return;
  }

  const used = (xs: Row[]) => xs.filter((x) => x.was_ai_used === true).length;
  const sims = (xs: Row[]) => xs.map((x) => x.ai_similarity).filter((v): v is number => typeof v === "number");

  const classified: Array<{ label: string; rows: Row[] }> = [];
  const others: Row[] = [];
  const known: Row[] = [];
  for (const { r, staffText } of withText) {
    const kind = classifyLastStaffTurn(staffText ?? "").kind;
    if (kind !== "other") { known.push(r); continue; }
    const hit = CANDIDATES.find(([, re]) => re.test(staffText ?? ""));
    if (hit) {
      let bucket = classified.find((c) => c.label === hit[0]);
      if (!bucket) { bucket = { label: hit[0], rows: [] }; classified.push(bucket); }
      bucket.rows.push(r);
    } else others.push(r);
  }

  console.log(`\n① 比較の基準（分類できている場面）: ${known.length}件 ／ そのまま送信 ${pctOf(used(known), known.length)} ／ 似ている度 ${avg(sims(known)).toFixed(3)}`);
  console.log(`   分類できていない（other）全体: ${withText.length - known.length}件 ／ そのまま送信 ${pctOf(used([...classified.flatMap((c) => c.rows), ...others]), withText.length - known.length)}`);

  console.log(`\n② 候補ごと（優先順位は「件数 × 基準との落ち幅」）`);
  const base = used(known) / Math.max(known.length, 1);
  const scored = classified.map((c) => {
    const rate = used(c.rows) / Math.max(c.rows.length, 1);
    return { ...c, n: c.rows.length, rate, gap: base - rate, score: c.rows.length * Math.max(base - rate, 0) };
  }).sort((a, b) => b.score - a.score);
  console.log(`   ${"場面".padEnd(28)} 件数 ／ そのまま送信 ／ 基準との差 ／ 優先度`);
  for (const s of scored) {
    console.log(`   ${s.label.padEnd(28)} ${String(s.n).padStart(4)} ／ ${pctOf(used(s.rows), s.n).padStart(7)} ／ ${(s.gap * 100).toFixed(1).padStart(6)}pt ／ ${s.score.toFixed(1)}`);
  }
  console.log(`   ${"（候補に当たらない other）".padEnd(26)} ${String(others.length).padStart(4)} ／ ${pctOf(used(others), others.length).padStart(7)}`);
  // 候補に当たらない other が一番大きい塊。中身を見ないと「次に何を足すか」が決められない
  const otherTexts = withText.filter((x) => others.includes(x.r)).map((x) => (x.staffText ?? "").replace(/\s+/g, " ").trim());
  const heads = new Map<string, string[]>();
  for (const t of otherTexts) { const h = t.slice(0, 10); if (!heads.has(h)) heads.set(h, []); heads.get(h)!.push(t); }
  console.log(`\n③ 候補に当たらない other ${others.length}件 の中身（書き出し10字でまとめた上位）`);
  for (const [h, v] of [...heads].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
    console.log(`   ${String(v.length).padStart(4)}回 「${h}…」  例: ${v[0].slice(0, 76)}`);
  }
  // ④ 本命の問い: 効くのは「こちらの発言の種類」か、それとも「往復のセル（ruleId）」か。
  //    設計知見の前回実測では セルあり44.4% vs セルなし24.6%（20pt差）。種類だけでは 3.5pt しか差が無い。
  //    種類を足す価値は「種類を足すとセルが当たるようになるか」で決まるので、両方を計算して突き合わせる。
  const cells = withText.map(({ r, staffText }) => {
    const staff = classifyLastStaffTurn(staffText ?? "");
    const sub = analyzeSubstance(r.customer_message ?? "", undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
    const customer = classifyCustomerResponse(sub, staff, {});
    const pair = resolveTurnPair(staff, customer, sub, staffText ?? "", {});
    return { r, kind: staff.kind, ruleId: (pair as { ruleId?: string | null })?.ruleId ?? null };
  });
  const grp = (f: (c: typeof cells[number]) => boolean) => {
    const xs = cells.filter(f).map((c) => c.r);
    return `${String(xs.length).padStart(5)}件 ／ そのまま送信 ${pctOf(used(xs), xs.length).padStart(7)} ／ 似ている度 ${avg(sims(xs)).toFixed(3)}`;
  };
  console.log(`\n④ 「種類が分かる」と「往復のセルが当たる」はどちらが効くか`);
  console.log(`   種類あり × セルあり  ${grp((c) => c.kind !== "other" && !!c.ruleId)}`);
  console.log(`   種類あり × セルなし  ${grp((c) => c.kind !== "other" && !c.ruleId)}`);
  console.log(`   種類なし × セルあり  ${grp((c) => c.kind === "other" && !!c.ruleId)}`);
  console.log(`   種類なし × セルなし  ${grp((c) => c.kind === "other" && !c.ruleId)}`);
  const otherWithCell = cells.filter((c) => c.kind === "other" && !!c.ruleId).length;
  const otherAll = cells.filter((c) => c.kind === "other").length;
  console.log(`   → 種類が other でもセルが当たっているのは ${otherWithCell}/${otherAll}（${pctOf(otherWithCell, otherAll)}）`);

  console.log(`\n※ 「そのまま送信」が基準と変わらない場面は、分類が無くても困っていない＝足しても質は上がらない`);
}
main().catch((e) => { console.error(e); process.exit(1); });
