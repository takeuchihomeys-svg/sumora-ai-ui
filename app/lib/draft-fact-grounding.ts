// app/lib/draft-fact-grounding.ts — 下書きの事実（日付・時刻・号室・物件名・設備）を1つずつ材料と照らし、根拠の無い物を見つける（純関数・DB なし・LLM なし）
//
// 2026-10-09 竹内「Claude Code にあってツールに無い力 3. 書いた後に事実と1つずつ照らして見直す」
//   最初は「止めて記録するだけ」（本文は書き換えない・自動送信を止める印）。線は scripts/audit-draft-fact-grounding.ts（過去40日の下書き×実送信）で引く。
//
// 【既存と重ねない】
//   金額 … staff-confirm-facts.findUngroundedAmount（canAutoReply ⑥-3）／築年数の幅 … findUngroundedAgeRange（⑥-3b）
//   空き状況・管理会社の回答・内覧の確定・待ち合わせの住所 … findStaffOnlyFact（⑥-2）／AIX が送る中身 … aix-content-gate（⑥-2b）
//   会社の事実に反する断定 … company-fact-guard（final-check V16）
//   → ここは残りの「日付・時刻・号室・物件名・設備」だけを見る。
//
// 【照らし方】決定論で抜き出し、材料（groundText＝会話の直近の通・AIX の本文・送った資料の読み取り・会社の事実 等をつないだ文）の中に
//   同じ値があるかを見る（日付は M/D、時刻は H:MM、号室は先頭の 0 を外す、物件名は建物の鍵と名前の近さ、設備は言い換えの組）。
//   あいまいな所（物件名の近さが線の近く）は "uncertain" として返す（LLM に回すかは呼び出し側。今は回さない）。
// 【当てない】お客様の言葉の復唱・条件の話（「ご希望の」「〜であれば」「探して」）・質問の形（「〜でしょうか」）・一般の説明（「一般的に」）。
//
// 戻す: DRAFT_FACT_GROUNDING=off（止める印を出さない）。種類ごとに止めるのは DRAFT_FACT_GROUNDING_KINDS（既定は監査で誤検知 0 だった種類だけ）。
import { splitPropertyName, buildingKeyOf, voicingFold } from "./customer-state";
import { similarity } from "./property-name-match";

export type DraftFactKind =
  | "date" | "time" | "room" | "property_name" | "facility"
  // 2026-10-09 細かく（既存の関所に無い種類だけ。空き・管理会社の回答・審査・フリーレント・交渉・入居可能日の日付つき・金額は既存）
  | "area" | "floor" | "direction" | "parking" | "pet" | "cost_item" | "movein_immediate" | "vacate" | "cancel_fee";
const ALL_KINDS: readonly DraftFactKind[] = ["date", "time", "room", "property_name", "facility", "area", "floor", "direction", "parking", "pet", "cost_item", "movein_immediate", "vacate", "cancel_fee"];
export type DraftFact = { kind: DraftFactKind; value: string; key: string; sentence: string };
export type DraftFactHit = DraftFact & { grounded: boolean; uncertain?: boolean };

const nfkc = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");
function sentences(s: string): string[] {
  return s.split(/(?<=[。！!？?])|\n/).map((x) => x.trim()).filter(Boolean);
}

/** 条件・復唱・質問・一般論の文（事実の言い切りではない） */
//   「・駐輪場利用の有無」（申込のフォーマットの欄＝聞いている）も言い切りではない（90日の監査の誤検知 1）
const NOT_ASSERTION_RE = /有無|ご記入|ご入力|ご希望|ご条件|条件で|であれば|でしたら|場合(?:は|には)?|探し|お探し|ピックアップ|でしょうか|ですか[？?]|ますか[？?]|御座いますでしょうか|一般的|多くの物件|物件(?:によって|による)|お伝え(?:頂|いただ)ければ|教えて/;

// ── 抜き出し ───────────────────────────────────────────
const DATE_RE = /(?<![0-9])([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日|(?<![0-9/])([0-9]{1,2})\s*\/\s*([0-9]{1,2})(?![0-9/])/g;
const TIME_RE = /(?<![0-9])([0-9]{1,2})\s*[:：]\s*([0-9]{2})(?![0-9])|(?<![0-9])([0-9]{1,2})\s*時(?!間)(\s*半)?/g;
const ROOM_RE = /(?<![0-9])([0-9]{3,4})\s*号室?/g;
/** 物件名＋号室（「〇〇 503号室」「【〇〇 503号室】」） */
const NAME_ROOM_RE = /(?:【|^|[\s、。！!「])([^\s【】「」、。！!？?]{3,30}?)\s*([0-9]{3,4})\s*号室/g;

/** 設備の言葉と言い換え（材料の側はどれか1つがあればよい） */
export const FACILITY_SYNONYMS: ReadonlyArray<{ key: string; draft: RegExp; ground: RegExp }> = [
  { key: "オートロック", draft: /オートロック/, ground: /オートロック/ },
  { key: "宅配ボックス", draft: /宅配(?:ボックス|BOX)/i, ground: /宅配(?:ボックス|BOX)|宅配/i },
  { key: "独立洗面台", draft: /独立洗面/, ground: /独立洗面|洗面(?:所|台)独立|洗髪洗面/ },
  { key: "バストイレ別", draft: /バス\s*トイレ\s*別|BT別/i, ground: /バス\s*トイレ\s*別|BT別|セパレート/i },
  { key: "24時間換気", draft: /24時間換気/, ground: /24時間換気|２４時間換気/ },
  { key: "浴室乾燥", draft: /浴室(?:換気)?乾燥/, ground: /浴室(?:換気)?乾燥/ },
  { key: "追い焚き", draft: /追い?焚き|追焚/, ground: /追い?焚き|追焚/ },
  { key: "室内洗濯機置場", draft: /室内洗濯(?:機)?置/, ground: /室内洗濯(?:機)?置|洗濯機置場（室内）|洗濯(?:機)?置場/ },
  { key: "駐輪場", draft: /駐輪場/, ground: /駐輪場/ },
  { key: "エレベーター", draft: /エレベーター/, ground: /エレベーター|EV/ },
  { key: "ウォークインクローゼット", draft: /ウォークイン|WIC/i, ground: /ウォークイン|WIC/i },
  { key: "ロフト", draft: /ロフト/, ground: /ロフト/ },
  { key: "角部屋", draft: /角部屋/, ground: /角部屋|角住戸/ },
  { key: "南向き", draft: /南向き/, ground: /南向き|向き\s*[:：]?\s*南|南\s*向/ },
  { key: "システムキッチン", draft: /システムキッチン/, ground: /システムキッチン/ },
  { key: "IHコンロ", draft: /IH(?:コンロ|クッキング)/i, ground: /IH/i },
  { key: "2口コンロ", draft: /2口(?:コンロ|ガス)/, ground: /2口/ },
  { key: "防犯カメラ", draft: /防犯カメラ/, ground: /防犯カメラ/ },
  { key: "インターネット無料", draft: /(?:インターネット|ネット|Wi-?Fi)(?:使用料)?無料/i, ground: /(?:インターネット|ネット|Wi-?Fi)(?:使用料)?(?:無料|込)/i },
  { key: "家具家電付き", draft: /家具(?:・)?家電付/, ground: /家具(?:・)?家電付/ },
  { key: "床暖房", draft: /床暖房/, ground: /床暖房/ },
  { key: "TVモニター付インターホン", draft: /(?:TV|テレビ)モニター付?インターホン/i, ground: /モニター付?インターホン|(?:TV|テレビ)モニター/i },
];

/**
 * 細かい種類（抜き出しの形と材料の側の形）。key は材料と照らす値。
 * 既存と重ねない: 金額（findUngroundedAmount）・日付つきの入居可能日／退去予定（staff-confirm-facts movein_date）・空き（vacancy）・
 *   フリーレント（aix-content-gate free_rent_claim）・審査（screening_result）・管理会社の回答（mgmt_answer）は見ない。
 */
type ExtraFact = { kind: DraftFactKind; re: RegExp; key: (m: RegExpMatchArray) => string | null; exclude?: RegExp };
const EXTRA_FACTS: readonly ExtraFact[] = [
  // 広さ「25.5㎡」「22.62m²」
  { kind: "area", re: /([0-9]{1,3}(?:\.[0-9]{1,2})?)\s*(?:㎡|m²|m2|平米)/g, key: (m) => String(Number(m[1])), exclude: /以上|以下|程|前後|くらい|ぐらい|〜|~/ },
  // 階「3階のお部屋」「10階部分」（「2階建て」「〇階以上」は外す）
  { kind: "floor", re: /(?<![0-9])([0-9]{1,2})\s*階(?!建|以上|以下)/g, key: (m) => String(Number(m[1])), exclude: /以上|以下|より上|階建/ },
  // 向き（南向き以外も・「南向き」は設備の組にもあるのでここは東・西・北・南東 等）
  { kind: "direction", re: /(東|西|北|南東|南西|北東|北西)向き/g, key: (m) => m[1] },
  // 駐車場の有無・空き（料金は金額の関所）
  { kind: "parking", re: /駐車場(?:が|は|も)?(?:付き|あり|有り|ござい|空いて|空き(?:が)?あり|ございません|無し|なし|ありません|満車)/g, key: (m) => (/ございません|無し|なし|ありません|満車/.test(m[0]) ? "none" : "yes") },
  // ペットの可否（「ペット可のお部屋をお探し」は条件＝NOT_ASSERTION で外れる）
  { kind: "pet", re: /ペット(?:飼育)?(?:可能|可|OK|相談可|不可|NG|禁止)|(?:犬|猫|小型犬)(?:の)?(?:飼育)?(?:可能|可|不可|NG)/g, key: (m) => (/不可|NG|禁止/.test(m[0]) ? "no" : "yes") },
  // 初期費用の内訳（月数・0円の言い切り。金額そのものは金額の関所）
  { kind: "cost_item", re: /(礼金|敷金|保証金|敷引)(?:は|が|も)?\s*(?:([0-9](?:\.[0-9])?)\s*ヶ?か?月|なし|無し|0円|ゼロ)/g, key: (m) => `${m[1]}:${m[2] ?? "0"}` },
  // 即入居（日付の無い入居可能日）
  { kind: "movein_immediate", re: /即(?:日)?入居(?:可能|可|頂け|いただけ)|すぐに(?:ご)?入居(?:可能|頂け|いただけ)/g, key: () => "即入居" },
  // 退去予定（日付の無い言い切り「退去予定のお部屋となります」）
  { kind: "vacate", re: /退去予定(?:の(?:お部屋|物件)|と|で)(?:なり|ござい|す)/g, key: () => "退去予定" },
  // キャンセル料
  { kind: "cancel_fee", re: /キャンセル(?:料|費)(?:は|が|も)?[^。\n]{0,8}(?:かかり|発生|不要|無料|かかりません|0円|頂きません|いただきません)/g, key: () => "キャンセル料" },
];

function dateKey(m: RegExpMatchArray): string | null {
  const mo = Number(m[1] ?? m[3]), d = Number(m[2] ?? m[4]);
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${mo}/${d}`;
}
function timeKey(m: RegExpMatchArray): string | null {
  const h = Number(m[1] ?? m[3]);
  const mi = m[2] != null ? Number(m[2]) : m[4] ? 30 : 0;
  if (!(h >= 0 && h <= 24 && mi >= 0 && mi < 60)) return null;
  return `${h}:${String(mi).padStart(2, "0")}`;
}
const roomKey = (r: string) => String(Number(r));

/** 下書きから照らす事実を抜き出す（言い切りの文だけ） */
export function extractDraftFacts(draft: string | null | undefined): DraftFact[] {
  const out: DraftFact[] = [];
  for (const s of sentences(nfkc(draft))) {
    if (NOT_ASSERTION_RE.test(s)) continue;
    for (const m of s.matchAll(DATE_RE)) { const k = dateKey(m); if (k) out.push({ kind: "date", value: m[0], key: k, sentence: s }); }
    for (const m of s.matchAll(TIME_RE)) { const k = timeKey(m); if (k) out.push({ kind: "time", value: m[0], key: k, sentence: s }); }
    for (const m of s.matchAll(ROOM_RE)) out.push({ kind: "room", value: m[0], key: roomKey(m[1]), sentence: s });
    for (const m of s.matchAll(NAME_ROOM_RE)) {
      const ref = splitPropertyName(`${m[1]} ${m[2]}号室`);
      if (!ref || ref.buildingKey.length < 3) continue;
      if (/^(?:こちら|その|この|お部屋|物件|同じ|別の|他の|お送り|送って|ご紹介)/.test(ref.building)) continue;
      // 文の切れ端（「現在募集中の」「礼金は1ヶ月となり」「LOHAS豊中稲津町は3階部分の」）は物件名にしない（2026-10-09 監査の実物）
      if (/募集|礼金|敷金|家賃|となり|現在|部分|階|ご内覧|ご案内|[のはがをにでと]$/.test(ref.building)) continue;
      if (!/[ァ-ヶーA-Za-z]{2,}/.test(ref.building)) continue;
      out.push({ kind: "property_name", value: ref.building, key: ref.buildingKey, sentence: s });
    }
    for (const f of FACILITY_SYNONYMS) if (f.draft.test(s)) out.push({ kind: "facility", value: f.key, key: f.key, sentence: s });
    // 2026-10-09 竹内「細かい部分までこだわれば完全に任せる事が出来る」: 物件の事実の種類を細かく（既存の関所に無い物だけ）
    for (const e of EXTRA_FACTS) {
      if (e.exclude && e.exclude.test(s)) continue;
      for (const m of s.matchAll(e.re)) { const k = e.key(m); if (k) out.push({ kind: e.kind, value: m[0], key: k, sentence: s }); }
    }
  }
  return out;
}

/** 材料の文から照らす値の集合を作る（何度も使うので1回だけ作る） */
export type GroundIndex = { dates: Set<string>; times: Set<string>; rooms: Set<string>; buildingKeys: string[]; text: string };
export function buildGroundIndex(groundText: string | null | undefined): GroundIndex {
  const t = nfkc(groundText);
  const dates = new Set<string>(), times = new Set<string>(), rooms = new Set<string>();
  for (const m of t.matchAll(DATE_RE)) { const k = dateKey(m); if (k) dates.add(k); }
  // 日付の別の書き方（「2026-10-08」「2026年10月8日」）
  for (const m of t.matchAll(/20[0-9]{2}[-年/]([0-9]{1,2})[-月/]([0-9]{1,2})/g)) dates.add(`${Number(m[1])}/${Number(m[2])}`);
  for (const m of t.matchAll(TIME_RE)) { const k = timeKey(m); if (k) times.add(k); }
  // 「13時〜14時半」「13:00〜」の幅の両端は上で拾える。号室は「503号室」「0503」「503」（資料の読み取りの room_no）
  for (const m of t.matchAll(/(?<![0-9])([0-9]{3,4})(?![0-9])/g)) rooms.add(roomKey(m[1]));
  const buildingKeys: string[] = [];
  for (const line of t.split(/\n|[、。]/)) { const k = buildingKeyOf(line); if (k.length >= 3) buildingKeys.push(k); }
  return { dates, times, rooms, buildingKeys, text: t };
}

/** 1つの事実が材料にあるか */
export function groundFact(f: DraftFact, g: GroundIndex): DraftFactHit {
  if (f.kind === "date") return { ...f, grounded: g.dates.has(f.key) };
  if (f.kind === "time") return { ...f, grounded: g.times.has(f.key) };
  if (f.kind === "room") return { ...f, grounded: g.rooms.has(f.key) };
  if (f.kind === "facility") {
    const syn = FACILITY_SYNONYMS.find((x) => x.key === f.key);
    return { ...f, grounded: !!syn && syn.ground.test(g.text) };
  }
  if (f.kind !== "property_name") return { ...f, grounded: groundExtra(f, g) };
  // 物件名: 材料の行の建物の鍵に含まれる → 根拠あり。名前の近さが 0.75 以上（読み取りの化け）→ あいまい
  const k = f.key;
  if (g.buildingKeys.some((x) => x.includes(k))) return { ...f, grounded: true };
  const near = g.buildingKeys.some((x) => similarity(voicingFold(k), voicingFold(x.slice(0, Math.max(k.length + 4, 6)))) >= 0.75);
  return { ...f, grounded: near, uncertain: near };
}

/** 細かい種類の照らし（材料の文＝会話・資料の読み取りの JSON（area_sqm・floor・key_money_months・deposit_months・status）・会社の事実） */
function groundExtra(f: DraftFact, g: GroundIndex): boolean {
  const t = g.text;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  switch (f.kind) {
    case "area": {
      const n = Number(f.key);
      for (const m of t.matchAll(/([0-9]{1,3}(?:\.[0-9]{1,2})?)\s*(?:㎡|m²|m2|平米)|"(?:area_sqm|areaSqm)"\s*:\s*([0-9.]+)/g)) if (Math.abs(Number(m[1] ?? m[2]) - n) < 0.05) return true;
      return false;
    }
    case "floor": {
      const n = Number(f.key);
      if (new RegExp(`(?<![0-9])${n}\\s*階|"floor"\\s*:\\s*${n}(?![0-9])`).test(t)) return true;
      // 号室の頭の数字（302 → 3階・1002 → 10階）
      for (const r of g.rooms) { const fl = r.length >= 4 ? Number(r.slice(0, r.length - 2)) : r.length === 3 ? Number(r[0]) : NaN; if (fl === n) return true; }
      return false;
    }
    case "direction": return new RegExp(`${esc(f.key)}向き|向き\\s*[:：]?\\s*${esc(f.key)}`).test(t);
    case "parking": return f.key === "none" ? /駐車場\s*(?:[:：]\s*)?(?:なし|無|満車|ございません|ありません|空きなし)/.test(t) : /駐車場[^。\n]{0,12}(?:あり|有|空き|付|[0-9][0-9,]*\s*円|料金|台)/.test(t);
    // ⚠ お客様の条件の行（property_customers.pet＝お客様がペットを飼う）は物件の可否の根拠にしない＝JSON の pet は見ない
    case "pet": return f.key === "no" ? /ペット\s*(?:[:：]\s*)?(?:不可|禁止|NG)/.test(t) : /ペット\s*(?:[:：]\s*)?(?:可|相談|OK|飼育可)|(?:犬|猫|小型犬)[^。\n]{0,6}可/.test(t);
    case "cost_item": {
      const [item, months] = f.key.split(":");
      const json = item === "礼金" ? "key_money_months" : item === "敷金" || item === "保証金" ? "deposit_months" : "";
      if (json && new RegExp(`"${json}"\\s*:\\s*${esc(months)}(?![0-9.])`).test(t)) return true;
      if (months === "0") return new RegExp(`${item}\\s*[:：]?\\s*(?:0|０|なし|無し|ゼロ|-|－|—)(?![0-9.])|${item}[^。\\n]{0,4}(?:0円|なし|無し)`).test(t) || /敷礼(?:なし|無し|0|ゼロ)/.test(t);
      return new RegExp(`${item}\\s*[:：]?\\s*${esc(months)}\\s*(?:ヶ|か|カ)?月`).test(t);
    }
    case "movein_immediate": return /即入居|即日入居|入居(?:可能)?(?:日|時期)?\s*[:：]?\s*即/.test(t);
    case "vacate": return /退去予定|move_out_planned/.test(t);
    case "cancel_fee": return /キャンセル(?:料|費)/.test(t);
    default: return false;
  }
}

/** 下書きの事実のうち根拠の無い物（あいまいな物は uncertain つきで含めない＝止めない） */
export function findUngroundedFacts(draft: string | null | undefined, groundText: string | null | undefined, kinds?: ReadonlySet<DraftFactKind>): DraftFactHit[] {
  if (!groundText) return [];
  const g = buildGroundIndex(groundText);
  return extractDraftFacts(draft).filter((f) => !kinds || kinds.has(f.kind)).map((f) => groundFact(f, g)).filter((h) => !h.grounded);
}

/**
 * 止める種類（監査で誤検知 0 だった種類だけ・env で上書き）。
 * 2026-10-09 scripts/audit-draft-fact-grounding.ts（90日・AI の下書き）:
 *   日付 38件中 根拠なし 3（作った内覧の候補日 2・作った入居可能日 1＝全部が本当の作り話）／時刻 49件中 8（全部が同じ作った候補日の下書き）／
 *   号室 35件中 0／物件名 24件中 0（読み取りの化け 1件は「あいまい」で止めない）→ 4つは誤検知 0 で効かせる。
 *   設備 3件中 1（申込のフォーマットの「・駐輪場利用の有無」＝聞いている欄・直した後は 0）。
 *   竹内さんの手打ちでは同じ4つが材料の外に 45件（管理会社・カレンダーで確かめた事＝AIX の番）＝AI が書けば作り話になる所を正しく指している。
 */
// 2026-10-09（細かい種類を足した後・同じ90日）: 階 15・ペット 3・初期費用の内訳 3・キャンセル料 7・駐車場 1・設備 1 の下書きの事実は全部根拠あり＝誤検知 0。
//   竹内さんの手打ちで材料の外に出た物（広さ 8・階 2・ペット 1・内訳 4・設備 3）は全部、資料の画像を読めていない物件の推しどころ・管理会社の条件＝AI が書けば作り話。
//   → 細かい種類も止める（下書きでの当たりはまだ 0 件＝件数が溜まったら同じ監査で読み直す）。向き・即入居・退去予定は事実の数が少ない（0〜8）が同じ扱い。
export const DEFAULT_GROUNDING_KINDS: ReadonlySet<DraftFactKind> = new Set<DraftFactKind>(ALL_KINDS);
export function groundingKinds(env: Record<string, string | undefined> = process.env): ReadonlySet<DraftFactKind> {
  if ((env.DRAFT_FACT_GROUNDING ?? "").toLowerCase() === "off") return new Set();
  const v = (env.DRAFT_FACT_GROUNDING_KINDS ?? "").trim();
  if (!v) return DEFAULT_GROUNDING_KINDS;
  return new Set(v.split(",").map((x) => x.trim()).filter((x): x is DraftFactKind => (ALL_KINDS as readonly string[]).includes(x)));
}

// ── 本来どの AIX の番だったか（aix-catalog のボタン×ピッカー）────────────
// 2026-10-09 竹内「作り話の歯止めの部分は AIX でちゃんと徹底して抑えられる」: 根拠の無い言い切りは「AIX の番を返信にした」読み違い。
//   止めるだけでなく、どの AIX で送る中身かを決めてスタッフに勧め（画面の帯・要対応）、ブレインの学習に戻す記録にする。
export type AixSuggestion = { catalogKey: string; label: string; why: string };
const AIX_LABEL: Record<string, string> = {
  "viewing_invite/通常": "内覧調整（候補日）", "viewing_invite/退去予定物件": "内覧調整（退去予定の部屋の内覧開始日）", meeting_place: "待ち合わせ場所（内覧の確定）",
  "property_check_result/mgmt_move_in": "物件確認した→管理会社に聞いた入居可能日", "property_check_result/vacate_date": "物件確認した→管理会社に聞いた退去予定日",
  "property_check_result/other_room_check": "物件確認した→同じ建物の別の部屋", "property_check_result/mgmt_equipment": "物件確認した→設備（資料・管理会社）",
  "property_check_result/mgmt_parking": "物件確認した→駐車場", "property_check_result/mgmt_pet": "物件確認した→ペットの可否",
  "property_check_result/owner_other": "物件確認した→オーナー・管理会社に確認した内容", cost_breakdown: "初期費用について（御見積書の内訳）",
  estimate_sheet: "見積書送る", "property_send/normal": "物件ピックアップした（資料を送る）", "property_recommendation/継続ピックアップ": "物件オススメ（1件の推しどころ）",
};
/** 根拠の無い事実 → 本来の AIX。文の中身（内覧・入居・退去）で日時の行き先を分ける */
export function aixForUngroundedFact(h: Pick<DraftFact, "kind" | "sentence">, ctx: { estimateSent?: boolean } = {}): AixSuggestion {
  const s = h.sentence;
  const pick = (catalogKey: string, why: string): AixSuggestion => ({ catalogKey, label: AIX_LABEL[catalogKey] ?? catalogKey, why });
  switch (h.kind) {
    case "date": case "time":
      if (/退去/.test(s)) return pick("property_check_result/vacate_date", "退去予定日は管理会社に聞いた事");
      if (/入居/.test(s) && !/内覧|ご案内|見学/.test(s)) return pick("property_check_result/mgmt_move_in", "入居可能日は管理会社に聞いた事");
      if (/待ち合わせ|現地|エントランス|お待ちして/.test(s)) return pick("meeting_place", "内覧の確定の日時はカレンダーで決めた事");
      return pick("viewing_invite/通常", "内覧の候補の日時はスタッフの空き（カレンダー）");
    case "room": return pick("property_check_result/other_room_check", "号室（同じ建物の別の部屋）は資料・管理会社で確かめた事");
    case "property_name": return pick("property_send/normal", "資料に無い物件はスタッフが検索して送る物");
    case "facility": case "area": case "floor": case "direction":
      // 物件の推しどころの箇条書き（「・南向きで採光良好」「・間取り:2LDK(60.24m2)」「好条件のお部屋」）は1件を推す AIX の中身（資料の画像から作る）
      if (/^\s*[・🌟◎]|オススメ|おすすめ|好条件/.test(s)) return pick("property_recommendation/継続ピックアップ", "推しどころは資料の画像から作る（物件オススメ）");
      return pick("property_check_result/mgmt_equipment", "物件の設備・広さ・階・向きは資料・管理会社で確かめる事");
    case "parking": return pick("property_check_result/mgmt_parking", "駐車場の有無・空きは管理会社に聞く事");
    case "pet": return pick("property_check_result/mgmt_pet", "ペットの可否は管理会社に聞く事");
    case "cost_item":
      if (/ペット/.test(s)) return pick("property_check_result/mgmt_pet", "ペットを飼う時の敷金は管理会社の条件");
      return ctx.estimateSent ? pick("cost_breakdown", "初期費用の内訳は送った御見積書の中身") : pick("estimate_sheet", "初期費用の内訳は御見積書で送る物");
    case "movein_immediate": return pick("property_check_result/mgmt_move_in", "即入居かは管理会社に聞いた事");
    case "vacate": return pick("property_check_result/vacate_date", "退去予定かは管理会社に聞いた事");
    case "cancel_fee": return pick("property_check_result/owner_other", "キャンセル料は管理会社・オーナーに確認する事");
  }
}

/**
 * 学習に戻す記録の形（ブレインが「返信」にした番で、下書きが AIX の中身を作った＝読み違い）。
 * 保存先は案（brain_decision_logs の digest に "fg" を足す or line_watch_turns.verdict_detail）。ここは形だけ決める（純関数）。
 */
export type GroundingMissRecord = { at: string; kind: DraftFactKind; value: string; aix: string; sentence: string };
export function groundingMissRecords(draft: string, groundText: string, at: string, ctx: { estimateSent?: boolean } = {}, kinds?: ReadonlySet<DraftFactKind>): GroundingMissRecord[] {
  return findUngroundedFacts(draft, groundText, kinds).map((h) => ({ at, kind: h.kind, value: h.value, aix: aixForUngroundedFact(h, ctx).catalogKey, sentence: Array.from(h.sentence).slice(0, 80).join("") }));
}
