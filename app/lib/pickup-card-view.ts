// app/lib/pickup-card-view.ts（純関数・DB 依存なし・画面とサーバーで共用）
// 売上サポのピックアップの物件カードを「リアプロの物件一覧と同じ並びと表記」にするための値と、
// 同じお客様に短い間に届いた複数の回（リアプロ／itandi の別送り）を1つにまとめる寄せ方。
//
// 2026-09-25 竹内（売上サポのスマホの画面を見て）:
//   「まとめられていない。1件ずつごちゃごちゃしてて読みにくいので、内訳や分析した内容等は折りたたんで詳細押したら出るようにする。
//    リアプロの物件一覧と同じ見た目にして、図面だけ今と同じようにして、図面の下にリアプロの物件一覧の項目の表記で物件出したら分かりやすい。
//    点数の項目も入れて」
//   リアプロの物件一覧: 建物の段＝写真・物件名・住所・沿線「〇〇線『〇〇』徒歩N分」・点数の丸い札（○75点・△62点）
//                      部屋の段＝部屋名・状態/入居可能日・間取り/㎡・賃料/管理費・敷金/礼金・保証金/償却・AD（茶色の見出し帯・白い値の段）
// 決まり:
//   - 値は保存済みの物だけから作る（説明文 summary_text → 資料の表の照合 terms → 場所 location → 設備 equipment → 画像の読み取り image_lines の順）。
//     書いていない値は「－」（無いとは限らない）。ここで推測して埋めない
//   - 説明文の末尾に付く「🧠 ブレイン判定 …」のまとめ（空行の後）は物件の値として読まない
//   - まとめの回: 担当の拡張が付ける round_id（「完了」までの1回分）があればそれで寄せる。無い古い行は届いた時刻で寄せる
//     （前の回から 30分以内・最初から 3時間以内）。round_id のある回と無い回は混ぜない
import { buildReasonView, sortForReview, type ReviewOrderRow } from "./pickup-review-order";
import { moveInLabel, type PickupTerms } from "./pickup-terms";
import { reasonPoints, reasonJa, fitVerdictOf, summarizeFit, equipKeyLabel, scoreFromCodes, AD_HELD_SUFFIX, EQUIP_CAP_CODE, EQUIP_STRONG_NG_CAP, BASE_SCORE, SCORE_MAX } from "./property-brain";

export const DASH = "－";

/** カードに要る行の値（property_pickups の詳細 API の1行の一部） */
export type PickupCardInput = {
  rank: number;
  property_name: string;
  room_no: string | null;
  summary_text: string | null;
  verdict: string | null;
  score: number | null;
  ad_yen: number | null;
  recommended?: number;
  site?: string | null;
  image_lines?: string[] | null;
  reason_codes?: string[] | null;
  reasons_ja?: string[] | null;
  terms?: Partial<Pick<PickupTerms, "deposit" | "keyMoney" | "guaranteeDeposit" | "buildingAge" | "newBuild" | "moveIn" | "evidence">> | null;
  location?: { ward?: string | null; stations?: Array<{ station?: string | null; line?: string | null; walk?: number | null }> | null } | null;
  /** match: 設備の希望ごとの照合（strong＝必須）。× と読めない（－）の札には強さが無いので、カードの「必須・外れ」「必須・要確認」はここから引く */
  equipment?: { roomFloor?: number | null; totalFloors?: number | null; basement?: boolean | null; match?: Array<{ key?: string | null; strong?: boolean | null }> | null } | null;
};

/**
 * 項目の色（2026-09-25 竹内「カードの項目もお客さんの理想の条件に合わせて表示する。AD。各項目の点数」）:
 *   ok＝お客様の条件に合う（緑）／wide＝広げた検索の幅の中（薄い緑）／ng＝合わない（赤）／unread＝読めない・要確認（灰）／info＝書いていない条件・事実（色なし）
 */
export type CellTone = "ok" | "wide" | "ng" | "unread" | "info";
export type CardCell = {
  key: string; head: string; value: string; sub: string | null;
  /** この項目に付いた点（札の点の合計）。点の付かない事実の項目は null */
  points?: number | null;
  tone?: CellTone | null;
  /** お客様が書いた条件の項目（上に並べる） */
  written?: boolean;
  /** 「初期費用を抑えたい・一致」「書いていない」 */
  note?: string | null;
  /** この項目に入れた札（詳細の内訳・テスト用） */
  codes?: string[];
};
export type CardMark = { symbol: "○" | "△" | "×" | "－"; tone: "pass" | "hold" | "drop" | "none"; label: string; score: number | null };
export type CardHeadline = { text: string; tone: "drop" | "minus" | "plus" | "info" };

export type PickupCardView = {
  /** 物件名（itandi の「物件」だけの名前は null） */
  name: string | null;
  /** 号室（「202」） */
  room: string | null;
  /** 住所（保存しているのは区・市まで。無ければ null） */
  address: string | null;
  /** 沿線「谷町線「四天王寺前夕陽ヶ丘」徒歩4分」 */
  access: string | null;
  /** 築年・階建（「築5年・9階建」） */
  building: string | null;
  mark: CardMark;
  /** 部屋の段（リアプロの見出しの順）＋点数 */
  cells: CardCell[];
  /** 畳んだ時に見せる一番大事な1行 */
  headline: CardHeadline | null;
};

type SummaryParts = { name: string | null; room: string | null; rent: string | null; admin: string | null; madori: string | null; sqm: string | null; access: string | null; ad: string | null };

const PLACEHOLDER_NAMES = new Set(["物件", "物件名", "不明", "-", "－"]);

/** 説明文（拡張の summary_text）を読む。空行の後（ブレイン判定のまとめ）は読まない */
export function parseSummaryText(summary: string | null | undefined): SummaryParts {
  const out: SummaryParts = { name: null, room: null, rent: null, admin: null, madori: null, sqm: null, access: null, ad: null };
  if (!summary) return out;
  const block = summary.replace(/\r/g, "").split(/\n\s*\n/)[0] ?? "";
  const lines = block.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return out;
  // 1行目: 「【1🌟★】アリビオ夕陽丘 202号室」
  let head = lines[0].replace(/^【[^】]*】\s*/u, "").trim();
  const rm = head.match(/\s*([0-9A-Za-z０-９Ａ-Ｚａ-ｚ\-－]+)号室$/u);
  if (rm) { out.room = rm[1]; head = head.slice(0, rm.index).trim(); }
  out.name = head && !PLACEHOLDER_NAMES.has(head) ? head : null;
  for (const ln of lines.slice(1)) {
    let m: RegExpMatchArray | null;
    if (!out.ad && (m = ln.match(/^A\s?D\s*[:：]?\s*(.+)$/u))) { out.ad = m[1].trim(); continue; }
    if (!out.rent && (m = ln.match(/^([\d,]+)\s*円(?:\s+([\d,]+\s*円|なし|無し|-|－|0円?))?/u))) {
      out.rent = `${m[1]}円`;
      if (m[2]) out.admin = /^(なし|無し|-|－|0円?)$/u.test(m[2]) ? "なし" : m[2].replace(/\s+/g, "");
      continue;
    }
    if (!out.madori && (m = ln.match(/^(ワンルーム|\d+\s?[SLDKR]+(?:\+S)?)\s*(?:([\d.]+)\s*(?:㎡|m2|m²))?/iu))) {
      out.madori = m[1].replace(/\s+/g, "");
      if (m[2]) out.sqm = `${m[2]}㎡`;
      continue;
    }
    if (!out.access && /徒歩\s*\d+\s*分/u.test(ln)) { out.access = ln; continue; }
  }
  return out;
}

/** 画像の読み取りの行（「所在階: 2階部分」）から値を引く */
function imageLine(lines: string[] | null | undefined, key: RegExp): string | null {
  for (const l of lines ?? []) {
    const m = l.match(/^([^:：]+)[:：]\s*(.+)$/u);
    if (m && key.test(m[1].trim())) return m[2].trim();
  }
  return null;
}

/** 敷金・礼金・保証金（月数）の表記。0 は「なし」 */
function monthsLabel(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v === 0 ? "なし" : `${v}ヶ月`;
}

/** 償却の表記（保存しているのは根拠の文だけ） */
function amortLabel(ev: string | null | undefined): string | null {
  if (!ev) return null;
  if (/(なし|無し|無)/u.test(ev)) return "なし";
  const m = ev.match(/(?:償却|敷引)[^\d０-９]*([\d.,０-９]+\s*(?:ヶ月|か月|ケ月|カ月|%|％|円|万円)?)/u);
  return m ? m[1].replace(/\s+/g, "") : null;
}

/** 状態（空室・居住中・退去予定） */
function stateLabel(t: PickupCardInput["terms"], lines: string[] | null | undefined): string | null {
  const cur = t?.moveIn?.current;
  if (cur === "vacant") return "空室";
  if (cur === "occupied") return "居住中";
  if (cur === "leaving") return "退去予定";
  const raw = imageLine(lines, /^現況$/u);
  if (!raw) return null;
  if (/空/u.test(raw)) return "空室";
  if (/居住/u.test(raw)) return "居住中";
  if (/退去/u.test(raw)) return "退去予定";
  return raw.slice(0, 8);
}

/** 入居可能日（「即入」「9月下旬」「相談」） */
function moveInShort(t: PickupCardInput["terms"], lines: string[] | null | undefined): string | null {
  if (t?.moveIn) {
    const l = moveInLabel(t.moveIn as Parameters<typeof moveInLabel>[0]);
    if (l) return l === "即入居" ? "即入" : l;
  }
  const raw = imageLine(lines, /^入居(可能日|時期|日)$/u);
  if (!raw) return null;
  if (/^即/u.test(raw)) return "即入";
  const m = raw.match(/(?:\d{4}\s*年\s*)?(\d{1,2})\s*月\s*(上旬|中旬|下旬|末|\d{1,2}\s*日)?/u);
  if (m) return `${Number(m[1])}月${(m[2] ?? "").replace(/\s+/g, "")}`;
  if (/相談/u.test(raw)) return "相談";
  return raw.slice(0, 10);
}

/** 所在階（設備の照合 → 画像の読み取り） */
function floorLabelOf(eq: PickupCardInput["equipment"], lines: string[] | null | undefined): string | null {
  if (eq?.roomFloor != null) return `${eq.basement ? "B" : ""}${eq.roomFloor}階`;
  const raw = imageLine(lines, /^所在階$/u);
  const m = raw?.match(/(\d+)\s*階/u);
  return m ? `${m[1]}階` : null;
}

/** 判定の丸い札（○ 通す・△ 保留・× 外す候補） */
export function verdictMark(verdict: string | null | undefined, score: number | null | undefined): CardMark {
  const s = typeof score === "number" && Number.isFinite(score) ? score : null;
  if (verdict === "pass") return { symbol: "○", tone: "pass", label: "通す", score: s };
  if (verdict === "hold") return { symbol: "△", tone: "hold", label: "保留", score: s };
  if (verdict === "drop") return { symbol: "×", tone: "drop", label: "外す候補", score: s };
  return { symbol: "－", tone: "none", label: "未判定", score: s };
}

/** 畳んだ時の1行: 外す候補・保留は理由の最初の1つ、通すは気を付ける点（減点）があればそれ・無ければ一番の加点 */
export function cardHeadline(row: Pick<PickupCardInput, "verdict" | "reason_codes" | "reasons_ja">): CardHeadline | null {
  const v = buildReasonView(row);
  const pts = (n: number) => (n === 0 ? "" : ` ${n > 0 ? "+" : "−"}${Math.abs(n)}`);
  const firstMinus = v.minus.find((c) => c.tone === "drop") ?? v.minus.find((c) => c.points !== 0) ?? null;
  if (row.verdict === "drop" || row.verdict === "hold") {
    if (firstMinus) return { text: `${row.verdict === "drop" ? "外す理由" : "保留の理由"}: ${firstMinus.label}${pts(firstMinus.points)}`, tone: firstMinus.tone === "drop" ? "drop" : "minus" };
    if (v.missing.length) return { text: `材料なし: ${v.missing.join("・")}`, tone: "info" };
    if (v.notes[0]) return { text: v.notes[0], tone: "info" };
    return null;
  }
  if (firstMinus) return { text: `気を付ける点: ${firstMinus.label}${pts(firstMinus.points)}`, tone: "minus" };
  const plus = v.plus[0];
  if (plus) return { text: `良い点: ${plus.label}${pts(plus.points)}`, tone: "plus" };
  if (v.notes[0]) return { text: v.notes[0], tone: "info" };
  return null;
}

/** 1件の物件カードの値（リアプロの物件一覧と同じ並び） */
export function buildPickupCardView(row: PickupCardInput): PickupCardView {
  const s = parseSummaryText(row.summary_text);
  const lines = row.image_lines ?? null;
  const t = row.terms ?? null;
  const rawName = (row.property_name ?? "").trim();
  const name = s.name ?? (rawName && !PLACEHOLDER_NAMES.has(rawName) ? rawName : null);
  const room = (row.room_no ?? "").trim() || s.room || null;
  const st = row.location?.stations?.find((x) => x && x.station) ?? null;
  const access = s.access ?? (st ? `${st.line ? `${st.line}` : ""}「${st.station}」${st.walk != null ? `徒歩${st.walk}分` : ""}` : null);
  const madori = s.madori ?? imageLine(lines, /^間取り?$/u)?.replace(/\[.*$/u, "").trim() ?? null;
  const sqm = s.sqm ?? (t?.evidence?.area?.match(/([\d.]+)\s*(?:m2|㎡)/u)?.[1] ? `${t!.evidence!.area!.match(/([\d.]+)\s*(?:m2|㎡)/u)![1]}㎡` : null);
  const floor = floorLabelOf(row.equipment, lines);
  const age = t?.newBuild && (t.buildingAge ?? 0) === 0 ? "新築" : t?.buildingAge != null ? `築${t.buildingAge}年` : (() => {
    const b = imageLine(lines, /^築年(月)?$/u)?.match(/(\d{4})/u);
    return b ? `${b[1]}年築` : null;
  })();
  const total = row.equipment?.totalFloors != null ? `${row.equipment.totalFloors}階建` : null;
  const building = [age, total].filter(Boolean).join("・") || null;
  const ad = s.ad ?? (row.ad_yen != null && row.ad_yen > 0 ? `${row.ad_yen.toLocaleString("ja-JP")}円` : row.ad_yen === 0 ? "なし" : null);
  const mark = verdictMark(row.verdict, row.score);
  const pair = (a: string | null, b: string | null) => ({ value: a ?? DASH, sub: b ?? DASH });
  const walkM = access?.match(/徒歩\s*(\d+)\s*分/u);
  const stName = access?.match(/「([^」]+)」/u)?.[1] ?? st?.station ?? null;
  const facts: Record<string, CardCell> = {
    room: { key: "room", head: "部屋/階", ...pair(room, floor) },
    state: { key: "state", head: "状態/入居", ...pair(stateLabel(t, lines), moveInShort(t, lines)) },
    madori: { key: "madori", head: "間取り/㎡", ...pair(madori, sqm) },
    rent: { key: "rent", head: "賃料/管理費", ...pair(s.rent, s.admin) },
    deposit: { key: "deposit", head: "敷金/礼金", ...pair(monthsLabel(t?.deposit), monthsLabel(t?.keyMoney)) },
    guarantee: { key: "guarantee", head: "保証金/償却", ...pair(monthsLabel(t?.guaranteeDeposit), amortLabel(t?.evidence?.amortization)) },
    ad: { key: "ad", head: "AD", value: ad ?? DASH, sub: null },
    built: { key: "built", head: "築年/階建", ...pair(age, total) },
    walk: { key: "walk", head: "駅徒歩", value: walkM ? `${walkM[1]}分` : DASH, sub: stName },
    area: { key: "area", head: "エリア", value: row.location?.ward ?? stName ?? DASH, sub: null },
  };
  const score: CardCell = { key: "score", head: "点数", value: mark.score != null ? `${mark.score}点` : DASH, sub: mark.label, note: scoreGapNote(row.reason_codes ?? null, row.score) };
  const strongEquip = new Set((row.equipment?.match ?? []).filter((m) => m?.strong && m.key).map((m) => String(m.key).toUpperCase()));
  return { name, room, address: row.location?.ward ?? null, access, building, mark, cells: [...buildFitCells(row.reason_codes ?? null, facts, { strongEquip }), score], headline: cardHeadline(row) };
}

// ── 2026-09-25 項目ごとの点数（案B）──────────────────────────────────────────────
// 竹内「カードの項目もお客さんの理想の条件に合わせて表示する。それと AD。そして点数も入れておく（合計だけでなく各項目の点数）。
//   見ていてスコアリングのずれも気づきやすいし、お客さんの条件と照らし合わせて確認も容易」
//   → 札（reason_codes）を項目に振り分け（CODE_CELL）、項目ごとに 点の合計・色・「初期費用を抑えたい・一致」の一言を付ける。
//     並び: お客様が書いた条件の項目 → 全部合う → AD（必ず）→ 書いていない条件で点が付いた項目 → 事実だけの項目 → 点数

/**
 * 点数の項目の一言（反証レビュー 2026-09-25）: 項目の点の合計＋50 が合計点と一致しない時だけ、なぜかを出す（一致する時は null）。
 *   ①保存してある点が前の配点（案B の前の行・重みの版）→「今の配点では X点」
 *   ②上限（200）で丸めた →「上限200（素点 X）」 ③必須の × で上限20 →「必須の×で上限20（素点 X）」
 *   竹内「各項目の点数…見ていてスコアリングのずれも気づきやすい」: 黙って合わない数字を並べない
 */
export function scoreGapNote(reasonCodes: readonly string[] | null, stored: number | null): string | null {
  if (!reasonCodes || reasonCodes.length === 0 || stored == null) return null;
  const raw = BASE_SCORE + reasonCodes.reduce((a, c) => a + reasonPoints(c), 0);
  const now = scoreFromCodes(reasonCodes);
  if (now !== stored) return `今の配点では ${now}点`;
  if (raw === stored) return null;
  if (reasonCodes.includes(EQUIP_CAP_CODE) && raw > EQUIP_STRONG_NG_CAP) return `必須の×で上限${EQUIP_STRONG_NG_CAP}（素点 ${raw}）`;
  if (raw > SCORE_MAX) return `上限${SCORE_MAX}（素点 ${raw}）`;
  if (raw < 0) return `下限0（素点 ${raw}）`;
  return null;
}

/** 札 → 項目（key・見出し）。設備・入居の条件・画像は希望ごとに1項目 */
const IMAGE_HEAD: Record<string, string> = {
  BATH_TOILET_SEPARATE: "バストイレ別", SEPARATE_WASHSTAND: "独立洗面", STORAGE: "収納", SOUTH_FACING: "南向き", FLOOR_2_PLUS: "2階以上",
};
export function cellOfCode(code: string): { key: string; head: string } | null {
  if (code === EQUIP_CAP_CODE) return null; // 0点の印（必須の × は設備の項目で赤・点数の丸い札で上限20）
  if (/^RENT_/.test(code)) return { key: "rent", head: "賃料/管理費" };
  if (/^(?:ZERO_ZERO|INITIAL_COST_|FREE_RENT)/.test(code)) return { key: "deposit", head: "敷金/礼金" };
  if (/^(?:FLOOR_PLAN_|SQM_)/.test(code)) return { key: "madori", head: "間取り/㎡" };
  if (/^WALK_/.test(code)) return { key: "walk", head: "駅徒歩" };
  if (/^(?:BUILDING_AGE_|AGE_)/.test(code)) return { key: "built", head: "築年/階建" };
  if (/^AREA_/.test(code)) return { key: "area", head: "エリア" };
  if (/^COMMUTE_/.test(code)) return { key: "commute", head: "通勤" };
  if (/^MOVE_IN_/.test(code)) return { key: "state", head: "状態/入居" };
  if (/^(?:CONTRACT_|RENEWAL_FEE_)/.test(code)) return { key: "contract", head: "契約" };
  if (code === "PET_NG") return { key: "pet", head: "ペット" };
  if (/^ALREADY_SENT/.test(code)) return { key: "sent", head: "送付済み" };
  if (/^FIT_/.test(code)) return { key: "fit", head: "全部合う" };
  if (/^AD_|^PROFIT_NEGATIVE$/.test(code)) return { key: "ad", head: "AD" };
  let m = code.match(/^EQUIP_(.+?)(?:_MUST|_SOFT)?_(?:OK_MAX|OK|NG|NEAR|ASK|UNLISTED)$/);
  if (m) return { key: `eq:${m[1]}`, head: equipKeyLabel(m[1]) };
  m = code.match(/^CONDITION_(.+?)_(?:OK|NG|ASK|UNLISTED)$/);
  if (m) return { key: `cond:${m[1]}`, head: reasonJa(code).replace(/(?:○（資料）|不可（資料）|は相談（要確認）)$/u, "").replace(/^要確認: /u, "") };
  m = code.match(/^IMAGE_(.+?)_(?:OK|NG)$/);
  if (m) return { key: `img:${m[1]}`, head: IMAGE_HEAD[m[1]] ?? m[1] };
  return null;
}

/** お客様が書いた条件の札か（書いた人にしか付かない札）。ZERO_ZERO（書いていない敷礼0）・AGE_N・WALK_NEAR_N・送付済み・AD・全部合うは書いた条件ではない */
function isWrittenCode(code: string): boolean {
  if (/^(?:ZERO_ZERO|ZERO_ZERO_INFERRED|INITIAL_COST_UNKNOWN|FREE_RENT|FREE_RENT_UNLISTED|CONTRACT_FIXED|AGE_N5|AGE_N10|WALK_NEAR_N|COMMUTE_INFO)$/.test(code)) return false;
  if (/^(?:ALREADY_SENT|AD_|PROFIT_NEGATIVE|FIT_)/.test(code)) return false;
  if (fitVerdictOf(code)) return true;
  return /^(?:AGE_W|AGE_COL_|WALK_NEAR_W|WALK_TEXT_|RENT_CHEAP_|RENT_ABOVE_USUAL|RENT_BELOW_MIN|RENT_MAX_UNRELIABLE|FREE_RENT_MATCH|CONTRACT_|RENEWAL_FEE_|INITIAL_COST_)/.test(code);
}

/** 項目の中の札の合い方 → 色（外れが1つでもあれば赤・無くて ○ があれば緑・幅の中・要確認の順） */
function toneOfCodes(codes: string[], key: string): CellTone {
  if (key === "ad") {
    if (codes.some((c) => /^(?:AD_NONE|AD_UNDER_1M|PROFIT_NEGATIVE)$/.test(c))) return "ng";
    if (codes.some((c) => c.endsWith(AD_HELD_SUFFIX))) return "info";
    if (codes.some((c) => /^(?:AD_1M|AD_1_5M|AD_HIGH|AD_2_5M|AD_VERY_HIGH)$/.test(c))) return "ok";
    return codes.includes("AD_UNKNOWN") || codes.length === 0 ? "unread" : "info";
  }
  if (key === "fit") return "ok";
  if (key === "sent") return codes.some((c) => c === "ALREADY_SENT" || c === "ALREADY_SENT_SAME_ROOM") ? "ng" : "info";
  const vs = codes.map((c) => fitVerdictOf(c)?.v).filter(Boolean);
  if (vs.some((v) => v === "ng" || v === "soft_ng") || codes.some((c) => /^(?:WALK_TEXT_OVER|WALK_TEXT_FAR|AGE_W_OLD|RENT_ABOVE_USUAL|CONTRACT_FIXED)$/.test(c))) return "ng";
  if (vs.includes("ok") || codes.some((c) => /^(?:AGE_W|AGE_COL_|WALK_NEAR_W|RENT_CHEAP_|FREE_RENT_MATCH)/.test(c))) return "ok";
  if (vs.includes("wide")) return "wide";
  if (vs.includes("unread") || codes.some((c) => /_UNKNOWN$|_UNLISTED$|_ASK$/.test(c))) return "unread";
  return "info";
}

/** 「初期費用を抑えたい」「駅近」など、項目の希望の言い方 */
function wantWordOf(key: string, codes: string[], strongEquip?: ReadonlySet<string>): string {
  const has = (re: RegExp) => codes.some((c) => re.test(c));
  if (key === "rent") return has(/^RENT_CHEAP_/) ? "家賃を低く" : "予算";
  if (key === "deposit") return has(/^INITIAL_COST_OVER_LIMIT$/) && !has(/^(?:ZERO_ZERO_MATCH|INITIAL_COST_NOT_ZERO)$/) ? "初期費用の上限" : "初期費用を抑えたい";
  if (key === "madori") return has(/^SQM_/) && !has(/^FLOOR_PLAN_/) ? "広さ" : "間取り";
  if (key === "walk") return has(/^(?:WALK_TEXT_|WALK_NEAR_W)/) ? "駅近" : "徒歩";
  if (key === "built") return has(/^(?:BUILDING_AGE_TEXT_|AGE_W)/) ? "築浅" : "築年";
  if (key === "state") return "入居時期";
  if (key === "area") return "エリア";
  if (key === "commute") return "通勤";
  if (key === "contract") return "契約";
  if (key === "pet") return "ペット";
  // 2026-09-25 YUMA テスト（お客様E「宅配ボックス必須」）: × と読めない（－）の札（EQUIP_X_NG／_UNLISTED）には強さが付かず、
  //   「宅配ボックス － +0（希望・要確認）」と出ていた → 保存した照合（equipment.match の strong）で「必須」を引く
  if (key.startsWith("eq:")) return has(/_MUST_OK$/) || strongEquip?.has(key.slice(3)) ? "必須" : has(/_SOFT_OK$/) ? "できれば" : "希望";
  if (key.startsWith("cond:")) return "入居の条件";
  if (key.startsWith("img:")) return "画像";
  return "";
}
const TONE_WORD: Record<CellTone, string> = { ok: "一致", wide: "幅の中", ng: "外れ", unread: "要確認", info: "" };

/** 設備・入居の条件・画像の項目の値（○ × － △） */
function markOfCodes(codes: string[]): string {
  if (codes.some((c) => /_NG$/.test(c))) return "×";
  if (codes.some((c) => /_OK(?:_MAX)?$/.test(c))) return "○";
  if (codes.some((c) => /_ASK$|_NEAR$/.test(c))) return "△";
  return DASH;
}

/**
 * 札（reason_codes）から項目の並びを作る（純関数）。facts は事実の項目（値だけ・点なし）。
 *   お客様が書いた条件の項目（上）→ 全部合う → AD（必ず）→ 書いていない条件で点が付いた項目 → 事実だけの項目
 *   reason_codes が無い古い行は事実の項目だけ（今までの並び）
 */
export function buildFitCells(reasonCodes: readonly string[] | null, facts: Record<string, CardCell>, opts?: { strongEquip?: ReadonlySet<string> }): CardCell[] {
  const FACT_ORDER = ["room", "state", "madori", "rent", "deposit", "guarantee", "ad", "built"];
  if (!reasonCodes || reasonCodes.length === 0) return FACT_ORDER.map((k) => facts[k]);
  const groups = new Map<string, { head: string; codes: string[] }>();
  for (const code of reasonCodes) {
    const c = cellOfCode(code);
    if (!c) continue;
    const g = groups.get(c.key) ?? { head: c.head, codes: [] };
    g.codes.push(code);
    groups.set(c.key, g);
  }
  const cellOf = (key: string, g: { head: string; codes: string[] }): CardCell => {
    const base = facts[key] ?? { key, head: g.head, value: markOfCodes(g.codes), sub: null };
    const points = g.codes.reduce((a, c) => a + reasonPoints(c), 0);
    const tone = toneOfCodes(g.codes, key);
    const written = g.codes.some(isWrittenCode);
    let note: string | null;
    if (key === "fit") {
      const f = summarizeFit(reasonCodes);
      note = f.miss === 0 ? `書いた条件 ${f.n}つ全部` : `${f.n}つ中 ${f.miss}つ外れ`;
    } else if (key === "ad") note = g.codes.some((c) => c.endsWith(AD_HELD_SUFFIX)) ? "保留の物件なので0点" : g.codes.includes("AD_UNKNOWN") ? "要確認" : g.codes.includes("PROFIT_NEGATIVE") ? "割引の方が大きい" : null;
    else if (key === "sent") note = g.codes.includes("ALREADY_SENT_OTHER_ROOM") ? "同じ建物の別の部屋" : "送り直しか確認";
    else if (written) note = [wantWordOf(key, g.codes, opts?.strongEquip), TONE_WORD[tone]].filter(Boolean).join("・");
    else if (g.codes.includes("ZERO_ZERO_INFERRED")) note = "送った物件から推した";
    else note = points !== 0 ? "書いていない" : tone === "unread" ? "要確認" : null;
    return { ...base, head: base.head, points, tone, written, note, codes: g.codes.slice() };
  };
  const all = [...groups.entries()].map(([k, g]) => cellOf(k, g));
  const ORDER = ["rent", "deposit", "madori", "walk", "built", "area", "commute", "state", "contract", "pet"];
  const orderOf = (k: string) => { const i = ORDER.indexOf(k); return i >= 0 ? i : k.startsWith("eq:") ? 20 : k.startsWith("cond:") ? 30 : k.startsWith("img:") ? 40 : 50; };
  const byOrder = (a: CardCell, z: CardCell) => orderOf(a.key) - orderOf(z.key);
  const written = all.filter((c) => c.written).sort(byOrder);
  const fit = all.filter((c) => c.key === "fit");
  const adCell = all.find((c) => c.key === "ad") ?? { ...facts.ad, points: 0, tone: "unread" as CellTone, written: false, note: "要確認", codes: [] };
  const other = all.filter((c) => !c.written && c.key !== "fit" && c.key !== "ad").sort(byOrder);
  const used = new Set([...written, ...fit, adCell, ...other].map((c) => c.key));
  const rest = FACT_ORDER.filter((k) => !used.has(k)).map((k) => ({ ...facts[k], points: null, tone: null, written: false, note: null }));
  return [...written, ...fit, adCell, ...other, ...rest];
}

/** サイトの小さな札 */
export function siteLabel(site: string | null | undefined): string {
  if (site === "realpro") return "リアプロ";
  if (site === "itandi") return "itandi";
  return site || "-";
}

// ── まとめの回 ─────────────────────────────────────────────────────────────────

export const ROUND_GAP_MS = 30 * 60 * 1000;
export const ROUND_MAX_SPAN_MS = 3 * 60 * 60 * 1000;

export type RoundBatch = { batch_id: string; created_at: string; site: string | null; round_id?: string | null };
export type PickupRound<B extends RoundBatch> = {
  /** 回の鍵（元の batch_id を「,」でつないだ物。1回だけなら元の batch_id のまま） */
  key: string;
  batch_ids: string[];
  round_id: string | null;
  created_at: string;
  last_at: string;
  /** サイトごとの回数（届いた順） */
  sites: string[];
  batches: B[];
};

/**
 * 同じお客様の回（batch）を、まとめの回に寄せる。入力の順は問わない。出力は古い順。
 *   round_id のある回は同じ round_id どうし（時刻は問わない）。無い回は、前の回から gapMs 以内・最初の回から maxSpanMs 以内で続ける
 */
export function groupPickupRounds<B extends RoundBatch>(batches: ReadonlyArray<B>, opts: { gapMs?: number; maxSpanMs?: number } = {}): PickupRound<B>[] {
  const gap = opts.gapMs ?? ROUND_GAP_MS;
  const span = opts.maxSpanMs ?? ROUND_MAX_SPAN_MS;
  const sorted = batches.slice().sort((a, z) => a.created_at.localeCompare(z.created_at) || a.batch_id.localeCompare(z.batch_id));
  const rounds: Array<{ round_id: string | null; batches: B[]; first: number; last: number }> = [];
  const byRoundId = new Map<string, (typeof rounds)[number]>();
  let open: (typeof rounds)[number] | null = null;
  for (const b of sorted) {
    const at = Date.parse(b.created_at);
    const rid = (b.round_id ?? "").trim() || null;
    if (rid) {
      const r = byRoundId.get(rid);
      if (r) { r.batches.push(b); r.last = Math.max(r.last, at); continue; }
      const nr = { round_id: rid, batches: [b], first: at, last: at };
      byRoundId.set(rid, nr);
      rounds.push(nr);
      continue;
    }
    if (open && Number.isFinite(at) && at - open.last <= gap && at - open.first <= span) {
      open.batches.push(b);
      open.last = at;
      continue;
    }
    open = { round_id: null, batches: [b], first: at, last: at };
    rounds.push(open);
  }
  return rounds
    .map((r) => {
      const ids = r.batches.map((b) => b.batch_id);
      const times = r.batches.map((b) => b.created_at).sort();
      return {
        key: ids.join(","),
        batch_ids: ids,
        round_id: r.round_id,
        created_at: times[0],
        last_at: times[times.length - 1],
        sites: r.batches.map((b) => b.site ?? "-"),
        batches: r.batches,
      };
    })
    .sort((a, z) => a.created_at.localeCompare(z.created_at));
}

/** まとめの回の物件を1つの並びに（点の高い順・同点は🌟。bestId＝👑 一番オススメがあれば先頭。同じ回の中の並びと同じ規則） */
export function mergeRoundItems<T extends ReviewOrderRow>(batches: ReadonlyArray<{ items: ReadonlyArray<T> }>, bestId?: number | null): T[] {
  return sortForReview(batches.flatMap((b) => b.items), bestId);
}

/** 「リアプロ 10・itandi 18」 */
export function roundSiteSummary(batches: ReadonlyArray<{ site: string | null; items: ReadonlyArray<unknown> }>): string {
  const count = new Map<string, number>();
  for (const b of batches) count.set(siteLabel(b.site), (count.get(siteLabel(b.site)) ?? 0) + b.items.length);
  return [...count.entries()].map(([k, n]) => `${k} ${n}`).join("・");
}

/** 「○通す 7・△保留 2・×外す候補 1」 */
export function verdictCounts(items: ReadonlyArray<{ verdict: string | null }>): string {
  const n = { pass: 0, hold: 0, drop: 0 };
  for (const it of items) if (it.verdict === "pass" || it.verdict === "hold" || it.verdict === "drop") n[it.verdict]++;
  return [n.pass ? `○通す ${n.pass}` : "", n.hold ? `△保留 ${n.hold}` : "", n.drop ? `×外す候補 ${n.drop}` : ""].filter(Boolean).join("・");
}
