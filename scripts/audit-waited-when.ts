// 「お待たせ致しました」を**いつ**書くのか、実送信で線を引く（読み取りのみ）
//
// 2026-09-21 YUMA 検証で、許す場面（property_send・実送信50.3%）でも AI は 0/2 しか書かなかった。
// 原因は率ではなく**指示の食い違い**:
//   ・system 側の共通ルール（greetingTimeNote）に「『お待たせ致しました』は禁止語」と書いてある
//   ・挨拶の実値（openingLine）が「①「〇〇さんお世話になっております！！」で始める」と固定されている
//   ・今日足した材料（buildWaitedNote）は userPrompt の最後にあるが、①の骨格に勝てない
//   ＝ 設計知見「同じ事実について『書くな』と『書け』を別の場所から渡さない」に該当。
//
// 挨拶は**実値を1つ渡す**作りなので、率では決められない（50.3% を渡しても1つに決まらない）。
// → 設計知見「率をプロンプトで釣ると振り子になる → **条件で分ける**」。
//   そこで「スタッフが実際に書いた通」と「書かなかった通」で、何が違うのかを測る。
//
// ⚠ 1回目の測り方を2つ直した:
//   ① messages 全体（3,122件）で数えたら 0.9% しか出ず、場面別の 50.3% と合わなかった。
//      ＝ 母集団が違う。**AIX で送った通だけ**を見ないと意味がないので ai_reply_examples 起点にする。
//   ② 「約束あり」が0件だった。お客様が1言返しただけで約束を仕切り直していたため。
//      実際は「約束 →（お客様の了承）→ 結果を届ける」が普通の形なので、**結果を届けるまで約束は生きている**。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-waited-when.ts
import { createClient } from "@supabase/supabase-js";
import { isWaitedAllowed } from "../app/lib/waited-scope";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 120);
/** 冒頭にあるか（途中に出る「お待たせ」は挨拶ではない） */
const WAITED_HEAD = /^[^\n]{0,20}お待たせ(?:致|いた)?しました/;
/** こちらが「確認します／ピックアップします／出来次第ご連絡します」と言った形 */
const PROMISE_RE = /(?:次第|でき次第|出来次第)[^\n]{0,14}(?:ご連絡|ご案内|お送り|ご報告)|確認(?:させて頂き|させていただき|いたし|し)ます|お調べ(?:させて頂き|させていただき|いたし|し)ます|ピックアップ(?:させて頂き|させていただき|いたし|し)ます|お探し(?:させて頂き|させていただき|いたし|し)ます|(?:お見積|御見積)[^\n]{0,10}(?:作成|お作り)/;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

async function page(table: string, select: string, order: string, days: number, extra?: (q: never) => never) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    let q = sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (extra) q = extra(q as never);
    const { data, error } = await q;
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

type Row = { action: string; waited: boolean; gapMin: number; promised: boolean; greetedToday: boolean };
const jstDate = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

async function main() {
  const ex = await page("ai_reply_examples", "conversation_id, sent_reply, aix_action, created_at", "created_at", DAYS);
  const sends = ex.filter((r) => {
    const s = String(r.sent_reply ?? "").trim();
    return s && String(r.conversation_id ?? "") && isWaitedAllowed(String(r.aix_action ?? ""));
  });
  console.log(`=== 材料: 直近${DAYS}日・「お待たせ」を許す場面の実送信 ${sends.length}件（全${ex.length}件中）===\n`);

  const convIds = [...new Set(sends.map((r) => String(r.conversation_id)))];
  console.log(`   会話 ${convIds.length}件の履歴を読む…`);
  const msgs = await page("messages", "conversation_id, sender, text, created_at", "created_at", DAYS + 30);
  const byConv = new Map<string, Array<{ sender: string; text: string; at: number }>>();
  for (const m of msgs) {
    const c = String(m.conversation_id ?? "");
    const at = Date.parse(String(m.created_at ?? ""));
    if (!c || Number.isNaN(at)) continue;
    const arr = byConv.get(c) ?? [];
    arr.push({ sender: String(m.sender ?? ""), text: String(m.text ?? ""), at });
    byConv.set(c, arr);
  }
  for (const arr of byConv.values()) arr.sort((a, b) => a.at - b.at);

  const rows: Row[] = [];
  let noHistory = 0;
  for (const r of sends) {
    const conv = byConv.get(String(r.conversation_id));
    const sentAt = Date.parse(String(r.created_at));
    if (!conv || Number.isNaN(sentAt)) { noHistory++; continue; }
    const before = conv.filter((m) => m.at < sentAt);
    const lastCustomer = [...before].reverse().find((m) => m.sender === "customer");
    if (!lastCustomer) { noHistory++; continue; }
    // ⚠ 約束はお客様の了承をまたいでも生きている（約束 →（了承）→ 結果を届ける が普通の形）。
    //   直近3通のこちらの発言に「確認します／ピックアップします」があれば約束あり。
    const ourRecent = before.filter((m) => m.sender === "staff").slice(-3);
    rows.push({
      action: String(r.aix_action ?? "(なし)"),
      waited: WAITED_HEAD.test(String(r.sent_reply)),
      gapMin: (sentAt - lastCustomer.at) / 60000,
      promised: ourRecent.some((m) => PROMISE_RE.test(m.text)),
      // 「お世話になっております」は1日1回の挨拶なので、本日すでにこちらから送っていれば挨拶行は空になる。
      // その時スタッフが代わりに何を書いているかで、2択の渡し方が変わる
      greetedToday: before.some((m) => m.sender === "staff" && jstDate(m.at) === jstDate(sentAt)),
    });
  }
  const waited = rows.filter((r) => r.waited);
  console.log(`   履歴が取れた ${rows.length}件（取れず ${noHistory}件）／ 冒頭「お待たせ」 ${waited.length}件（${pct(waited.length, rows.length)}）\n`);

  console.log(`=== ① 直前のお客様の発言からの経過時間 ===`);
  const BUCKETS: Array<[string, number, number]> = [
    ["〜15分", 0, 15], ["15〜30分", 15, 30], ["30〜60分", 30, 60], ["1〜2時間", 60, 120],
    ["2〜4時間", 120, 240], ["4〜8時間", 240, 480], ["8〜24時間", 480, 1440], ["1日〜", 1440, Infinity],
  ];
  console.log(`   経過時間      母数  「お待たせ」    率`);
  for (const [label, lo, hi] of BUCKETS) {
    const b = rows.filter((r) => r.gapMin >= lo && r.gapMin < hi);
    if (b.length === 0) continue;
    const w = b.filter((r) => r.waited).length;
    console.log(`   ${label.padEnd(11)} ${String(b.length).padStart(5)} ${String(w).padStart(8)}  ${pct(w, b.length).padStart(6)} ${"█".repeat(Math.round((w / b.length) * 40))}`);
  }

  console.log(`\n=== ② こちらが直近3通で「確認します／ピックアップします／出来次第ご連絡します」と言っていたか ===`);
  for (const [label, sel] of [["約束あり", true], ["約束なし", false]] as Array<[string, boolean]>) {
    const b = rows.filter((r) => r.promised === sel);
    console.log(`   ${label}  母数 ${String(b.length).padStart(5)} ／「お待たせ」${String(b.filter((r) => r.waited).length).padStart(4)}（${pct(b.filter((r) => r.waited).length, b.length)}）`);
  }

  console.log(`\n=== ②' 本日すでにこちらから送っているか（「お世話になっております」は1日1回）===`);
  for (const [label, sel] of [["本日送信済み（挨拶行なし）", true], ["本日まだ（挨拶行あり）", false]] as Array<[string, boolean]>) {
    const b = rows.filter((r) => r.greetedToday === sel);
    const w = b.filter((r) => r.waited).length;
    console.log(`   ${label.padEnd(28)} 母数 ${String(b.length).padStart(5)} ／「お待たせ」${String(w).padStart(4)}（${pct(w, b.length)}）`);
    // property_send だけに絞ってもう一度（場面の違いで薄まらないように）
    const ps = b.filter((r) => r.action === "property_send");
    console.log(`      └ property_send だけ           母数 ${String(ps.length).padStart(5)} ／「お待たせ」${String(ps.filter((r) => r.waited).length).padStart(4)}（${pct(ps.filter((r) => r.waited).length, ps.length)}）`);
  }

  // ②'' 前回のこちらの送信で使っていたか（繰り返しを避けているか）
  //   2026-09-21: 2択を渡したら YUMA で 3/3（100%）になった。実送信は45.7%なので寄りすぎ。
  //   中間に落とす条件として「前回使ったら今回は使わない」が実データで支えられるかを見る。
  console.log(`\n=== ②'' 同じ会話で**前回のこちらの送信**が「お待たせ」だったか ===`);
  {
    const seq = new Map<string, Array<{ at: number; waited: boolean; action: string }>>();
    for (const r of sends) {
      const c = String(r.conversation_id), at = Date.parse(String(r.created_at));
      if (Number.isNaN(at)) continue;
      const arr = seq.get(c) ?? [];
      arr.push({ at, waited: WAITED_HEAD.test(String(r.sent_reply)), action: String(r.aix_action ?? "") });
      seq.set(c, arr);
    }
    let prevW = 0, prevWthenW = 0, prevN = 0, prevNthenW = 0;
    for (const arr of seq.values()) {
      arr.sort((a, b) => a.at - b.at);
      for (let i = 1; i < arr.length; i++) {
        if (arr[i - 1].waited) { prevW++; if (arr[i].waited) prevWthenW++; }
        else { prevN++; if (arr[i].waited) prevNthenW++; }
      }
    }
    console.log(`   前回「お待たせ」だった後  母数 ${String(prevW).padStart(5)} ／ 今回も「お待たせ」${String(prevWthenW).padStart(4)}（${pct(prevWthenW, prevW)}）`);
    console.log(`   前回そうでなかった後      母数 ${String(prevN).padStart(5)} ／ 今回は「お待たせ」${String(prevNthenW).padStart(4)}（${pct(prevNthenW, prevN)}）`);
  }

  console.log(`\n=== ③ 場面ごと ===`);
  const byAction = new Map<string, Row[]>();
  for (const r of rows) byAction.set(r.action, [...(byAction.get(r.action) ?? []), r]);
  for (const [a, list] of [...byAction.entries()].sort((x, y) => y[1].length - x[1].length)) {
    const w = list.filter((r) => r.waited).length;
    if (list.length < 10) continue;
    console.log(`   ${a.padEnd(36)} ${String(list.length).padStart(5)}件 ／ ${String(w).padStart(4)}件（${pct(w, list.length)}）`);
  }

  console.log(`\n=== ④ 線の候補 ===`);
  console.log(`   条件                                   書くと判定  実際も書いた  的中率  取りこぼし`);
  const CANDS: Array<[string, (r: Row) => boolean]> = [
    ["場面が許す（今の線）", () => true],
    ["約束あり", (r) => r.promised],
    ["30分以上", (r) => r.gapMin >= 30],
    ["1時間以上", (r) => r.gapMin >= 60],
    ["2時間以上", (r) => r.gapMin >= 120],
    ["約束あり かつ 30分以上", (r) => r.promised && r.gapMin >= 30],
    ["約束あり かつ 1時間以上", (r) => r.promised && r.gapMin >= 60],
    ["約束あり または 2時間以上", (r) => r.promised || r.gapMin >= 120],
  ];
  for (const [label, f] of CANDS) {
    const hit = rows.filter(f);
    const tp = hit.filter((r) => r.waited).length;
    console.log(`   ${label.padEnd(36)} ${String(hit.length).padStart(7)} ${String(tp).padStart(12)}  ${pct(tp, hit.length).padStart(6)}  ${String(waited.length - tp).padStart(4)}件`);
  }
  console.log(`\n   ※ 的中率 = その条件で書いた時に実送信も書いていた割合（高いほど余計に書かない）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
