// scripts/count-company-fact-proactive.ts — 竹内さん（書き手A）の手打ちの実送信で、お客様に聞かれていないのに会社の事実を先回りで書いた番を数える（読むだけ・LLM なし）
//
// 2026-11-12 作業員21（夜の読み・統括役「COMPANY_FACT_PROACTIVE の A/B の前に、竹内さんが実際に先回りで会社の事実を書く番を事実の種類×場面で表に」）。
//   番＝続けて送ったスタッフの通の塊。その直前のお客様の通の塊（前のスタッフの番の後〜この番の前）を「聞いた事」として読む。
//   先回り＝この番の竹内さんの手打ちの文に事実の種類の語があり、直前のお客様の塊にその種類を聞く語が無い。
//     厳しめ（strict）＝さらに直前72時間のお客様の発言のどれにも、その種類を聞く語が無い。
//   数えない: AIX の通（is_aix_generated）・物件の資料／見積書の文（【・🌟 で始まる・「初期費用さらに」等）・従業員の通・
//     申込以降（申込の書類・手続きの通が出た後は、その会話を読み止める＝申込以降は対象外）・テスト用の会話・グループ。
//   AIX 添え＝同じ番に AIX の通（物件の資料・見積書）がある（AIX に添えた一文）。添えでない先回りが「返信だけで先回りした」番。
//   注意: フリーレント・保証会社の多くは「送る物件の事実」（会社の決まりではない）。初回の「初期費用も最大限割引させて頂き」は挨拶の定型
//   （お客様の条件の書式に⑦初期費用の欄があるため、初回は『聞かれて』に数えられやすい）。
//   出力は件数と会話 id／通 id の頭8文字だけ（本文は出さない）。DB は読むだけ。会話ごとに少し間を空ける。
// 実行（営業時間 9〜22時は避ける・--force で外す）:
//   npx tsx --env-file=.env.local scripts/count-company-fact-proactive.ts [--days=180] [--limit=400] [--json=<外のパス>] [--force]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const DAYS = Number(arg("days", "180"));
const LIMIT = Number(arg("limit", "400"));
const JSON_OUT = arg("json", "");
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jstHour = new Date(Date.now() + 9 * 3600_000).getUTCHours();
if (!process.argv.includes("--force") && jstHour >= 9 && jstHour < 22) {
  console.log(`今は JST ${jstHour}時（営業時間）。22時以降に流してください（--force で上書き）。何も読んでいません。`);
  process.exit(0);
}

/** 事実の種類: staff＝竹内さんの文に出る語／ask＝お客様が聞いている語 */
export const FACT_KINDS: Array<{ key: string; staff: RegExp; ask: RegExp }> = [
  { key: "フリーレント", staff: /フリーレント/, ask: /フリーレント|家賃.{0,6}(無料|タダ|かからな)/ },
  { key: "保証会社", staff: /保証会社/, ask: /保証会社|保証人|審査/ },
  { key: "初期費用の割引", staff: /最大限.{0,6}割引|スモ割|(初期費用|費用|仲介手数料).{0,15}(割引|値引|お安く|抑え)|割引させて/, ask: /割引|値引|安く|下げ|初期費用|費用|いくら|見積|総額|高い|予算/ },
  { key: "仲介手数料", staff: /仲介手数料/, ask: /仲介手数料|手数料/ },
  { key: "カード・分割", staff: /クレジットカード|カード(払|決済|での)|分割|3\.24/, ask: /カード|分割|支払い?方法|ローン/ },
  { key: "支払いの時期・期日", staff: /(お振込|お振り込み|入金|お支払).{0,12}(期日|日前|請求書)|請求書が届/, ask: /いつ.{0,6}(払|振込|振り込|支払|入金)|(支払|振込|入金).{0,6}(時期|いつ|期日|まで)/ },
  { key: "申込の時期（入居30日前）", staff: /30日前|1ヶ月前.{0,10}(申込|お申込)|(申込|お申込).{0,12}(1ヶ月|30日)/, ask: /いつ.{0,8}申(し)?込|申(し)?込.{0,8}(いつ|時期|早|前)/ },
  { key: "来店不要・オンライン", staff: /来店不要|ご来[店社].{0,10}(不要|必要(ございません|ありません|なく))|オンライン|LINE.{0,8}(完結|のみ|上で)/, ask: /来店|店舗|オンライン|行かな|事務所|会社に行/ },
  { key: "鍵の受け取り", staff: /鍵.{0,10}(お渡し|受け取|受取)/, ask: /鍵/ },
  { key: "審査の期間・流れ", staff: /審査.{0,15}(日程度|営業日|週間|即日|結果が出)/, ask: /審査|どのくらい|何日|期間|流れ/ },
];

/** 場面（直前のお客様の塊から決める・上から順に当てる） */
export function sceneOf(custText: string, isFirst: boolean): string {
  const t = custText.normalize("NFKC");
  if (!t.trim()) return "スタッフから（直前にお客様の発言なし）";
  if (isFirst) return "初回（最初のお客様の発言）";
  if (/https?:\/\/|suumo|homes|athome|\[画像\]/i.test(t)) return "物件・画像を送ってきた";
  if (/申込|申し込|契約したい|決めたい|押さえ|抑え/.test(t)) return "申込の意思・押さえたい";
  if (/内覧|内見|見学|案内|見に行/.test(t)) return "内覧";
  if (/費用|見積|いくら|総額|安く|割引|払/.test(t)) return "費用・見積";
  if (/検討|考え|迷|悩|また連絡|保留/.test(t)) return "検討・保留";
  if (/駅|徒歩|[0-9]万|1K|1LDK|1DK|ワンルーム|エリア|区|ペット|築|間取り|希望/.test(t)) return "条件を伝えた";
  if (/ありがとう|了解|わかりました|分かりました|承知|お願いします|はい/.test(t)) return "お礼・了解";
  return "その他";
}

const SKIP_STAFF = /^\s*[【🌟①]|初期費用さらに|オススメポイント|^\s*\[(画像|動画|スタンプ|ファイル)\]/;
const APPLY_CUT = /本人確認書類|収入証明|申込フォーマット|記入済み|お申し?込み?手続き(を)?進め/;

type Msg = { id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };

(async () => {
  const since = new Date(Date.now() - DAYS * DAY).toISOString();
  const { data: convsRaw, error } = await sb.from("conversations").select("id, line_user_id").gte("updated_at", since).order("updated_at", { ascending: false }).limit(LIMIT);
  if (error) { console.log("conversations 読めず:", error.message); process.exit(1); }
  const convs = (convsRaw ?? []).filter((c) => !isTestConversation(c.id as string) && !String(c.line_user_id ?? "").startsWith("C"));

  const turnsByScene: Record<string, number> = {};
  const cell: Record<string, Record<string, { pro: number; strict: number; asked: number; withAix: number; ex: string[] }>> = {};
  let tkTurns = 0, convWithTk = 0, cutByApply = 0;

  for (const c of convs) {
    const cid = c.id as string;
    const { data: ms } = await sb.from("messages").select("id, sender, created_at, text, is_aix_generated, staff_writer")
      .eq("conversation_id", cid).gte("created_at", since).order("created_at").limit(4000);
    await sleep(120);
    const list = (ms ?? []) as Msg[];
    let custBlock: Msg[] = [];
    let seenCustomer = false, hadTk = false;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (APPLY_CUT.test(m.text ?? "")) { cutByApply++; break; } // 申込以降は対象外
      if (m.sender === "customer") { custBlock.push(m); continue; }
      // スタッフの番の始まり: 続くスタッフの通を集める
      const turn: Msg[] = [];
      let j = i;
      while (j < list.length && list[j].sender !== "customer" && !APPLY_CUT.test(list[j].text ?? "")) { turn.push(list[j]); j++; }
      i = j - 1;
      const tkText = turn.filter((x) => x.staff_writer === "takeuchi" && !x.is_aix_generated && x.text && !SKIP_STAFF.test(x.text)).map((x) => x.text as string).join("\n");
      const isFirst = !seenCustomer && custBlock.length > 0;
      if (custBlock.length) seenCustomer = true;
      if (tkText.trim()) {
        hadTk = true; tkTurns++;
        const custText = custBlock.map((x) => x.text ?? "").join("\n");
        const scene = sceneOf(custText, isFirst);
        turnsByScene[scene] = (turnsByScene[scene] ?? 0) + 1;
        const t0 = Date.parse(turn[0].created_at);
        // 同じ番に AIX の通（物件の資料・見積書）があるか＝AIX に添えた一文か、返信だけの番か
        const withAix = turn.some((x) => x.is_aix_generated || SKIP_STAFF.test(x.text ?? ""));
        const recentCust = list.filter((x) => x.sender === "customer" && Date.parse(x.created_at) <= t0 && Date.parse(x.created_at) > t0 - 3 * DAY).map((x) => x.text ?? "").join("\n").normalize("NFKC");
        for (const k of FACT_KINDS) {
          if (!k.staff.test(tkText.normalize("NFKC"))) continue;
          const row = (cell[k.key] ??= {});
          const g = (row[scene] ??= { pro: 0, strict: 0, asked: 0, withAix: 0, ex: [] });
          if (k.ask.test(custText.normalize("NFKC"))) { g.asked++; continue; }
          g.pro++;
          if (!k.ask.test(recentCust)) g.strict++;
          if (withAix) g.withAix++;
          if (g.ex.length < 3) g.ex.push(`${cid.slice(0, 8)}/${String(turn[0].id).slice(0, 8)}`);
        }
      }
      custBlock = [];
    }
    if (hadTk) convWithTk++;
  }

  console.log(`会話 ${convs.length}（${DAYS}日・上限 ${LIMIT}・グループとテスト用を除く）・竹内さんの手打ちの番がある会話 ${convWithTk}・竹内さんの番 ${tkTurns}・申込以降で読み止めた会話 ${cutByApply}`);
  console.log(`\n場面ごとの竹内さんの番（分母）: ${JSON.stringify(turnsByScene)}`);
  console.log(`\n事実の種類 × 場面: 先回り（直前のお客様の塊で聞かれていない）／うち厳しめ（72時間聞かれていない）／聞かれて書いた`);
  const scenes = Object.keys(turnsByScene).sort((a, b) => turnsByScene[b] - turnsByScene[a]);
  for (const k of FACT_KINDS) {
    const row = cell[k.key];
    if (!row) { console.log(`■ ${k.key}: 0`); continue; }
    const sum = (f: (g: { pro: number; strict: number; asked: number; withAix: number }) => number) => Object.values(row).reduce((s, g) => s + f(g), 0);
    console.log(`■ ${k.key}: 先回り ${sum((g) => g.pro)}（厳しめ ${sum((g) => g.strict)}・うち AIX に添えた ${sum((g) => g.withAix)}）／聞かれて ${sum((g) => g.asked)}`);
    for (const s of scenes) {
      const g = row[s]; if (!g || (!g.pro && !g.asked)) continue;
      console.log(`   ${s}: 先回り ${g.pro}（厳しめ ${g.strict}・AIX 添え ${g.withAix}）／聞かれて ${g.asked}  例 ${g.ex.join(" ")}`);
    }
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ days: DAYS, convs: convs.length, tkTurns, turnsByScene, cell }, null, 1));
})();
