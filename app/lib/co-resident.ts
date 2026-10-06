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
// 2026-10-06 ⑫ あかり「私一人になるかもです」（世帯の変わり目・condition-reading.householdChangeOf と揃える）
const SINGLE_RE = /(?:私|自分|わたし)(?:一人|1人|ひとり)に(?:なる|なり|なった|なっ)|一人暮らし|1人暮らし|１人暮らし|ひとり暮らし|単身|一人で(?:住|入居|暮ら)|1人で(?:住|入居|暮ら)|ひとりで(?:住|入居|暮ら)|入居(?:者|人数)?(?:は)?(?:私|自分)(?:だけ|のみ|1人|一人)|入居(?:人数|者数)[^。\n]{0,4}(?:1|１|一)\s*(?:名|人)/;
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

// ── 入居人数（2026-10-02 竹内さん「条件ヒアリングに入居人数を足す」）──
// 条件ヒアリングのフォームの ⑨ご入居人数（hearing-form.ts）・お客様の発言から人数を決定論で読む。
//   申込へのフォーマット: 1＝単独・2以上＝同居あり・読めない＝分からない（スタッフが選ぶ）。
//   実物（365日のお客様の発言）: 「⑥入居予定人数」「住む人数が大人2 子ども1 小型犬1 猫1になる予定です」「人数:私と赤ちゃんとペット2匹」
//   ペットは人数に入れない。「私と赤ちゃん」のように数が無い形は読まない（数を作らない）。物件の画像の読み取り・URL の「2人入居可」は読まない。
const KANJI_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, ひとり: 1, ふたり: 2 };
const numOf = (s: string): number | null => {
  const t = s.normalize("NFKC");
  if (/^[0-9]+$/.test(t)) return Number(t);
  return KANJI_NUM[t] ?? null;
};
const N = "([0-9０-９]{1,2}|一|二|三|四|五|六)";

export type OccupantsHit = { count: number; evidence: string };

/** 1通の文から入居人数を読む（読めなければ null） */
export function occupantsFromText(text: string | null | undefined): OccupantsHit | null {
  const raw = String(text ?? "");
  if (!raw.trim() || /^\s*\[画像\]/.test(raw) || /https?:\/\//.test(raw)) return null;
  const t = raw.normalize("NFKC");
  // 大人N（人）＋子どもN（人）
  const adult = t.match(new RegExp(String.raw`大人\s*${N}\s*(?:人|名)?`));
  const child = t.match(new RegExp(String.raw`(?:子ども|子供|こども|子|お子様|お子さん|小人|未就学児|乳児|幼児|赤ちゃん)\s*${N}\s*(?:人|名)?`));
  if (adult) {
    const a = numOf(adult[1]) ?? 0, c = child ? numOf(child[1]) ?? 0 : 0;
    if (a > 0) return { count: a + c, evidence: [adult[0], child?.[0]].filter(Boolean).map((x) => String(x).trim()).join(" ") };
  }
  // 見出しつき（「⑨ご入居人数　2名」「入居予定人数 3人」「人数:2」）
  const lab = t.match(new RegExp(String.raw`(?:ご?入居(?:予定)?(?:人数|者数)|入居者(?:の)?人数|人数)\s*(?:】)?\s*[⇒→=:：\s]*${N}\s*(?:人|名)?`));
  if (lab) { const n = numOf(lab[1]); if (n && n <= 9) return { count: n, evidence: lab[0].trim() }; }
  // 「N人で住む／入居」「家族N人」「N人暮らし」
  const nWith = t.match(new RegExp(String.raw`${N}\s*(?:人|名)\s*(?:で|での)?\s*(?:入居|住|暮らし|ぐらし|すみ|すむ)|家族\s*${N}\s*(?:人|名)|${N}\s*人家族`));
  // 本人の今の人数ではない「一人暮らし」（「前の一人暮らしの時は」「一人暮らし延期」「〇〇が一人暮らしを」・監査で3通）は読まない
  if (nWith && /^(?:一|1)人(?:暮らし|ぐらし)/.test(nWith[0]) && /前の(?:一|1)人暮らし|(?:一|1)人暮らし(?:の時|延期|を?して(?:い|た))|[ぁ-んァ-ヶ一-龠]{1,6}が(?:一|1)人暮らし/.test(t)) return null;
  if (nWith) { const n = numOf(nWith[1] ?? nWith[2] ?? nWith[3]); if (n && n <= 9 && !/^(?:可|OK|ok|相談)/i.test(t.slice((nWith.index ?? 0) + nWith[0].length, (nWith.index ?? 0) + nWith[0].length + 3).replace(/^で/, ""))) return { count: n, evidence: nWith[0] }; }
  // 「二人暮らし」「2人入居」（数が書いてある語）。語だけ（同棲・夫婦・一人暮らし）は人数にしない＝人数が分からない
  //   （監査 scripts/audit-occupants.ts: 「夫婦と子ども1人の3人家族」「同棲可能、子供1人います」は2名と読むと誤る・
  //    「前の一人暮らしの時は」「一人暮らし延期」「あやせが一人暮らしを」は本人の今の人数ではない）。同居人の有無は detectCoResident の語が受け持つ
  const two = t.match(/(?:二人|2人|ふたり)(?:で)?(?:入居|暮らし|ぐらし)/);
  if (two && !/(?:二人|2人)入居(?:可|OK|ok|相談)/i.test(t)) return { count: 2, evidence: two[0] };
  return null;
}

/** お客様の発言（古→新）から入居人数（新しい発言を優先） */
export function occupantsFromTexts(texts: ReadonlyArray<string | null | undefined>): OccupantsHit | null {
  for (const t of [...texts].reverse()) { const h = occupantsFromText(t); if (h) return h; }
  return null;
}

/**
 * 入居人数（顧客の行の occupants・無ければ発言）も見て、同居人の有無を決める。
 *   人数と言葉の手がかりが食い違えば分からない（スタッフが選ぶ）。
 */
export function detectCoResidentWithOccupants(
  customerTexts: ReadonlyArray<string | null | undefined>,
  conditionTexts: ReadonlyArray<string | null | undefined> = [],
  occupants?: number | null,
): CoResidentVerdict & { occupants: number | null } {
  const words = detectCoResident(customerTexts, conditionTexts);
  const occHit = occupants && occupants > 0 ? { count: occupants, evidence: `入居人数${occupants}名` } : occupantsFromTexts(customerTexts);
  if (!occHit) return { ...words, occupants: null };
  const byCount: CoResident = occHit.count >= 2 ? "shared" : "single";
  if (words.value !== "unknown" && words.value !== byCount) return { value: "unknown", evidence: `${occHit.evidence}／${words.evidence}`, occupants: occHit.count };
  return { value: byCount, evidence: occHit.evidence, occupants: occHit.count };
}
