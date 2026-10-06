// app/lib/closing-target.ts — 決め手の条件（「これが満たせれば決まる」物件の像）を会話から決定論で作る（純関数・DB/fetch 無し・画面からも使える）
//
// 2026-10-07 竹内さん（2件）:
//   ① H0N0KA.（バウスフラッツ新大阪 1002 を「よいです！すきです！」→「ただ家賃もう少し下がったりしないですよね」・減額不可）
//     「家賃下げる事はできないので、このお部屋の間取りや、条件を取り入れて、ここから家賃が更に5.000円程低いお部屋が見つかれば、決まるって考えにする。
//      そうすれば、もっと明確に物件検索をする事が出来るから　設計知見と協力して改善する　またこのような他のパターンも改善する」
//   ② ゆいと（ディアコート曽根 302 の後に「カウンターキッチンのとこは少ないですかね？」）
//     「次カウンターキッチンでお客さんの条件にあった物件があれば決まる」
//
// ■ 考え方
//   お客様が気に入った物件（直前の🌟）と「あと一つ」の不満・質問から、次に探す物件の像（決め手の条件）を作り、
//   物件検索ブレイン（判定の点・検索の一時の上書き）とブレイン（次の一手の方針）に同じ値で渡す。
//   ・家賃が理由 → 気に入った部屋の間取り・広さ・駅を基準に、管理費込みの家賃をその部屋より約5,000円低く（千円で切り下げ）
//   ・設備が理由 → 今の登録の条件＋その設備を必須
//   ・広さ／駅近／築年／階／初期費用（敷礼0）／日当たり／静かさ も同じ形（基準は気に入った部屋）
//
// ■ 型ごとの方針（登録の条件を直すか・一時の意図に留めるか。迷う物は一時の意図）
//   permanent（登録に入れてよい）: 設備（「その他・設備」に1つずつ＝feedback_wants_itemized）・数字のある階（「最低5階」）
//   temporary（その回の検索と採点だけ）: 家賃（1部屋から決めた数字）・初期費用・広さ／駅近／築年（比べの言い方）・日当たり・静かさ
//   ※ 登録の条件の書き換えはこのファイルではしない（generate-draft-bg-async の橋が registerHints を読む）
//
// ■ 線（scripts/audit-closing-target.ts で過去の🌟の後のお客様の発言を目で読んで決めた）
//   ・発言の型は「下げる／高い／欲しい／ない（評価）／〜のとこ（探す形）」の語がある時だけ。物件1件の有無の質問
//     （「ここ駐車場ありますか」「インターネットは付いてないかんじですか？」）は物件確認の流れなので型にしない
//   ・相場の質問（「平野区とかは家賃高いですか？」）・受け入れ（「遠くなっても」「古くても」）は型にしない
//   ・気に入った部屋＝その発言の前 7日以内の一番新しい🌟（AIX 物件オススメの本文。事実はこの本文＋売上サポの行から読む）

import { parseFactsFromText, parseStations as parseStationsLoose, roomFromName, toHalf, type Station } from "./candidate-facts";
import { parseEquipmentWants, readEquipmentItemsFromText, EQUIP_LABELS, type EquipKey } from "./listing-equipment";

export const CLOSING_TARGET_VERSION = "closing-target@2026-10-07";
/** 環境変数 CLOSING_TARGET_MODE=off で全部止める（判定の札・検索の上書き・ブレインの材料） */
export function closingTargetEnabled(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  return String(env.CLOSING_TARGET_MODE ?? "").toLowerCase() !== "off";
}

export type GapKind = "rent_lower" | "initial_cost" | "equipment" | "wider" | "closer" | "newer" | "floor_higher" | "sunlight" | "quiet";
export const GAP_KIND_JA: Record<GapKind, string> = {
  rent_lower: "家賃", initial_cost: "初期費用", equipment: "設備", wider: "広さ", closer: "駅近", newer: "築年",
  floor_higher: "階", sunlight: "日当たり", quiet: "静かさ（構造）",
};

/** 決め手の設備（listing-equipment の鍵＋収納） */
export type TargetEquip = { key: EquipKey | "storage"; label: string };

export type GapRead = {
  kind: GapKind;
  /** 当たった文（お客様の言葉そのまま・60字まで） */
  evidence: string;
  equipment?: TargetEquip[];
  /** 数字のある言い方（「最低5階」「50㎡〜」）＝登録に入れてよい */
  explicit?: { floorMin?: number; areaMin?: number; walkMax?: number; ageMax?: number } | null;
};

// ─── 発言の型 ──────────────────────────────────────────────────────────────

/** 物件の画面の書き起こし・URL・画像の読み取り（【キッチン】・設備欄:・[フロア図…]）の行は読まない（お客様が貼った物件の文） */
function customerSentences(text: string): string[] {
  const t = toHalf(String(text ?? "")).normalize("NFKC");
  if (/^\s*\[画像\]/.test(t)) return [];
  return t.split(/\n+|(?<=[。！!？?])/)
    .map((s) => s.trim())
    .filter((s) => s && !/https?:\/\/|by SUUMO|物件情報|【物件の画面|^\[|【[^】]{1,8}】|設備欄|^[・\-－*]/.test(s));
}

// 2026-10-07 監査（scripts/audit-closing-target.ts・400日の🌟の後 72時間の番 1,782）で目で読んで直した線:
//   「家賃は6万円以下が」（以下が→下が）・「初期費用もう少し安く」（初期費用の値引き＝見積の話）・「重複家賃」・「家賃は高くても9万までに上限上げよう」・
//   「申し込みの際…値下げ交渉」（決めた後の交渉）・「家賃希望を下げて…条件をなくしました」（登録の条件の言い直し＝条件の橋）は家賃の型にしない
const RENT_LOWER_RE = /(?:家賃|お家賃|賃料|月々|毎月)[^。！？!?\n]{0,12}?(?:(?<!以)下が|下げ|さが|安く|やすく|抑え|おさえ|値下げ|減額)|(?:家賃|お家賃|賃料)[^。！？!?\n]{0,8}?(?:高い|高め|高く(?:な|て)|高すぎ|範囲外|オーバー|超え)|(?:\d+(?:\.\d+)?万|[\d,]{5,}円)(?:円)?(?:は|って|だと)(?:ちょっと|少し|やや|まだ)?(?:高い|高め|厳しい)|もう少し(?:安|やす)(?:い|く)|(?:もう少し|もっと)家賃/;
const RENT_NOT_RE = /(?:家賃|予算|上限)[^。！？!?\n]{0,10}(?:上げ|あげ)(?:て|ても|る|よう|ます|ました)|高くても|相場|重複家賃|交渉|申し?込|希望を下げ|条件を(?:なくし|外し|変え)|(?:区|市|エリア|駅周辺|あたり|辺り)(?:とか|は|って|だと)?(?:は)?(?:家賃)?(?:高い|安い)(?:です|でしょう)?か/;
// 初期費用: 評価の言い切り（高くて・高かった）か、探す形（抑えれる物件・敷礼なしの所）だけ。1件の値引きの質問（安くなりませんか・安くできますか・高いでしょうか）は見積の流れ
const INITIAL_COST_RE = /初期(?:費用)?(?:が|も|は)?[^。！？!?\n]{0,6}?(?:高(?:くて|かった|すぎ|い(?:です|ので|けど|な|…|\.\.\.))|抑え(?:たい|れる|られる|め)|おさえ(?:たい|れる|られる)|安(?:い|め)の?(?:物件|部屋|お部屋|ところ|とこ|所))|初期費用[^。！？!?\n]{0,8}(?:物件|部屋|お部屋|ところ|とこ|所)(?:は|が|を)?(?:ない|あり|あれば|ありましたら)|敷(?:金)?(?:・|と)?礼(?:金)?(?:が)?(?:なし|無し|ない|0|ゼロ|かからない)の?(?:物件|部屋|お部屋|ところ|とこ|所|方)|礼金(?:が)?(?:なかったら|無かったら|なければ)/;
const INITIAL_COST_NOT_RE = /初期費用(?:は|って)?(?:いくら|どのくらい|どれくらい|教えて|知りたい|出して)|抑えて(?:頂|いただ|もら|くれ)|安くで済|高いでしょうか|高いですか/;
/** 設備の不満・希望の形（評価の言葉・探す形・欲しい） */
const EQUIP_GAP_FORM_RE = /(?:ない|無い|なし|無し)(?:の|と)?(?:は|が|で|ので|から|けど)?(?:厳し|きつ|キツ|無理|困|嫌|イヤ|ちょっと|不安|大変)|(?:ない|無い)と[^。！？!?]{0,10}(?:大変|厳し|きつ|困|不便)|少ない|少なくて|(?:の|が)(?:ある|付いてる|ついてる)?(?:とこ|ところ|所|部屋|お部屋|物件|マンション)(?:は|が|で|を)?(?:少な|ない|あり|探|希望|いい|良い)|(?:有り|あり|付き)の?(?:物件|部屋|お部屋|マンション|ところ|とこ)?で(?:探|お願い)|ほしい|欲しい|がいい|が良い|じゃないと|でないと|必須|希望(?:です|します|で|は)|あれば(?:嬉しい|うれしい|いい|良い|ありがたい)/;
/** 要らない・どちらでも（受け入れ）は希望にしない */
const EQUIP_NOT_RE = /(?:で|じゃ)?なくても|希望して(?:い|お)りません|どちらでも|不要|いらない|要らない|こだわらない/;
/** 物件1件の有無・費用の質問（ここ・この物件・名前＋は＋〜ありますか・でしょうか）＝物件確認。評価の言葉・探す形が無い時だけ */
const PROPERTY_QUESTION_RE = /(?:ありますか|有りますか|あるんですか|ついてますか|付いてますか|ないですか|ないかんじですか|ない感じですか|でしょうか|なりますか|かかりますか|高くなって)(?:ね)?[？?！!]*$|(?:ここ|こちら|この(?:物件|部屋|お部屋)|そこ|↑)(?:は|って|の|に|も)?/;
const EQUIP_STRONG_RE = /(?:とこ|ところ|所|部屋|物件|マンション)(?:は|が)?少な|厳し|きつ|キツ|無理|大変|欲しい|ほしい|で探して|希望(?:です|します)/;
// 広さ: お風呂・収納・WIC・キッチンの狭さ広さは部屋の広さではない。「とても広いお部屋ですが」（ほめ）は外す
const WIDER_RE = /(?<!(?:お風呂|風呂|浴室|バス|キッチン|収納|玄関|ベランダ|WIC|クローゼット)(?:が|は|も)?(?:だいぶ|少し|ちょっと|かなり)?)狭(?:い(?:です|な|かな|ので|けど|…|\.\.\.|😭|!|！|$)|すぎ|め|かった|く感じ)|(?:もう少し|もっと|少し)広(?:め|い|く)|(?<!(?:WIC|収納|クローゼット|ベランダ|キッチン|お風呂|浴室))広め(?:の|で|が)|広い(?:方|ほう|ところ|とこ|部屋|お部屋)(?:が|で)?(?:いい|良い|ありがたい|嬉しい|希望|あれば|ありますか|ない)/;
const WIDER_NOT_RE = /狭くても|広さ(?:以外|は)(?:全部|問題|大丈夫)|広くて/;
const CLOSER_RE = /駅(?:から|まで)?(?:が|は)?[^。]{0,3}遠(?:い|すぎ|かった|め)|(?:もう少し|もっと)駅(?:に|から|まで)?近|駅近(?:が|の方|のほう|で)|(?:もう少し|もっと)近(?:い|く)/;
const CLOSER_NOT_RE = /遠くても|遠くなっても|遠くなる(?:けど|が)|調べ|確認/;
// 築年:「新しい物件があれば送って」（新着）は築年ではない
const NEWER_RE = /(?:もう少し|もっと)築浅|築浅(?:の|が)(?:方|ほう|ところ|とこ|部屋|物件|お部屋)|古(?:い|すぎ|そう)(?:です|な|ので|けど|かな|のが|ですね|…|感じ)|古(?:め|い)の(?:は|が)|同じくらい古|(?:もう少し|もっと)新しい|新しい(?:方|ほう)(?:が|で)/;
const NEWER_NOT_RE = /古くても|古くて(?:も|いい)|築年数(?:は)?(?:気にしない|問わない)/;
const FLOOR_RE = /([2-9]|[1-3][0-9]|二|三|四|五|六|七|八|九|十)\s*階以上(?:は|が)?(?:ほしい|欲しい|希望|がいい|が良い|で|だと|なら)|最低\s*([2-9]|[1-3][0-9])\s*階|1階(?:は|が|だと)(?:ちょっと|嫌|イヤ|不安|怖|NG|避け)|一階(?:は|が|だと)(?:ちょっと|嫌|不安|怖)|上の階(?:が|の方|のほう)|高層(?:階)?(?:が|の方|のほう)/;
const SUN_RE = /日当たり(?:が)?(?:悪|良い(?:方|ほう|ところ|とこ|部屋))|北向き(?:は|が|だと)|暗(?:い|そう)(?:です|ので|けど|な|かな)/;
const QUIET_RE = /木造(?:は|が|だと)?(?:ちょっと|嫌|イヤ|避け|NG|音|うるさ)|音(?:が)?気にな|(?:鉄筋(?:コンクリート)?|RC)(?:が|の方|のほう|で)(?:いい|良い|希望|探)/;
const STORAGE_RE = /収納(?:が)?(?:少な|ない|無い|狭)|収納(?:が)?(?:多い|広い|ある)(?:方|ほう|とこ|ところ|部屋|お部屋)/;
const KANJI_NUM: Record<string, number> = { 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * お客様の発言（1通か、続けて送った数通をつないだ物）から「あと一つ」の型を読む（決定論）。
 * 1つの発言に複数の型があれば全部返す（並びは文の順）
 */
export function readClosingGaps(text: string | null | undefined): GapRead[] {
  const out: GapRead[] = [];
  const seen = new Set<GapKind>();
  const push = (g: GapRead) => { if (!seen.has(g.kind)) { seen.add(g.kind); out.push(g); } };
  for (const s of customerSentences(String(text ?? ""))) {
    const ev = s.slice(0, 60);
    if (RENT_LOWER_RE.test(s) && !RENT_NOT_RE.test(s) && !(/初期(?:費用)?/.test(s) && !/家賃|賃料|月々|毎月/.test(s))) push({ kind: "rent_lower", evidence: ev });
    if (INITIAL_COST_RE.test(s) && !INITIAL_COST_NOT_RE.test(s)) push({ kind: "initial_cost", evidence: ev });
    // 設備: 既存の希望の読み取り（parseEquipmentWants）で設備の鍵を出し、形（評価・探す形・欲しい）がある時だけ
    const eqs: TargetEquip[] = [];
    if (EQUIP_GAP_FORM_RE.test(s) && !EQUIP_NOT_RE.test(s) && !(PROPERTY_QUESTION_RE.test(s) && !EQUIP_STRONG_RE.test(s))) {
      for (const w of parseEquipmentWants({ preferences: s }).wants) {
        if (w.mode !== "must" || w.key === "floor" || w.key === "floor2" || w.key === "pet" || w.key === "two_person" || w.key === "no_guarantor" || w.key === "structure" || w.key === "bldg_type") continue;
        if (!eqs.some((e) => e.key === w.key)) eqs.push({ key: w.key as EquipKey, label: EQUIP_LABELS[w.key as EquipKey] ?? String(w.key) });
      }
    }
    if (STORAGE_RE.test(s)) eqs.push({ key: "storage", label: "収納" });
    if (eqs.length) push({ kind: "equipment", evidence: ev, equipment: eqs });
    if (WIDER_RE.test(s) && !WIDER_NOT_RE.test(s)) {
      const sq = s.match(/(\d{2,3})\s*(?:㎡|平米|m2)/);
      push({ kind: "wider", evidence: ev, explicit: sq ? { areaMin: parseInt(sq[1], 10) } : null });
    }
    if (CLOSER_RE.test(s) && !CLOSER_NOT_RE.test(s)) {
      const wm = s.match(/徒歩\s*(\d{1,2})\s*分/);
      push({ kind: "closer", evidence: ev, explicit: wm ? { walkMax: parseInt(wm[1], 10) } : null });
    }
    if (NEWER_RE.test(s) && !NEWER_NOT_RE.test(s)) {
      const am = s.match(/築\s*(\d{1,2})\s*年(?:以内|まで)/);
      push({ kind: "newer", evidence: ev, explicit: am ? { ageMax: parseInt(am[1], 10) } : null });
    }
    const fm = s.match(FLOOR_RE);
    if (fm) {
      const raw = fm[1] ?? fm[2] ?? null;
      const n = raw ? (KANJI_NUM[raw] ?? parseInt(raw, 10)) : null;
      push({ kind: "floor_higher", evidence: ev, explicit: n && n >= 2 ? { floorMin: n } : /1階|一階/.test(fm[0]) ? { floorMin: 2 } : null });
    }
    if (SUN_RE.test(s)) push({ kind: "sunlight", evidence: ev });
    if (QUIET_RE.test(s)) push({ kind: "quiet", evidence: ev });
  }
  return out;
}

/** 気に入った気持ちの言葉（理由の1行に「気に入った上で」と書くかだけに使う） */
export function soundsLiked(text: string | null | undefined): boolean {
  return /(?:良い|いい|よい)(?:です|ですね|と思|感じ|な)|好き|すき|気に入|素敵|かわいい|可愛い|理想|最高|魅力|気になって|気になります|好み/.test(String(text ?? "")) && !/いいので|良いので|よいので|いいから/.test(String(text ?? ""));
}

// ─── 気に入った部屋の事実 ─────────────────────────────────────────────────

export type FavoriteProperty = {
  name: string;
  room: string | null;
  /** 家賃・管理費（円）と合計（管理費込み・登録の rent_max と同じ扱い） */
  rent: number | null;
  admin: number | null;
  total: number | null;
  floorPlan: string | null;
  areaSqm: number | null;
  stations: Station[];
  walk: number | null;
  buildingAge: number | null;
  floor: number | null;
  /** 敷金・礼金が両方0（分からなければ null） */
  zeroInitial: boolean | null;
  equipmentText: string;
  at: string | null;
  /** 事実の出どころ（🌟の本文／売上サポの行） */
  sources: string[];
};

/** 🌟の1行目から物件名と号室（「🌟パウスフラッツ新大阪 1002」「🌟カーサ・クラシオンF 102号室」） */
/**
 * 🌟の物件名の行か。見積書の「🌟60,000円割引させて頂き」・「🌟最大限割引しました初期費用の御見積書同封」は物件名ではない
 *   （監査の1回目で見積書の🌟を気に入った部屋に取っていた）
 */
export function isStarNameLine(line: string): boolean {
  const l = String(line ?? "").trim();
  if (!/^🌟/.test(l)) return false;
  const body = l.replace(/^🌟+\s*/, "");
  return body.length >= 2 && body.length <= 60 && !/^[\d,，.０-９]/.test(body) && !/割引|御?見積|初期費用|節約|ご査収|年収|入社|勤務|勤続|生年月日|氏名|フリガナ|電話|〒|@/.test(body);
}

export function starNameRoom(text: string | null | undefined): { name: string; room: string | null } | null {
  // 1行目が「（室内イメージ）」・URL の時がある（H0N0KA. の🌟）＝🌟で始まる最初の行
  const first = toHalf(String(text ?? "")).split("\n").map((l) => l.trim()).find(isStarNameLine) ?? "";
  if (!first) return null;
  const body = first.replace(/^🌟+\s*/, "").replace(/[!！。]+$/, "").trim();
  if (!body) return null;
  const room = roomFromName(body);
  const name = room ? body.replace(new RegExp(`\\s*${room.replace(/[-]/g, "\\-")}\\s*(?:号室?)?\\s*$`), "").trim() : body;
  return { name: name || body, room };
}

/** 🌟の本文（AIX 物件オススメ）から気に入った部屋の事実を読む。読めなければ null */
export function favoriteFromStarText(text: string | null | undefined, at: string | null = null, now: Date | string = new Date()): FavoriteProperty | null {
  const nr = starNameRoom(text);
  if (!nr) return null;
  const t = toHalf(String(text ?? ""));
  const f = parseFactsFromText(t);
  // 「（合計95,200円）」があれば合計を正にする（家賃と管理費の読み違いに強い）
  const tot = t.replace(/,/g, "").match(/合計\s*(\d{5,7})\s*円/);
  const admin = f.admin_fee_yen ?? null;
  const total = tot ? parseInt(tot[1], 10) : f.rent != null ? f.rent + (admin ?? 0) : null;
  const year = f.built_ym ? parseInt(f.built_ym.slice(0, 4), 10) : null;
  const nowY = (typeof now === "string" ? new Date(now) : now).getUTCFullYear();
  const age = f.building_age ?? (year ? Math.max(0, nowY - year) : null);
  const stations = (f.stations ?? []).map((s) => ({ ...s, station: s.station.replace(/^[・･\s]+/, "") })).filter((s) => s.station);
  return {
    name: nr.name, room: nr.room, rent: f.rent ?? null, admin, total, floorPlan: f.floor_plan ?? null, areaSqm: f.area_sqm ?? null,
    stations, walk: stations.length ? Math.min(...stations.map((s) => s.walk)) : null, buildingAge: age,
    floor: f.floor ?? (nr.room && /^\d{3,4}$/.test(nr.room) ? Math.floor(parseInt(nr.room, 10) / 100) || null : null),
    zeroInitial: f.deposit_months === 0 && f.key_money_months === 0 ? true : /敷金(?:礼金)?(?:なし|無し|0)|敷礼(?:なし|0)/.test(t) ? true : null,
    equipmentText: t, at, sources: ["🌟の本文"],
  };
}

/** 売上サポの行（property_pickups の説明文・terms・location）で空いている事実を埋める（上書きしない） */
export function fillFavoriteFromPickup(fav: FavoriteProperty, row: { summary_text?: string | null; terms?: unknown; location?: unknown; equipment?: unknown } | null | undefined): FavoriteProperty {
  if (!row) return fav;
  const out = { ...fav, stations: [...fav.stations], sources: [...fav.sources] };
  const f = parseFactsFromText(String(row.summary_text ?? ""));
  let used = false;
  if (out.rent == null && f.rent != null) { out.rent = f.rent; used = true; }
  if (out.admin == null && f.admin_fee_yen != null) { out.admin = f.admin_fee_yen; used = true; }
  if (out.total == null && out.rent != null) out.total = out.rent + (out.admin ?? 0);
  if (out.areaSqm == null && f.area_sqm != null) { out.areaSqm = f.area_sqm; used = true; }
  if (out.floorPlan == null && f.floor_plan) { out.floorPlan = f.floor_plan; used = true; }
  const terms = (row.terms ?? null) as { buildingAge?: number | null; deposit?: number | null; keyMoney?: number | null } | null;
  if (out.buildingAge == null && typeof terms?.buildingAge === "number") { out.buildingAge = terms.buildingAge; used = true; }
  if (out.zeroInitial == null && terms && typeof terms.deposit === "number" && typeof terms.keyMoney === "number") { out.zeroInitial = terms.deposit === 0 && terms.keyMoney === 0; used = true; }
  const loc = (row.location ?? null) as { stations?: Array<{ line?: string | null; station?: string; walk?: number }> } | null;
  for (const s of loc?.stations ?? []) {
    if (!s?.station || typeof s.walk !== "number") continue;
    if (!out.stations.some((x) => x.station === s.station)) { out.stations.push({ line: s.line ?? null, station: s.station, walk: s.walk }); used = true; }
  }
  if (out.walk == null && out.stations.length) out.walk = Math.min(...out.stations.map((s) => s.walk));
  const eq = (row.equipment ?? null) as { line?: string | null } | null;
  if (eq?.line) out.equipmentText = `${out.equipmentText}\n${eq.line}`;
  if (used) out.sources.push("売上サポの行");
  return out;
}

// ─── 決め手の条件 ─────────────────────────────────────────────────────────

/** 今の登録の条件（必要な欄だけ） */
export type CurrentConditions = {
  rent_max?: number | null; floor_plan?: string | null; floor_area_min?: number | null; walk_minutes?: number | null;
  building_age?: number | null; desired_area?: string | null; preferences?: string | null;
  /** 駅で探している人（station）だけ、物件の駅が場所の目安に1つも無い時を「外れ」と言える（区・市で探す人は駅名で決められない） */
  area_mode?: string | null;
};

export type ClosingTarget = {
  v: typeof CLOSING_TARGET_VERSION;
  kind: GapKind;
  kinds: GapKind[];
  /** きっかけの発言（お客様の言葉）と時刻 */
  evidence: string;
  at: string | null;
  liked: boolean;
  favorite: FavoriteProperty | null;
  /** 像（決め手の条件）。無い欄は登録の条件のまま */
  want: {
    rentMaxTotal?: number;
    floorPlans?: string[];
    areaMin?: number;
    walkMax?: number;
    buildingAgeMax?: number;
    floorMin?: number;
    equipment?: TargetEquip[];
    zeroInitial?: boolean;
    /** 場所の目安（気に入った部屋の駅＋登録のエリアの語）。検索は登録のまま・採点で近い物を上げる */
    places?: string[];
    /** 場所の目安が駅の名前だけ（area_mode=station）＝物件の駅が目安に無ければ外れ */
    placesAreStations?: boolean;
  };
  /** 一番の型の方針 */
  scope: "temporary" | "permanent";
  /** permanent の時に登録の条件へ足してよい物（橋が読む）。temporary は空 */
  registerHints: Array<{ field: "preferences" | "floor_area_min" | "walk_minutes" | "building_age"; value: string | number; label: string }>;
  /** 根拠の1行（画面・ブレイン・記録に出す） */
  rationale: string;
};

/** 気に入った部屋より約5,000円低い所（管理費込み・千円で切り下げ） */
export const RENT_LOWER_STEP_YEN = 5000;
/** 広さは気に入った部屋の9割まで（同じくらい）／もう少し広くは1割増し */
export const AREA_SAME_RATIO = 0.9;
export const AREA_WIDER_RATIO = 1.1;

const PLAN_TOKEN_RE = /([1-9])\s*(S?LDK|S?DK|S?K|R)/gi;
function plansOf(s: string | null | undefined): string[] {
  return [...toHalf(String(s ?? "")).matchAll(PLAN_TOKEN_RE)].map((m) => `${m[1]}${m[2].toUpperCase()}`);
}
function placesOf(fav: FavoriteProperty | null, cur: CurrentConditions): string[] {
  const out: string[] = [];
  for (const s of fav?.stations ?? []) if (s.walk <= 15 && !out.includes(s.station)) out.push(s.station);
  for (const a of toHalf(String(cur.desired_area ?? "")).split(/[、,・\s/]+/)) {
    const k = a.replace(/(?:駅|周辺|付近|エリア|あたり|辺り)$/, "").replace(/^大阪市/, "").trim();
    if (k && k.length <= 8 && !out.includes(k)) out.push(k);
  }
  return out.slice(0, 8);
}
const man = (y: number) => `${Math.round(y / 1000) / 10}万円`;

/** 型（一番目）ごとの方針。数字のある言い方と設備は登録してよい・それ以外は一時の意図 */
export function scopeOfGap(g: GapRead): "temporary" | "permanent" {
  if (g.kind === "equipment") return "permanent";
  if (g.kind === "floor_higher" && g.explicit?.floorMin) return "permanent";
  if ((g.kind === "wider" && g.explicit?.areaMin) || (g.kind === "closer" && g.explicit?.walkMax) || (g.kind === "newer" && g.explicit?.ageMax)) return "permanent";
  return "temporary";
}

/**
 * 決め手の条件を作る。gaps の先頭が一番の型（同じ発言の他の型も像に入れる）。
 * 家賃・初期費用・広さ・駅近・築年は気に入った部屋が要る（無ければその型は像に入れない＝登録の条件の話は条件の橋に任せる）
 */
export function buildClosingTarget(input: { gaps: GapRead[]; favorite: FavoriteProperty | null; current: CurrentConditions; text?: string | null; at?: string | null }): ClosingTarget | null {
  const { favorite: fav, current: cur } = input;
  const want: ClosingTarget["want"] = {};
  const parts: string[] = [];
  const kinds: GapKind[] = [];
  const hints: ClosingTarget["registerHints"] = [];
  for (const g of input.gaps) {
    switch (g.kind) {
      case "rent_lower": {
        if (!fav?.total) continue;
        const cap = Math.floor((fav.total - RENT_LOWER_STEP_YEN) / 1000) * 1000;
        want.rentMaxTotal = cur.rent_max ? Math.min(cur.rent_max, cap) : cap;
        if (fav.floorPlan) want.floorPlans = [fav.floorPlan, ...plansOf(cur.floor_plan).filter((p) => p !== fav.floorPlan)];
        if (fav.areaSqm) want.areaMin = Math.floor(fav.areaSqm * AREA_SAME_RATIO);
        parts.push(`家賃は管理費込み${man(want.rentMaxTotal)}以内（気に入った部屋 ${man(fav.total)}より約5千円低く）`);
        break;
      }
      case "initial_cost": {
        want.zeroInitial = true;
        if (fav?.floorPlan && !want.floorPlans) want.floorPlans = [fav.floorPlan, ...plansOf(cur.floor_plan).filter((p) => p !== fav.floorPlan)];
        parts.push("敷金礼金なし（初期費用を抑えられる部屋）");
        break;
      }
      case "equipment": {
        const eqs = g.equipment ?? [];
        if (!eqs.length) continue;
        want.equipment = [...(want.equipment ?? []), ...eqs.filter((e) => !(want.equipment ?? []).some((x) => x.key === e.key))];
        for (const e of eqs) if (!new RegExp(e.label.replace(/[・]/g, ".?")).test(String(cur.preferences ?? ""))) hints.push({ field: "preferences", value: e.key === "counter_kitchen" ? "カウンターキッチン" : e.label, label: "設備" });
        parts.push(`${eqs.map((e) => e.key === "counter_kitchen" ? "カウンターキッチン" : e.label).join("・")}付き（今の条件のまま）`);
        break;
      }
      case "wider": {
        const v = g.explicit?.areaMin ?? (fav?.areaSqm ? Math.ceil(fav.areaSqm * AREA_WIDER_RATIO) : null);
        if (!v) continue;
        want.areaMin = v;
        if (g.explicit?.areaMin) hints.push({ field: "floor_area_min", value: v, label: "広さ" });
        parts.push(`広さ ${v}㎡以上${fav?.areaSqm && !g.explicit?.areaMin ? `（気に入った部屋 ${fav.areaSqm}㎡より広く）` : ""}`);
        break;
      }
      case "closer": {
        const v = g.explicit?.walkMax ?? (fav?.walk ? Math.max(5, Math.floor((fav.walk - 1) / 5) * 5) : null);
        if (!v) continue;
        want.walkMax = cur.walk_minutes ? Math.min(cur.walk_minutes, v) : v;
        if (g.explicit?.walkMax) hints.push({ field: "walk_minutes", value: v, label: "駅徒歩" });
        parts.push(`駅徒歩${want.walkMax}分以内${fav?.walk && !g.explicit?.walkMax ? `（気に入った部屋 ${fav.walk}分より近く）` : ""}`);
        break;
      }
      case "newer": {
        const v = g.explicit?.ageMax ?? (fav?.buildingAge != null && fav.buildingAge > 5 ? Math.max(5, Math.floor((fav.buildingAge - 1) / 10) * 10) : null);
        if (!v) continue;
        want.buildingAgeMax = cur.building_age ? Math.min(cur.building_age, v) : v;
        if (g.explicit?.ageMax) hints.push({ field: "building_age", value: v, label: "築年" });
        parts.push(`築${want.buildingAgeMax}年以内${fav?.buildingAge != null && !g.explicit?.ageMax ? `（気に入った部屋 築${fav.buildingAge}年より新しく）` : ""}`);
        break;
      }
      case "floor_higher": {
        const v = g.explicit?.floorMin ?? (fav?.floor ? fav.floor + 1 : 2);
        want.floorMin = v;
        parts.push(`${v}階以上`);
        break;
      }
      case "sunlight": {
        want.equipment = [...(want.equipment ?? []), { key: "south", label: EQUIP_LABELS.south }];
        parts.push("南向き（日当たり）");
        break;
      }
      case "quiet": {
        want.equipment = [...(want.equipment ?? []), { key: "rc", label: "鉄筋コンクリート" }];
        parts.push("鉄筋コンクリート（音の静かさ）");
        break;
      }
    }
    kinds.push(g.kind);
  }
  if (!kinds.length) return null;
  const main = input.gaps.find((g) => g.kind === kinds[0])!;
  // 気に入った部屋を基準にする型（家賃・初期費用・広さ・駅近・築年・階）は場所の目安も付ける
  if (fav && kinds.some((k) => k !== "equipment")) { want.places = placesOf(fav, cur); if (cur.area_mode === "station") want.placesAreStations = true; }
  const scope = scopeOfGap(main);
  const liked = soundsLiked(input.text ?? main.evidence);
  const favLine = fav ? `${fav.name}${fav.room ? ` ${fav.room}` : ""}${liked ? "を気に入った上で" : "の後に"}` : "";
  const rationale = `${favLine}「${main.evidence.slice(0, 40)}」→ ${parts.join("・")} の物件が見つかれば決まる`;
  return {
    v: CLOSING_TARGET_VERSION, kind: kinds[0], kinds, evidence: main.evidence, at: input.at ?? null, liked, favorite: fav, want,
    scope, registerHints: scope === "permanent" ? hints : [], rationale,
  };
}

// ─── 物件が像に合うか（判定の札・状態の決定で同じ関数） ────────────────────

/** 1件の物件の事実（判定の PropertyFacts と🌟の本文の読みの両方から作れる形） */
export type CandidateLike = {
  total: number | null;
  floorPlan: string | null;
  areaSqm: number | null;
  walk: number | null;
  buildingAge: number | null;
  floor: number | null;
  zeroInitial: boolean | null;
  /** 設備・駅・説明を含む文字（資料の文字層があればそれも） */
  text: string;
};

export type AxisResult = { axis: string; result: "ok" | "miss" | "unknown" };

/** 型の軸ごとに合うかを見る（unknown＝材料が無い・合わないとは言わない） */
export function checkAgainstTarget(t: ClosingTarget, c: CandidateLike): AxisResult[] {
  const w = t.want;
  const r: AxisResult[] = [];
  const cmp = (axis: string, ok: boolean | null) => r.push({ axis, result: ok == null ? "unknown" : ok ? "ok" : "miss" });
  if (w.rentMaxTotal != null) cmp("rent", c.total == null ? null : c.total <= w.rentMaxTotal);
  if (w.floorPlans?.length) cmp("layout", c.floorPlan == null ? null : w.floorPlans.includes(c.floorPlan.toUpperCase()));
  if (w.areaMin != null) cmp("size", c.areaSqm == null ? null : c.areaSqm >= w.areaMin);
  if (w.walkMax != null) cmp("walk", c.walk == null ? null : c.walk <= w.walkMax);
  if (w.buildingAgeMax != null) cmp("age", c.buildingAge == null ? null : c.buildingAge <= w.buildingAgeMax);
  if (w.floorMin != null) cmp("floor", c.floor == null ? null : c.floor >= w.floorMin);
  if (w.zeroInitial) cmp("zero", c.zeroInitial);
  if (w.equipment?.length) {
    const items = readEquipmentItemsFromText(c.text);
    for (const e of w.equipment) {
      if (e.key === "storage") { cmp("equip:storage", /収納|クローゼット|ウォークイン|WIC|納戸|物入|シューズ(?:ボックス|BOX|クローク)/i.test(c.text) ? true : null); continue; }
      const st = items[e.key as EquipKey]?.status;
      cmp(`equip:${e.key}`, st === "ok" ? true : st === "ng" ? false : null);
    }
  }
  if (w.places?.length) {
    const hit = w.places.some((p) => p && c.text.includes(p));
    // 駅で探している人で、物件の駅が読めて目安の駅が1つも無い時だけ外れ（H0N0KA. の江坂 203: 家賃は合うが新大阪・東三国の外）
    const known = parseStationsLoose(c.text).length > 0;
    cmp("place", hit ? true : w.placesAreStations && known ? false : null);
  }
  return r;
}

/** 一番の型の軸（これが合えば「決め手に当たる」） */
export function mainAxesOf(t: ClosingTarget): string[] {
  switch (t.kind) {
    case "rent_lower": return ["rent"];
    case "initial_cost": return ["zero"];
    case "equipment": return (t.want.equipment ?? []).map((e) => `equip:${e.key}`);
    case "wider": return ["size"];
    case "closer": return ["walk"];
    case "newer": return ["age"];
    case "floor_higher": return ["floor"];
    case "sunlight": return ["equip:south"];
    case "quiet": return ["equip:rc"];
  }
}

export type TargetFit = "fit" | "main_ok" | "main_miss" | "unknown";
/** fit＝一番の軸が合い・外れの軸が無い／main_ok＝一番の軸は合うが他に外れ（場所の目安の外など）／main_miss＝一番の軸が外れ */
export function fitOf(t: ClosingTarget, c: CandidateLike): { fit: TargetFit; axes: AxisResult[] } {
  const axes = checkAgainstTarget(t, c);
  const main = mainAxesOf(t);
  const mainRes = axes.filter((a) => main.includes(a.axis));
  if (!mainRes.length || mainRes.every((a) => a.result === "unknown")) return { fit: "unknown", axes };
  if (mainRes.some((a) => a.result === "miss")) return { fit: "main_miss", axes };
  if (mainRes.some((a) => a.result === "unknown")) return { fit: "unknown", axes };
  // 場所の目安は「合う」だけ数える（書いていない＝unknown は外れにしない）
  return { fit: axes.some((a) => a.result === "miss") ? "main_ok" : "fit", axes };
}

// ─── 判定（property-brain）の札 ───────────────────────────────────────────

/** 札の点。決め手に当たる物件を上げる（加点だけ・推測の像なので外れの減点はしない） */
export const CLOSING_POINTS: Record<string, number> = { CLOSING_FIT: 12, CLOSING_MAIN_OK: 6, CLOSING_MAIN_MISS: 0, CLOSING_NEAR_FAVORITE: 0 };
export const CLOSING_JA: Record<string, string> = {
  CLOSING_FIT: "🎯 決め手の条件に合う（これが見つかれば決まる物件）",
  CLOSING_MAIN_OK: "🎯 決め手の条件の一番の点は合う（他の点は要確認・場所の目安の外など）",
  CLOSING_MAIN_MISS: "決め手の条件の一番の点が合わない",
  CLOSING_NEAR_FAVORITE: "気に入った部屋の駅・希望エリアの近く",
};
export const CLOSING_CODES = Object.keys(CLOSING_POINTS);

/** 判定に渡す形（像と、資料の文字層＝設備を読む文字） */
export type ClosingTargetJudgeInput = { target: ClosingTarget; equipmentText?: string | null };

/** 判定の事実（property-brain の PropertyFacts と同じ鍵の一部）→ 札 */
export function closingTargetCodes(facts: { rentYen: number | null; adminFeeYen: number | null; floorPlan: string | null; areaSqm?: number | null; walkMinutes: number | null; buildingAge: number | null; depositMonths: number | null; keyMoneyMonths: number | null; roomNo?: string | null; rawText: string }, input: ClosingTargetJudgeInput): string[] {
  const c: CandidateLike = {
    total: facts.rentYen != null ? facts.rentYen + (facts.adminFeeYen ?? 0) : null,
    floorPlan: facts.floorPlan, areaSqm: facts.areaSqm ?? null, walk: facts.walkMinutes, buildingAge: facts.buildingAge,
    floor: facts.roomNo && /^\d{3,4}$/.test(facts.roomNo) ? Math.floor(parseInt(facts.roomNo, 10) / 100) || null : null,
    zeroInitial: facts.depositMonths == null || facts.keyMoneyMonths == null ? null : facts.depositMonths === 0 && facts.keyMoneyMonths === 0,
    text: `${facts.rawText ?? ""}\n${input.equipmentText ?? ""}`,
  };
  const { fit, axes } = fitOf(input.target, c);
  const out: string[] = [];
  if (fit === "fit") out.push("CLOSING_FIT");
  else if (fit === "main_ok") out.push("CLOSING_MAIN_OK");
  else if (fit === "main_miss") out.push("CLOSING_MAIN_MISS");
  if (axes.some((a) => a.axis === "place" && a.result === "ok")) out.push("CLOSING_NEAR_FAVORITE");
  return out;
}

/** 🌟の本文 → 像に当てる形 */
export function candidateFromStarText(text: string, now: Date | string = new Date()): CandidateLike | null {
  const f = favoriteFromStarText(text, null, now);
  if (!f) return null;
  return { total: f.total, floorPlan: f.floorPlan, areaSqm: f.areaSqm, walk: f.walk, buildingAge: f.buildingAge, floor: f.floor, zeroInitial: f.zeroInitial, text: f.equipmentText };
}

// ─── 検索の一時の上書き（search-override.ts の SearchOverride と同じ欄・登録の条件と違う所だけ） ───

export type ClosingSearchOverride = {
  v: 1; location: null; floor_plan: string | null; rent_max: number | null; rent_min: null; walk_minutes: number | null;
  building_age: number | null; area_min: number | null; area_max: null; pet: null; floor_min: number | null; site: null; is_wide: null;
};

/** 像 → その回だけの検索の上書き。サイトで絞れない物（設備・場所の目安）は入れない。変わる欄が無ければ null */
export function closingSearchOverride(t: ClosingTarget, cur: CurrentConditions): ClosingSearchOverride | null {
  const w = t.want;
  const rent = w.rentMaxTotal != null && w.rentMaxTotal !== cur.rent_max ? w.rentMaxTotal : null;
  const curPlans = plansOf(cur.floor_plan);
  const plans = w.floorPlans?.length && (w.floorPlans.length !== curPlans.length || w.floorPlans.some((p) => !curPlans.includes(p))) ? w.floorPlans.join("・") : null;
  const area = w.areaMin != null && w.areaMin !== cur.floor_area_min ? w.areaMin : null;
  const walk = w.walkMax != null && w.walkMax !== cur.walk_minutes ? w.walkMax : null;
  const age = w.buildingAgeMax != null && w.buildingAgeMax !== cur.building_age ? w.buildingAgeMax : null;
  const floor = w.floorMin != null && w.floorMin >= 2 ? w.floorMin : null;
  if (rent == null && plans == null && area == null && walk == null && age == null && floor == null) return null;
  return { v: 1, location: null, floor_plan: plans, rent_max: rent, rent_min: null, walk_minutes: walk, building_age: age, area_min: area, area_max: null, pet: null, floor_min: floor, site: null, is_wide: null };
}

// ─── 会話から（サーバーが読んだ発言を渡す） ─────────────────────────────────

/** AIX 物件オススメの本文（🌟で始まる行がある） */
export const STAR_RE = { test: (text: string): boolean => String(text ?? "").split("\n").some(isStarNameLine) };

export type ConvMessage = { sender: string; text: string | null; created_at: string };

export type ClosingTargetState = {
  target: ClosingTarget;
  /** active＝まだ見つかっていない／partial＝一番の点は合う物を送ったが他が外れ／found＝決め手に合う物を送った */
  status: "active" | "partial" | "found";
  /** found・partial の時に送った物件（🌟の本文の1行目） */
  sentAfter: Array<{ name: string; room: string | null; at: string; fit: TargetFit }>;
};

/** 像が効く長さ（発言から21日・それより古い不満は次の検索に使わない） */
export const CLOSING_TARGET_TTL_DAYS = 21;
/** 気に入った部屋＝発言の前この日数以内の一番新しい🌟 */
export const FAVORITE_LOOKBACK_DAYS = 7;

/**
 * 会話（古い順でも新しい順でもよい）から、一番新しい「あと一つ」の発言で像を作り、その後の🌟で状態を決める。
 *   pickupRows を渡すと、気に入った部屋の空いている事実（広さ・駅・築年）を埋める（同じ建物の照合は呼ぶ側の matcher）
 */
export function closingTargetFromConversation(input: {
  messages: ConvMessage[];
  current: CurrentConditions;
  now?: Date | string;
  enrichFavorite?: (fav: FavoriteProperty) => FavoriteProperty;
}): ClosingTargetState | null {
  const now = input.now ? new Date(input.now) : new Date();
  const msgs = [...input.messages].filter((m) => m && m.created_at && Date.parse(m.created_at) <= now.getTime()).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const ttlFrom = now.getTime() - CLOSING_TARGET_TTL_DAYS * 86400_000;
  // 続けて送った発言（同じ番＝間にスタッフの発言が無い）をつなぐ
  type Turn = { text: string; at: string; idx: number };
  const turns: Turn[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.sender !== "customer" || !m.text) continue;
    const prev = turns[turns.length - 1];
    const prevMsg = msgs[i - 1];
    if (prev && prevMsg && prevMsg.sender === "customer") { prev.text += `\n${m.text}`; prev.at = m.created_at; prev.idx = i; }
    else turns.push({ text: m.text, at: m.created_at, idx: i });
  }
  for (let k = turns.length - 1; k >= 0; k--) {
    const turn = turns[k];
    if (Date.parse(turn.at) < ttlFrom) break;
    const gaps = readClosingGaps(turn.text);
    if (!gaps.length) continue;
    const tAt = Date.parse(turn.at);
    const starBefore = msgs.slice(0, turn.idx).reverse().find((m) => m.sender === "staff" && STAR_RE.test(m.text ?? "") && tAt - Date.parse(m.created_at) <= FAVORITE_LOOKBACK_DAYS * 86400_000);
    let fav = starBefore ? favoriteFromStarText(starBefore.text, starBefore.created_at, now) : null;
    if (fav && input.enrichFavorite) fav = input.enrichFavorite(fav);
    const target = buildClosingTarget({ gaps, favorite: fav, current: input.current, text: turn.text, at: turn.at });
    if (!target) continue;
    const sentAfter: ClosingTargetState["sentAfter"] = [];
    for (const m of msgs.slice(turn.idx + 1)) {
      if (m.sender !== "staff" || !STAR_RE.test(m.text ?? "")) continue;
      const nr = starNameRoom(m.text);
      const cand = candidateFromStarText(m.text ?? "", now);
      if (!nr || !cand) continue;
      sentAfter.push({ name: nr.name, room: nr.room, at: m.created_at, fit: fitOf(target, cand).fit });
    }
    const status: ClosingTargetState["status"] = sentAfter.some((s) => s.fit === "fit") ? "found" : sentAfter.some((s) => s.fit === "main_ok") ? "partial" : "active";
    return { target, status, sentAfter };
  }
  return null;
}

// ─── ブレインに渡す材料（変わる側・会話ごと） ───────────────────────────────

const STATUS_JA: Record<ClosingTargetState["status"], string> = {
  active: "まだ見つかっていない（次の物件検索・物件オススメはこの像に合う物を先に）",
  partial: "一番の点は合う物を送ったが、他の点（場所の目安など）が外れ＝まだ探す",
  found: "この像に合う物件を送った（その物件で内覧・申込へ進める）",
};

/** 物件検索統括の下に足す数行（材料だけ・言い回しの指示は書かない） */
export function buildClosingTargetBrainNote(st: ClosingTargetState | null | undefined): string {
  if (!st) return "";
  const t = st.target;
  const at = t.at ? (() => { const d = new Date(Date.parse(t.at!) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; })() : "";
  const sent = st.sentAfter.filter((s) => s.fit !== "unknown").slice(-2).map((s) => `${s.name}${s.room ? ` ${s.room}` : ""}（${s.fit === "fit" ? "像に合う" : s.fit === "main_ok" ? "一番の点は合う" : "一番の点が外れ"}）`);
  return `
【決め手の条件（closing-target・会話から決定論）】
きっかけ: ${at} お客様「${t.evidence.slice(0, 50)}」（型: ${t.kinds.map((k) => GAP_KIND_JA[k]).join("・")}）
像: ${t.rationale}
状態: ${STATUS_JA[st.status]}${sent.length ? `／送った後の🌟: ${sent.join("・")}` : ""}
扱い: ${t.scope === "permanent" ? "登録の条件に足してよい型" : "その回の検索と採点だけ（登録の条件は変えない）"}`;
}
