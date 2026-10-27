// app/lib/company-facts-by-draft.ts — 下書きが自分から触れた会社の決まり（お客様は聞いていない）を、最終チェックにも事実として渡す（純関数）
//
// 2026-10-28 台帳 unknown:company-rules-missing（最終チェックの FABRICATED_POLICY「会社の決まりを作って書いた」2件・watch_turn 8271・7560）を実物で読んだ:
//   ・8271（れい 10/26）「初期費用も最大限割引させて頂き、…費用を出来る限り抑えさせて頂きます」＝スタッフの実送信と1字違わない会社の定型
//   ・7560（10/23）「カード手数料として合計金額に3.24%が別途かかりますが、カード会社の方で分割の設定も頂けます」＝会社の事実 credit_card（10/18 竹内さん）のとおり
//   どちらも作り話ではない。最終チェックの anomaly_scan は [COMPANY_FACTS] を「お客様が今それを聞いている時だけ」受け取る（final-check.companyFactsForCheck）
//   ＝初回の挨拶で下書きが自分から書いた会社の決まりは、判定役には根拠が無く「作った」に見えた（材料が届いていない）。
//   ブレイン・書く役の材料には事実がある（生成は正しい）。直すのは判定役に渡す事実の網だけ。
//   切替 FC_COMPANY_FACTS_BY_DRAFT=on の時だけ（既定 off）。文の事実は company-facts.ts の1か所（ここは「下書きがどの事実に触れたか」の語だけ）。
// テスト: app/lib/__tests__/company-facts-by-draft.test.ts
import { COMPANY_FACTS, type CompanyFact } from "./company-facts";

export function fcCompanyFactsByDraftEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FC_COMPANY_FACTS_BY_DRAFT ?? "").trim().toLowerCase() === "on";
}

/** 下書きがその事実に触れたと分かる語（事実の id ごと）。ここに無い事実は今まで通り（お客様が聞いた時だけ） */
const DRAFT_MENTION_RE: Readonly<Record<string, RegExp>> = {
  credit_card: /クレジット(?:カード)?|カード(?:決済|払い|手数料)|分割|3\.24/,
  max_discount_sumora: /最大限割引|スモ割|2,?980円/,
  max_discount_ieyasu_giga: /最大限割引/,
  prorated_rent: /日割/,
  payment_timing: /(?:初期費用|お見積書金額|御見積書)[^。！!\n]{0,20}(?:ご入居|入居)[^。！!\n]{0,10}前[^。！!\n]{0,6}(?:お支払|お振込)|お支払(?:い)?(?:の)?(?:タイミング|時期)/,
  apply_docs: /本人確認書類|申込フォーマット|お申込に必要/,
  hold_room: /仮押さえ|お申込(?:み)?(?:で|し)?(?:お部屋)?(?:を)?(?:抑え|押さえ)/,
  screening_flow: /審査(?:期間|は)[^。！!\n]{0,10}(?:日|週)/,
  phone_hours: /19時まで/,
  viewing_method: /オンライン内見|ビデオ通話/,
  room_photo: /室内(?:の)?(?:写真|動画)/,
  cancel: /キャンセル(?:料|費用)/,
};

/** 下書きが触れた会社の事実（アカウントで分かれる事実はそのアカウントの物だけ） */
export function companyFactsMentionedByDraft(draft: string | null | undefined, account?: string | null): CompanyFact[] {
  const t = String(draft ?? "").normalize("NFKC");
  if (!t.trim()) return [];
  const acct = String(account ?? "").trim().toLowerCase();
  return COMPANY_FACTS.filter((f) => {
    const re = DRAFT_MENTION_RE[f.id];
    if (!re || !re.test(t)) return false;
    if (f.brand && !(f.brand as readonly string[]).includes(acct)) return false;
    return true;
  });
}

/** 最終チェックに足す1ブロック（無ければ空）。すでにお客様の質問で載った事実は除く */
export function draftCompanyFactsBlock(draft: string | null | undefined, account: string | null | undefined, alreadyIds: ReadonlySet<string>): string {
  const hit = companyFactsMentionedByDraft(draft, account).filter((f) => !alreadyIds.has(f.id));
  if (!hit.length) return "";
  return `[COMPANY_FACTS_IN_DRAFT]（下書きが自分から触れた会社の決まり。お客様は聞いていないが会社の事実。これと同じ内容の文は捏造ではない・反する断定だけが捏造）\n${hit.map((f) => `- ${f.fact.replace(/\*\*/g, "")}`).join("\n")}\n[/COMPANY_FACTS_IN_DRAFT]\n`;
}
