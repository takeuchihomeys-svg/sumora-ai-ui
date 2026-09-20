// AIX の担当を通常返信のセルが侵していないか（読み取りのみ）
//
// 2026-09-20 竹内「他にも会話の部分でちゃんと AIX の機能も把握したうえで調査する」
//   ③ VI_POSITIVE に「ご都合よろしいお日にち御座いますでしょうか」（= AIX【内覧日調整】の担当）が
//   入っていた事例と**同じ型の漏れ**が他のセルにないかを全件で見る。
//
// 材料は既にコードにある: AIX_ACTION_REPLY_DIRECTION[*].forbid が
//   「この AIX がある時、通常返信に書いてはいけないもの」を AIX ごとに定めている。
//   その forbid を機械で読める形（正規表現）にして、PAIR_MATRIX の全セルの
//   direction / mustInclude.label / mustInclude.fix / example に当てる。
//
// 判定は出さない（設計知見「監査で止める・件数だけ見ない」）。
//   当たったセルごとに **実送信に何通あるか** を併記して、目で読んで決めるための材料にする。
//
// ── 2026-09-20 初回実行の結果（当たり5件）。目で読んで4件は偽陽性と判断した（止めた判断も残す）──
//   ① VI_POSITIVE.direction / ② VI_POSITIVE.mustInclude.fix
//      = ③で**私が書いた禁止文そのもの**（「〜も書かない＝AIX【内覧日調整】でスタッフが送る」）に当たった。正しい状態。
//   ③ ES_CONCERN.example「礼金がかかりますので初期費用高くなってしまいます」
//      = cost_breakdown の「初期費用の項目説明」ではなく、**送付済み見積の物件がなぜ高いかの理由**。
//        fix にも「送付した見積書にある項目…履歴に無い項目・金額は書かない」と条件が付いている。担当は侵していない。
//   ④ PS_CONDITION_CHANGE_SEARCHED.direction「締めはご査収」
//      = closer:"receive_check" ＝ CLOSER_TEXT「お手隙の際にご査収ください😌！！」で、**成果物を送った時の正規の締め**。
//        estimate_sheet の forbid「ご査収」は AIX【見積書送る】が担当する時の話で、別物。
//   ⑤ PS_QUESTION.example「好条件のお部屋はすぐに埋まってしまう可能性が高い」＝ **本物**。下の注記のとおり直した。
import { createClient } from "@supabase/supabase-js";
import { PAIR_MATRIX } from "../app/lib/reply-context";
import { AIX_ACTION_REPLY_DIRECTION, AIX_BUTTON_LABELS } from "../app/lib/aix-taxonomy";
// 四者同名: 生成（generate-reply）・テスト・この監査が同じ線を見る
import { AIX_TERRITORY, buildAixTerritoryGuard } from "../app/lib/aix-territory";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 監査だけで使う「実送信に何通あるか」の線（本体の AIX_TERRITORY とは別軸なのでここに置く） */
type Territory = { aix: string; what: string; re: RegExp; sentRe?: RegExp };
const SENT_PROBE: Territory[] = [
  // viewing_invite「具体的な候補日時・2択日程」— ③で VI_POSITIVE から外した物と同じ線
  { aix: "viewing_invite", what: "日程を聞く疑問形（候補日時は AIX【内覧日調整】が送る）",
    re: /ご都合[^\n]{0,12}(?:お日にち|日程|日時)[^\n]{0,12}(?:御座|ござ)いますでしょうか|(?:お日にち|日程|ご都合)[^\n]{0,10}(?:お聞かせ|教えて)(?:頂|いただ)け/,
    sentRe: /ご都合[^\n]{0,12}(?:お日にち|日程)[^\n]{0,12}(?:御座|ござ)いますでしょうか/ },
  { aix: "viewing_invite", what: "具体的な候補日時・2択日程",
    re: /\d{1,2}月\d{1,2}日|[月火水木金土日]曜(?:日)?[^\n]{0,6}\d{1,2}時|\d{1,2}時(?:から|〜|~)\d{1,2}時/ },
  // meeting_place「住所・集合場所・集合時間の記載」
  { aix: "meeting_place", what: "住所・集合場所の記載",
    re: /集合場所|現地(?:集合|待ち合わせ)|[都道府県]{1}[^\n]{0,10}[市区][^\n]{0,10}[0-9０-９]{1,4}[-−][0-9０-９]/ },
  // estimate_sheet「金額・内訳・割引額の生成／総額の断言／ご査収」
  { aix: "estimate_sheet", what: "金額の生成・総額の断言",
    re: /[0-9０-９]{1,3}(?:,[0-9]{3})?万(?:円)?(?:に|と)?(?:なります|です|でお間違)|総額[^\n]{0,8}(?:円|万)/ },
  { aix: "estimate_sheet", what: "「ご査収ください」等の添付済み文",
    re: /ご査収|添付(?:の|致しました|しました|させて)/ },
  // cost_breakdown「初期費用の項目の説明／家賃だけで入居出来るの断言」
  { aix: "cost_breakdown", what: "初期費用の内訳項目を本文で説明",
    re: /(?:敷金|礼金|保証料|火災保険|鍵交換|日割(?:り)?家賃)[^\n]{0,12}(?:が含|含まれ|かかり|必要)/ },
  { aix: "cost_breakdown", what: "「家賃だけで入居できる／できない」の断言",
    re: /家賃(?:・管理費|と管理費)?だけ(?:で)?[^\n]{0,10}(?:入居|お住まい)[^\n]{0,8}(?:出来|でき)/ },
  // cost_explain「報酬額・還元額・割引額の生成」
  { aix: "cost_explain", what: "貸主からの報酬・還元額・割引額の生成",
    re: /(?:貸主|オーナー)[^\n]{0,10}(?:報酬|広告料|AD)|還元(?:額|させて)[^\n]{0,8}[0-9０-９]/ },
  // phone_call「電話番号・折り返しの約束と時刻」
  { aix: "phone_call", what: "電話番号の記載・折り返しの時刻約束",
    re: /0\d{1,3}[-−]\d{2,4}[-−]\d{3,4}|こちらから(?:お)?電話(?:させて|致し|します)|\d{1,2}時[^\n]{0,6}(?:お)?電話(?:させて|致し|します)/ },
  // guarantor_info「保証会社名の記載／通過の断言／並行審査の提案」
  { aix: "guarantor_info", what: "保証会社名・審査通過の断言",
    re: /保証会社[^\n]{0,8}(?:は|が)[^\n]{0,12}(?:株式会社|になります|です)|審査[^\n]{0,8}(?:必ず|確実に)[^\n]{0,8}(?:通り|通過)|並行(?:して)?審査/ },
  // application_push「書類リストの生成／希少性の煽り」
  { aix: "application_push", what: "必要書類リストの生成",
    re: /(?:身分証|住民票|source?得票|収入証明|印鑑証明)[^\n]{0,20}(?:ご用意|お願い|必要)/ },
  { aix: "application_push", what: "希少性の煽り",
    re: /埋まって(?:しまい|しまう)|残り\s*[0-9０-９]\s*(?:部屋|室)|お早めに(?:お申込|ご決断)/,
    sentRe: /埋まって(?:しまい|しまう)/ },
  // condition_hearing「①〜⑧フォーム全文の生成」
  { aix: "condition_hearing", what: "条件フォーム本文（①〜⑧）の生成",
    re: /①[^\n]{0,20}\n?②[^\n]{0,20}\n?③/ },
  // property_send / property_search「物件名・家賃・間取りの初出提示」
  { aix: "property_send", what: "物件名・号室の提示",
    re: /(?:マンション|ハイツ|コーポ|レジデンス|ハイム)[^\n]{0,6}\d{3,4}号(?:室)?/ },
];

async function main() {
  console.log(`=== AIX の担当（AIX_ACTION_REPLY_DIRECTION[*].forbid）を PAIR_MATRIX のセルが侵していないか ===`);
  console.log(`   セル ${PAIR_MATRIX.length}件 × 禁止の線 ${SENT_PROBE.length}本\n`);

  type Hit = { cell: string; field: string; t: Territory; text: string };
  const hits: Hit[] = [];
  for (const c of PAIR_MATRIX) {
    const fields: Array<[string, string]> = [["direction", c.direction ?? ""], ["example", c.example ?? ""]];
    for (const mi of (c.mustInclude ?? [])) {
      fields.push([`mustInclude.label`, mi.label ?? ""]);
      fields.push([`mustInclude.fix`, mi.fix ?? ""]);
    }
    for (const [field, text] of fields) {
      if (!text) continue;
      for (const t of SENT_PROBE) {
        if (t.re.test(text)) hits.push({ cell: c.id, field, t, text });
      }
    }
  }

  if (hits.length === 0) {
    console.log(`   当たり 0件 — セルは AIX の担当を侵していない\n`);
  } else {
    console.log(`   当たり ${hits.length}件（※ 当たり＝疑い。実送信の件数を見て目で決める）\n`);
    for (const h of hits) {
      const m = h.text.match(h.t.re);
      console.log(`── ${h.cell} . ${h.field}`);
      console.log(`   侵している疑い: AIX【${AIX_BUTTON_LABELS[h.t.aix] ?? h.t.aix}】の ${h.t.what}`);
      console.log(`   AIX 側の forbid: ${(AIX_ACTION_REPLY_DIRECTION[h.t.aix]?.forbid ?? "").slice(0, 90)}`);
      console.log(`   当たった箇所  : …${h.text.slice(Math.max(0, (m?.index ?? 0) - 25), (m?.index ?? 0) + (m?.[0].length ?? 0) + 25)}…`);
      console.log("");
    }
  }

  // ── 2026-09-20 追加: セルだけでなく **ブレインの戦略文** も見る ──
  //   YUMA ③の再発はセルではなくブレインの winning_pattern / closing_strategy / next_steps が出所だった。
  //   生成が実際に使う buildAixTerritoryGuard をそのまま当てて、①何件に注記が付くか ②誤爆していないか を目で読む。
  {
    const rows: Array<Record<string, unknown>> = [];
    for (let p = 0; p < 12; p++) {
      const { data, error } = await sb.from("conversations")
        .select("id, customer_name, suggested_aix_meta").not("suggested_aix_meta", "is", null).range(p * 1000, p * 1000 + 999);
      if (error) { console.log(`   ⚠ ${error.message}`); break; }
      const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
      if (r.length === 0) break;
      rows.push(...r);
      if (r.length < 1000) break;
    }
    let guarded = 0;
    const byWhat = new Map<string, number>();
    const samples: Array<{ src: string; text: string; guard: string }> = [];
    for (const r of rows) {
      const m = r.suggested_aix_meta as Record<string, unknown> | null;
      if (!m) continue;
      const wp = typeof m.winning_pattern === "string" ? m.winning_pattern : "";
      const cs = typeof m.closing_strategy === "string" ? m.closing_strategy : "";
      const steps = Array.isArray(m.next_steps) ? (m.next_steps as unknown[]).map(String) : [];
      const guard = buildAixTerritoryGuard([wp, cs, ...steps]);
      if (!guard) continue;
      guarded++;
      for (const t of AIX_TERRITORY) {
        if ([wp, cs, ...steps].some((x) => t.re.test(x))) byWhat.set(`${t.aix} / ${t.what}`, (byWhat.get(`${t.aix} / ${t.what}`) ?? 0) + 1);
      }
      if (samples.length < 12) samples.push({ src: String(r.customer_name ?? r.id).slice(0, 10), text: [wp, cs, ...steps].filter(Boolean).join(" ／ ").slice(0, 150), guard: guard.slice(0, 110) });
    }
    console.log(`\n=== ブレインの戦略文に AIX の担当が混ざっている会話 ${guarded}/${rows.length}件 ===`);
    console.log(`   （生成はこの時 **戦略と同じ行に** 「本文には書かない」を添えるようになった）\n`);
    for (const [k, n] of [...byWhat.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}件  ${k}`);
    console.log(`\n   --- 実物（目で読む用・12件まで）---`);
    for (const s of samples) console.log(`   [${s.src}] ${s.text}\n      ${s.guard}…\n`);
  }

  // 疑いのある語が実送信に何通あるか（設計知見「実送信で線を引く」）
  const withSent = SENT_PROBE.filter((t) => t.sentRe);
  if (withSent.length) {
    const texts: string[] = [];
    for (let p = 0; p < 12; p++) {
      const { data } = await sb.from("messages").select("text").eq("sender", "staff")
        .gte("created_at", new Date(Date.now() - 180 * 86400_000).toISOString())
        .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
      const r = (data ?? []) as Array<{ text: string | null }>;
      if (r.length === 0) break;
      texts.push(...r.map((x) => x.text ?? ""));
      if (r.length < 1000) break;
    }
    console.log(`── 実送信での出現（直近180日 スタッフ ${texts.length}通）`);
    for (const t of withSent) {
      const n = texts.filter((x) => t.sentRe!.test(x)).length;
      console.log(`     ${String(n).padStart(4)}通  ${t.aix} / ${t.what}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
