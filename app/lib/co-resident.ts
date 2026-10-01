// app/lib/co-resident.ts
// 申込のフォーマット（AIX【申込へ】→ 申込フォーマット送る）の「単独／同居あり」を会話と条件から決める（純関数・DB 依存なし）。
//
// 2026-10-02 竹内さんの決定「申込へのフォーマットは同居人の有無で形が違う。会話や条件から同居人の有無を判断する。
//   分からなければ選ばずに止めてスタッフに選ばせる。大事な所なのでスタッフの確認のまま（申込へは自動で送らない）」。
//   形の違い: 同居ありは【お申込者様記入欄】の後に【同居人記入欄】が入る（AixModal APP_FORMAT_SECTIONS.roommate）。
//
// 線は scripts/audit-co-resident.ts（申込フォーマットの実送信を、同居人記入欄の有無で分け、その前の会話・条件で当てる）で引いた
//   （数字はこのファイルの下・detectCoResident のコメント）。
//   ・同居あり の手がかり（お客様の発言・条件の欄）: 二人入居・2人入居・同棲・カップル・夫婦・家族・子供／子ども／お子様・彼氏／彼女と（住む）・「僕の嫁」「主人が」・
//     妻／旦那／主人と・ルームシェア・母と／父と（住む）・〇人で住む・入居人数2名 等
//   ・単独 の手がかり: 一人暮らし・1人暮らし・単身・一人で住む・入居者は私だけ 等
//   ・ペット: 同居人ではない（申込書の「ペット飼育有無」の欄）＝手がかりにしない
//   ・両方ある・どちらも無い → 分からない（選ばない）

export type CoResident = "shared" | "single" | "unknown";
export type CoResidentVerdict = { value: CoResident; evidence: string | null };

/** 同居ありの手がかり（否定・他人事を外すのは下の NEG で） */
const SHARED_RE = /(?:二人|2人|ふたり|２人|夫婦|家族|カップル)(?:で|の)?(?:入居|暮らし|ぐらし|住|すみ|すむ|引っ越|引越)|二人入居|2人入居|同棲|同居(?:人|予定|します|する|で|あり|有)|ルームシェア|(?:彼氏|彼女|彼|妻|嫁|夫|旦那|主人|パートナー|婚約者|母|父|母親|父親|娘|息子|兄|姉|弟|妹|友人|友達)(?:さん)?(?:と|も)(?:一緒に)?(?:住|すみ|すむ|入居|暮ら|二人|2人|同居)|(?:子供|子ども|こども|お子様|お子さん|赤ちゃん|乳児|幼児)(?:が|も|と|1人|一人|2人|ひとり|ふたり|(?:[0-9０-９]+)(?:歳|才|人))|(?:僕|私|わたし|うち|俺|自分)の(?:嫁|妻|旦那|主人|夫|彼女|彼氏|奥さん)|(?:主人|旦那|嫁|妻|奥さん)(?:さん)?(?:が|も|と|は)|入居(?:人数|者数|者)[^。\n]{0,6}(?:[2-9２-９]|二|三|四)\s*(?:名|人)|(?:[2-9２-９]|二|三|四)\s*(?:名|人)(?:で|での)?(?:入居|住|暮ら)/;
/** 単独の手がかり */
const SINGLE_RE = /一人暮らし|1人暮らし|１人暮らし|ひとり暮らし|単身|一人で(?:住|入居|暮ら)|1人で(?:住|入居|暮ら)|ひとりで(?:住|入居|暮ら)|入居(?:者|人数)?(?:は)?(?:私|自分)(?:だけ|のみ|1人|一人)|入居(?:人数|者数)[^。\n]{0,4}(?:1|１|一)\s*(?:名|人)/;
/** 否定・他人の話（「同棲ではない」「二人入居不可の物件」「家族に連絡」等） */
const NEG_RE = /(?:同棲|同居|二人入居|2人入居)[^。\n]{0,4}(?:ではな|じゃな|しない|しません|不可|NG|ダメ|だめ|無し|なし)|(?:家族|母|父|親)(?:に|へ|から)(?:連絡|相談|聞|確認|報告)|緊急連絡先|連帯保証人|保証人/;

/** 1つの文で手がかりを探す（否定の文は使わない） */
function scan(text: string): { shared: string | null; single: string | null } {
  let shared: string | null = null, single: string | null = null;
  for (const raw of String(text ?? "").split(/\n|(?<=[。！!？?])/)) {
    const s = raw.trim();
    if (!s || NEG_RE.test(s)) continue;
    const a = s.match(SHARED_RE);
    if (a && !shared) shared = a[0];
    const b = s.match(SINGLE_RE);
    if (b && !single) single = b[0];
  }
  return { shared, single };
}

/**
 * 同居人の有無を決める。
 * @param customerTexts お客様の発言（古→新）。スタッフの文は渡さない（こちらの提案の「二人入居可」を拾わない）
 * @param conditionTexts 条件の欄（property_customers の preferences・other_requests・ng_points 等。お客様の条件を写した物）
 */
export function detectCoResident(customerTexts: ReadonlyArray<string | null | undefined>, conditionTexts: ReadonlyArray<string | null | undefined> = []): CoResidentVerdict {
  let shared: string | null = null, single: string | null = null;
  // 新しい発言を優先（言い直し）: 新しい順に見て、最初に見つかった方を採る
  // 物件の画像の読み取り（[画像] で始まる通）・URL の通は物件の説明（「2人入居可能」「1LDK2人入居OK」）なので見ない
  //   （実送信の監査で「2人入居」を拾った2件は両方ともポータルの画像の読み取りだった＝実際は単独）
  const cust = [...customerTexts].filter((t) => !/^\s*\[画像\]/.test(t ?? "") && !/https?:\/\//.test(t ?? "")).reverse();
  for (const t of cust) {
    const r = scan(t ?? "");
    if (r.shared && r.single) return { value: "unknown", evidence: `${r.shared}／${r.single}` };
    if (r.shared) { shared = r.shared; break; }
    if (r.single) { single = r.single; break; }
  }
  if (!shared && !single) {
    for (const t of conditionTexts) {
      // 条件の欄の「二人入居可」は お客様の希望（＝二人で入居する）として写した物。単独の「単身」も同じ
      const r = scan(String(t ?? "").replace(/二人入居可|2人入居可/g, "二人入居"));
      if (r.shared && !shared) shared = r.shared;
      if (r.single && !single) single = r.single;
    }
    if (shared && single) return { value: "unknown", evidence: `${shared}／${single}` };
  }
  if (shared) return { value: "shared", evidence: shared };
  if (single) return { value: "single", evidence: single };
  return { value: "unknown", evidence: null };
}
