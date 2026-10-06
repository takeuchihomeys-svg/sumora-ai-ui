// app/lib/condition-reading.ts — お客様の LINE の1通から「条件の発言」を種類ごとに読む（純関数・決定論・LLM なし）
//
// 2026-10-06 ⑫ 竹内さん（質問4・5）「入居時期いれる」「そこも会話によって読みとる部分でたりていないところあればつける。
//   ここを読み取る能力ついたら全体的に他の部分にも応用して質上げることできるから」
//   条件の書き手（P4・経路C・ブレインの橋・条件ブレイン）は種類ごとに別々の読み方を持っていて、入居時期は LINE から列に届く経路が無かった
//   （9/30 以降 2件とも届かず）。種類ごとの読み手をここに1つにまとめ、書き手・監査（scripts/audit-condition-reach.ts）・
//   ブレイン／返信／AIX の事前入力が同じ物を使えるようにする。
//   入口: 物件の問い合わせ（URL・この物件・号室・物件のスクショ・書類）は condition-source-gate.classifyConditionTurn で外し、条件の部分だけを読む。
//   物件1件への質問（「ガスコンロはついてないのですか？」「入居可能日は11月中旬でしょうか？」）は条件として読まない＝誤って捉えない側に倒す
import { classifyConditionTurn } from "./condition-source-gate";
import { areaAskCue, placeTokens } from "./condition-restore";
import { detectRentRaiseRequest } from "./rent-raise";
import { parseEquipmentWants } from "./listing-equipment";
import { walkMinutesInText } from "./walk-minutes-text";

export type ConditionStatementKind = "エリア" | "家賃" | "間取り" | "入居時期" | "設備" | "NG" | "通勤" | "ペット" | "徒歩";
export type ConditionStatement = { kind: ConditionStatementKind; value: string | null; evidence: string };

const nf = (s: unknown) => String(s ?? "").normalize("NFKC");
const sentencesOf = (t: string) => t.split(/\n|(?<=[。！!？?])(?![。！!？?])/).map((x) => x.trim()).filter(Boolean);

/** 物件1件への質問（あるか・付いているか・できるか）。希望の言い方が無い時だけ条件にしない */
const PROPERTY_QUESTION_RE = /(?:付いて|ついて|あり|有り|使え|でき|出来|入れ|可能)(?:ますか|ませんか|ないですか|ないの|ます\?|ません\?)|(?:のですか|んですか|でしょうか)[?？]?$|可能日|最短/;
const WISH_RE = /希望|したい|探して|探し|がいい|が良|がよ|欲しい|ほしい|以内|以上|まで|以下|でお願い|にして|に変|変更|条件|だと(?:嬉|助か|うれ)|あれば(?:嬉|助か|うれ)|が理想|NG|避け|嫌|いや/;

// ── 入居時期 ─────────────────────────────────────────────
const MOVE_IN_CTX_RE = /入居|引っ越し|引越|引っ越|住み始め|転居|住みたい/;
const MOVE_IN_WHEN_RE = /(?:(?:20[0-9]{2}|来年|今年|再来年)\s*(?:年|\/)?\s*)?(?:[0-9]{1,2}\s*月(?:\s*[0-9]{1,2}\s*日)?(?:\s*(?:上旬|中旬|下旬|初旬|頭|末|半ば|前半|後半))?(?:\s*[~〜～\-]\s*(?:[0-9]{1,2}\s*月)?(?:\s*(?:上旬|中旬|下旬|末))?)?(?:\s*(?:頃|ごろ|くらい|ぐらい|以降|までに|まで|中))?|[0-9]{1,2}\/[0-9]{1,2}|年内|今年中|今月中|来月(?:中|上旬|中旬|下旬|末)?|すぐにでも|すぐ|即入居|[0-9]+\s*(?:ヶ|か|カ|ケ)\s*月(?:後|以内))/;
const MOVE_IN_WISH_RE = /希望|したい|予定|考えて|までに|くらい|ぐらい|頃|ごろ|になりそう|になりました|に変更|変わ|で探|がいい|が良|以降|上旬|中旬|下旬|末|年内|今年中|すぐ|即/;
const MOVE_IN_PROPERTY_Q_RE = /可能日|可能(?:でしょうか|ですか|か[?？])|可(?:ですか|でしょうか)|できますか|出来ますか|入れますか|入居でき(?:ます|る)|最短|でしょうか[?？]?$|ですか[、,]?[?？]/;

/** お客様の文の入居時期の希望（「11月中旬」「2028/3月以降」「年内」）。物件1件の入居可能日を聞く文は読まない。無ければ null */
export function moveInStatementOf(text: string | null | undefined): string | null {
  const turn = classifyConditionTurn(String(text ?? ""));
  if (!turn.conditionText) return null;
  for (const s of sentencesOf(nf(turn.conditionText))) {
    if (!MOVE_IN_CTX_RE.test(s) || MOVE_IN_PROPERTY_Q_RE.test(s)) continue;
    const w = s.match(MOVE_IN_WHEN_RE);
    if (!w) continue;
    if (!MOVE_IN_WISH_RE.test(s) && !/^(?:[0-9、,.\s]*)?(?:入居|引っ越し)/.test(s)) continue;
    return w[0].replace(/\s+/g, "").trim();
  }
  return null;
}

// ── 間取り ─────────────────────────────────────────────
const LAYOUT_RE = /(?:^|[^0-9A-Za-z])([1-4]\s?(?:SLDK|LDK|DK|K|R))(?![A-Za-z])|ワンルーム/gi;
export function layoutStatementOf(s: string): string | null {
  const t = nf(s);
  const hits = [...t.matchAll(LAYOUT_RE)].map((m) => (m[1] ?? m[0]).replace(/\s+/g, "").toUpperCase().replace("ワンルーム", "1R"));
  if (!hits.length) return null;
  if (!WISH_RE.test(t) && !/でも(?:いい|良い|大丈夫|OK)|ないでしょうか|ないですか|ありますか|とか/.test(t)) return null;
  return [...new Set(hits)].join("・");
}

// ── 家賃 ─────────────────────────────────────────────
const RENT_AMOUNT_RE = /(?:家賃|予算|賃料|管理費込み?|共益費込み?|管理費等込み?)[^。\n]{0,12}?([0-9]+(?:\.[0-9]+)?)\s*万(?:円)?(?:\s*[~〜～\-]\s*([0-9]+(?:\.[0-9]+)?)\s*万)?|([0-9]+(?:\.[0-9]+)?)\s*万(?:円)?(?:台)?\s*(?:以内|まで|以下|くらい|ぐらい|前後)/;
export function rentStatementOf(s: string): string | null {
  const t = nf(s);
  const raise = detectRentRaiseRequest(t);
  if (raise) return "上げる";
  const m = t.match(RENT_AMOUNT_RE);
  if (!m) return null;
  if (/初期費用|敷金|礼金|仲介|手数料|駐車場代/.test(t.slice(Math.max(0, (m.index ?? 0) - 8), (m.index ?? 0) + m[0].length))) return null;
  return m[0].replace(/\s+/g, "");
}

// ── 通勤・ペット・NG ─────────────────────────────────────────
const COMMUTE_RE = /([一-鿿ァ-ヶA-Za-z]{1,10})(?:駅)?(?:まで|へ)[^。\n]{0,10}?(?:電車|自転車|徒歩|車)?で?\s*([0-9]{1,3})\s*分(?:以内|くらい|ぐらい|圏内|程度)?/;
const PET_RE = /(?:ペット|猫|ねこ|犬|いぬ|小型犬|中型犬|大型犬|うさぎ|小動物)[^。\n]{0,12}(?:可|OK|飼|いる|います|一緒|連れ|相談)/;
const NG_RE = /(?:1階|一階|木造|ロフト|和室|ユニットバス|3点ユニット|三点ユニット|線路|墓|北向き|半地下|プロパン|事故物件|[一-鿿]{1,6}区|[一-鿿]{1,6}駅)[^。\n]{0,8}?(?:は)?(?:NG|嫌|いや|避けたい|避けて|無理|ダメ|だめ|以外|なし|無し|❌)/;

/**
 * お客様の1通（連投の束でもよい）から条件の発言を種類ごとに読む。物件の問い合わせ・物件1件への質問は読まない。
 *   値は短い言い方（列に書く時の値ではない。列に書く時は各書き手の決まりで）
 */
export function readConditionStatements(text: string | null | undefined): ConditionStatement[] {
  const turn = classifyConditionTurn(String(text ?? ""));
  if (!turn.conditionText) return [];
  const out: ConditionStatement[] = [];
  const push = (kind: ConditionStatementKind, value: string | null, evidence: string) => {
    if (!out.some((o) => o.kind === kind)) out.push({ kind, value, evidence: evidence.slice(0, 80) });
  };
  const cond = nf(turn.conditionText);
  const area = areaAskCue(cond);
  if (area) push("エリア", placeTokens(cond).join("・") || null, area);
  const mi = moveInStatementOf(cond);
  if (mi) push("入居時期", mi, mi);
  for (const s of sentencesOf(cond)) {
    // 設備・ペットは「（この部屋に）付いていますか／飼えますか」の質問が多い＝希望の言い方が無ければ読まない。
    // エリア・家賃・間取り・通勤・徒歩は「〜とかないでしょうか」も探す依頼。この部屋を指す言い方（ここ・この・号室）の時だけ読まない
    const propertyQ = PROPERTY_QUESTION_RE.test(s) && !WISH_RE.test(s);
    const aboutThisRoom = /(?:^|[\s、。！!])(?:ここ|こちら|この|その|そちら)(?:は|の|って|も)?|号室/.test(s);
    // 物件の一覧の見出し（「＜北摂エリア＞」の下に物件名・号室が並ぶ）はエリアの依頼ではない
    const heading = /^[＜<【[].{1,20}[＞>】\]]$/.test(s);
    if (!area && !heading && placeTokens(s).length && /広げ|候補|も見|も探|追加|変更|変え|で探|でお願い|希望|方面|エリア/.test(s) && !aboutThisRoom) push("エリア", placeTokens(s).join("・"), s);
    const r = rentStatementOf(s); if (r && !aboutThisRoom) push("家賃", r, s);
    const l = layoutStatementOf(s); if (l && !aboutThisRoom) push("間取り", l, s);
    const c = s.match(COMMUTE_RE); if (c && /通勤|通学|職場|会社|学校|まで/.test(s) && !aboutThisRoom) push("通勤", `${c[1]}・${c[2]}分`, s);
    const w = walkMinutesInText(s); if (w !== null && !aboutThisRoom) push("徒歩", `${w}分`, s);
    if (PET_RE.test(s) && !propertyQ) push("ペット", null, s);
    const ng = s.match(NG_RE); if (ng) push("NG", ng[0], s);
    if (!propertyQ && WISH_RE.test(s)) {
      const eq = parseEquipmentWants({ preferences: s }).wants;
      if (eq.length) push("設備", eq.map((x) => (x as { label?: string; key?: string }).label ?? (x as { key?: string }).key ?? "").filter(Boolean).join("・") || null, s);
    }
  }
  return out;
}

// ── 2つ目の探し物（別の種類の物件）────────────────────────────────
// 2026-10-06 ⑫ 竹内さん（ゆいと）「物置は別での物件の事となる。その為、別物件は分けておこなう ゆいとさん物件 ゆいとさん物置 と2つに分ければ
//   拡張ツールで検索するさいも検索しやすい。このように1人のお客さんで2種類や2パターンの場合もある」
//   ゆいと 9/23「あともう一つ仕事用で家賃安ければ安いほどいい、物件茨木、豊中で探してる」→ 9/24「家賃2万以下とかないでしょうか？物置として使いたいくらいです」
//   が住まいの条件（豊中・1LDK・9万）に混ざり、家賃の上限が 2万に上書きされた（スタッフが 10/4 に手で 9万へ戻した）。
//   本番180日のお客様の発言 10,322件で別の種類の探し物は ゆいと（仕事用・物置）と 倉庫兼ガレージ（事業用）の2人。
//   近隣の月極駐車場（住まいの物件の近く）は AIX【確認した→近隣の月極駐車場】の話＝2つ目の探し物にしない
export type SecondaryNeed = { label: string; evidence: string };
const SECONDARY_KIND_RES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /物置|倉庫|トランクルーム|レンタル収納|ガレージ|荷物置き/, label: "物置" },
  { re: /店舗|テナント/, label: "店舗" },
  { re: /事務所|オフィス|アトリエ|スタジオ/, label: "事務所" },
  { re: /セカンドハウス|別荘|週末だけ/, label: "セカンドハウス" },
  { re: /(?:両親|親|母|父|祖母|祖父)(?:の|用の|が住む|が住める)(?:お?部屋|家|物件)/, label: "家族用" },
  { re: /仕事用|作業用|事業用/, label: "仕事用" },
];
/** 使い道・探す言い方（「〜として使いたい」「〜用で」「もう一つ〜探して」）。無い文（「事務所から内見」「事務所の住所に送って」）は読まない */
const SECONDARY_INTENT_RE = /として(?:使|利用|借)|(?:用|用途)(?:で|に|の)|名目|もう一(?:つ|件)|別(?:で|に)(?:もう)?[^。\n]{0,10}(?:探|借)|(?:で|を)探して|探して(?:ます|いる|おり)|探す(?:こと|の)|借りたい|ありますか|ないですか|ないでしょうか|欲しい/;
const SECONDARY_NOT_RE = /事務所(?:から|に(?:伺|行|来)|の住所|として利用させて)|事務所使用ではない|近隣(?:の)?(?:月極)?駐車場|店舗(?:情報|の情報)|取り扱い店舗|不動産|審査|保証/;

/** お客様の文が「住まいとは別の種類の物件」を探す話か（物置・店舗・事務所・セカンドハウス・家族用・仕事用）。無ければ null */
export function secondaryNeedOf(text: string | null | undefined): SecondaryNeed | null {
  // 画像の書き起こし（書類・保険・物件ページ）は読まない（本番: 保険の入金のスクショの「店舗」に当たった）
  if (/^\s*\[(?:画像|動画|ファイル)\]/.test(String(text ?? ""))) return null;
  const turn = classifyConditionTurn(String(text ?? ""));
  if (!turn.conditionText) return null;
  for (const s of sentencesOf(nf(turn.conditionText))) {
    if (SECONDARY_NOT_RE.test(s)) continue;
    for (const k of SECONDARY_KIND_RES) {
      if (!k.re.test(s)) continue;
      if (!SECONDARY_INTENT_RE.test(s) && !SECONDARY_INTENT_RE.test(turn.conditionText)) continue;
      return { label: k.label, evidence: s.slice(0, 80) };
    }
  }
  return null;
}

/** 2つ目の探し物の文から、その探し物の条件（家賃の上限・エリア・間取り）を読む（住まいの条件には書かない） */
export function secondaryConditionsOf(text: string | null | undefined): { rent_max: number | null; desired_area: string | null; floor_plan: string | null; note: string } {
  const t = nf(text);
  let rent: number | null = null;
  for (const m of t.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*万/g)) { const v = Math.round(Number(m[1]) * 10000); if (Number.isFinite(v) && v > 0 && v < 1_000_000) rent = rent == null ? v : Math.max(rent, v); }
  const areas = placeTokens(t.replace(/([0-9]+)\s*万/g, " "));
  // 市・区の付かない地名（「茨木、豊中で」）は大阪近郊の主な地名だけ拾う（拾えなければ空＝スタッフが画面で入れる）
  const plain = [...t.matchAll(/茨木|豊中|吹田|高槻|枚方|堺|尼崎|西宮|梅田|難波|天王寺|京橋|守口|門真|摂津|箕面|池田|東大阪|八尾|都島/g)].map((m) => m[0]);
  const layout = layoutStatementOf(t);
  return { rent_max: rent, desired_area: [...new Set([...areas, ...plain])].join("・") || null, floor_plan: layout, note: t.replace(/\s+/g, " ").slice(0, 120) };
}

// ── 世帯の変わり目（一人になる・二人になる・家族が増える・ペットを手放す）───────────────
// 2026-10-06 ⑫ 竹内さん（あかり 10/02「別れることになって」「私一人になるかもです」「ここの部屋に似た感じでちっさくて大丈夫です！」）
//   「一人になった場合など連動して物件検索の条件も変更されるようにする」: 登録の条件に「二人入居可」が残り、送っていない部屋が全部 保留（二人入居 NG）だった
export type HouseholdChange = { kind: "to_single" | "to_two" | "family_grows" | "pet_gone"; evidence: string };
const TO_SINGLE_RE = /(?:私|自分|わたし)?(?:一人|1人|ひとり)(?:に|だけに)(?:なる|なり|なった|なっ)|(?:一人|1人|ひとり)(?:暮らし|で住む|で住み|での(?:ご)?入居|入居)(?:に(?:なる|なり|変更)|で探|を探|にし|希望)|別れ(?:る|た|ること|まし)|同棲(?:を)?(?:解消|しなく|やめ|なし)|ルームシェア(?:を)?(?:解消|やめ|なし)|同居(?:人)?(?:が)?(?:いなく|なし|無し|解消)/;
const TO_TWO_RE = /(?:二人|2人|ふたり)(?:で住む|で住み|暮らし|入居)(?:に(?:なる|なり|変更)|になりそう|することに)|同棲(?:する|することに|始め)|(?:彼氏|彼女|パートナー|婚約者)と(?:一緒に)?住む(?:ことに|予定)/;
const FAMILY_GROWS_RE = /(?:子供|子ども|赤ちゃん)(?:が)?(?:生まれ|産まれ|できた|出来た)|妊娠|家族が増え/;
const PET_GONE_RE = /(?:ペット|犬|猫)[^。\n？?]{0,8}(?:手放|譲(?:る|り|っ)|里親に出|亡くな|いなくな)/;
/** お客様の文の世帯の変わり目（無ければ null）。物件1件の話・申込の書類は読まない */
export function householdChangeOf(text: string | null | undefined): HouseholdChange | null {
  const turn = classifyConditionTurn(String(text ?? ""));
  if (!turn.conditionText) return null;
  for (const s of sentencesOf(nf(turn.conditionText))) {
    if (/内覧|内見|ご案内|鍵|来店|お越し/.test(s)) continue; // 「一人で内覧に行きます」は世帯の話ではない
    if (/入居者|契約|名義|申込|審査|保証/.test(s)) continue; // 「代理契約で、入居者は私一人になります」は申込の書類の話（世帯の変わり目ではない）
    if (TO_SINGLE_RE.test(s)) return { kind: "to_single", evidence: s.slice(0, 60) };
    if (TO_TWO_RE.test(s)) return { kind: "to_two", evidence: s.slice(0, 60) };
    if (FAMILY_GROWS_RE.test(s)) return { kind: "family_grows", evidence: s.slice(0, 60) };
    if (PET_GONE_RE.test(s)) return { kind: "pet_gone", evidence: s.slice(0, 60) };
  }
  return null;
}
/** 「ちっさくて大丈夫」「狭くてもいい」＝広さ・間取りの下限を緩めてよい */
export function smallerOkOf(text: string | null | undefined): boolean {
  return /(?:小さく|ちいさく|ちっさく|ちっちゃく|狭く|せまく|コンパクト)[^。\n]{0,4}(?:て|で|ても|でも)?(?:大丈夫|いい|良い|OK|ok|構わ|問題な)/.test(nf(text));
}
