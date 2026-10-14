// app/lib/second-material-saved-read.ts（純関数・DB/LLM なし）
// AIX【物件オススメ】の直後の2通目（✨ aix-template-generate）の「1通目の物件の資料の事実」を、売上サポの行が無い時は
// 物件検索ブレインの保存してある読み（送った資料の画像を送った時に読んだ物＝sent_image_properties.facts・CandidateFacts）から作る。
//
// 2026-10-15 竹内さん「物件資料に書かれていることを…AIX ツールの物件検索ブレインで解析すれば更に質よくなる」
//   「他にも AIX ツール物件検索ブレインを有効に活用できる部分あれば使う」
// ■ 洗い出し（30日・実データ・LLM なし・.scratch/inv5.ts）
//   物件オススメ 239押下（1通目の見出しが読めた 226）: 2通目の材料（second-message-scene.buildSecondMaterialNote）に届く売上サポの行は 35（15%）だけ。
//   残り 191 のうち 110 は送った資料の読み（facts）が保存してある＝読みはあるのに2通目に届いていなかった（届くのは 35→145・64%）。
//   読みの項目: 家賃 142/142・敷金 137・礼金 121・駅徒歩 134・間取り/広さ 134・築年 130（設備の語は無い）
// ■ 決め（9eb6aa9c: 規則は候補の網と安全の線だけ。何を書くかは文を書く側）
//   - 渡すのは資料の読みの事実だけ（駅徒歩・築年・敷金礼金・間取り広さ）＋お客様の希望と照らした「合う・満たさない」（recommend-appeal-points と同じ照らし方）。
//   - 現況（募集中・退去予定）は渡さない: 読みの status=open は「募集中」で空室とは限らず、退去予定日・内覧できるかは今までの決め方
//     （1通目の本文 → 売上サポの行 → ブレイン）のまま（2通目の締めと食い違わせない）。
//   - 敷金・礼金は両方0と読めた時だけ「敷金礼金なしと書ける」を渡す（礼金ありの読みで止めはしない＝読み違い・キャンペーンの正しい文を止めない）。資料の読みは保存済みの物を使い回す（その場で読み直さない＝費用0）。
//   - 戻すのは SECOND_MATERIAL_SAVED_READ=off（売上サポの行が無い時は今まで通り材料なし）
import type { CandidateFacts } from "./candidate-facts";
import type { SecondMaterialRow } from "./second-message-scene";
import type { AppealPoints } from "./recommend-appeal-points";
import { normalizePropertyName } from "./property-name-match";

export function secondMaterialSavedReadEnabled(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  return String(env.SECOND_MATERIAL_SAVED_READ ?? "on").trim().toLowerCase() !== "off";
}

export type SavedReadRow = { property_name: string | null; room_no: string | null; facts: CandidateFacts | null; created_at?: string | null };

// 建物の鍵（customer-state.buildingKeyOf と同じ形: NFKC → 〜を外す → normalizePropertyName）
const bkey = (s: string | null | undefined) => normalizePropertyName(String(s ?? "").normalize("NFKC").replace(/[〜~～]/g, ""));
const roomKey = (r: string | null | undefined) => String(r ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+/, "").trim();
const fold = (s: string) => s.normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");
/** 同じ長さで1字だけ違う（読み取りの取り違え「セレーネ/セレーノ」「今宮/令宮」） */
const oneCharOff = (a: string, b: string) => {
  if (a.length !== b.length || a.length < 4) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
  return d === 1;
};
/** 2026-10-15 確かめる人: 読みを今の事実として渡すのは、この日数までに読んだ物だけ（敷礼なし・キャンペーンは変わる）。実データの当たりは最大 3.1日 */
export const SAVED_READ_MAX_AGE_DAYS = 14;

/**
 * 1通目の見出し（建物名・号室）に当たる保存した読み。号室が同じで、建物の鍵が同じ（濁点違い・読みの名前に号室が付いた形・
 * 先頭の飾り「★築浅★」を含む）か、同じ長さで1字だけ違う（読み取りの取り違え）物。同じ鍵の物を先に・その中で一番新しい物。
 * 号室が無い・名前が短すぎる・古すぎる時は null（別の物件の事実を渡さない側）
 * 2026-10-15 確かめる人（実データ 30日・当たり 29）: 旧の「建物名の頭6字」は シリーズ名で別の建物に当たった
 *   （「スプランディッド堀江 1309」→「スプランディッド本町グラン 1309」）。同じ会話で同じ号室のシリーズ違いは全体で 60組中 十数組
 */
export function pickSavedReadForHead<T extends SavedReadRow>(rows: ReadonlyArray<T>, head: { name: string; room: string } | null, nowMs: number = Date.now()): T | null {
  if (!head) return null;
  const hk = bkey(head.name), hr = roomKey(head.room);
  if (hk.length < 2 || !hr) return null;
  const rk = hr.toLowerCase();
  const exact = (k: string) => k === hk || fold(k) === fold(hk) || k === hk + rk || hk === k + rk
    || (Math.min(k.length, hk.length) >= 5 && (k.endsWith(hk) || hk.endsWith(k)));
  const tier = (r: T): number => {
    if (!r.facts || typeof r.facts !== "object") return 0;
    const at = Date.parse(r.created_at ?? "");
    if (!Number.isFinite(at) || nowMs - at > SAVED_READ_MAX_AGE_DAYS * 864e5) return 0;
    const k = bkey(r.property_name);
    if (k.length < 2 || roomKey(r.room_no) !== hr) return 0;
    return exact(k) ? 2 : oneCharOff(k, hk) ? 1 : 0;
  };
  const hits = rows.map((r) => ({ r, t: tier(r) })).filter((x) => x.t > 0);
  if (!hits.length) return null;
  return [...hits].sort((a, b) => b.t - a.t || Date.parse(b.r.created_at ?? "") - Date.parse(a.r.created_at ?? ""))[0].r;
}

/** 築年月 "YYYY-MM" → 「2014年3月築」（年だけなら「2014年築」）。読めなければ null */
function builtLabel(ym: string | null | undefined): string | null {
  const m = String(ym ?? "").match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!m) return null;
  return m[2] ? `${m[1]}年${Number(m[2])}月築` : `${m[1]}年築`;
}

/**
 * 保存した読み → 2通目の材料の行の形（second-message-scene.buildSecondMaterialNote・unfoundedCostClaim がそのまま読める形）。
 * terms.moveIn は入れない（現況は今までの決め方のまま）。間取り・広さは行の形に場所が無いので extraLines で返す。
 */
export function secondRowFromSavedRead(f: CandidateFacts | null | undefined): { row: SecondMaterialRow; extraLines: string[] } | null {
  if (!f || typeof f !== "object") return null;
  // 読み取りの確信度のゲートが単位を決められなかった欄（deposit_unit / key_money_unit="unclear"）は使わない
  const dep = typeof f.deposit_months === "number" && f.deposit_unit !== "unclear" ? f.deposit_months : null;
  const key = typeof f.key_money_months === "number" && f.key_money_unit !== "unclear" ? f.key_money_months : null;
  const built = builtLabel(f.built_ym);
  const stations = (Array.isArray(f.stations) ? f.stations : []).filter((s) => s && s.station && typeof s.walk === "number").slice(0, 2)
    .map((s) => ({ line: s.line ?? null, station: String(s.station).replace(/駅$/, ""), walk: s.walk }));
  if (!stations.length && f.station && typeof f.walk_minutes === "number") stations.push({ line: null, station: String(f.station).replace(/駅$/, ""), walk: f.walk_minutes });
  const row: SecondMaterialRow = {
    property_name: f.name ?? null, room_no: f.room_no ?? null,
    terms: {
      // 2026-10-15 実データ（30日の2通目 29番）: 読みが礼金ありの12番のうち4番は実送信が「敷金礼金なし」（キャンペーン・読み違い）。
      //   読みで「書かない」と止めると正しい文まで止める → 両方0と読めた時だけ渡す（書いてよいの向きだけ・止めるのは売上サポの行の時だけ）
      ...(dep === 0 && key === 0 ? { deposit: 0, keyMoney: 0 } : {}),
      newBuild: typeof f.building_age === "number" ? f.building_age === 0 : null,
      evidence: built ? { built } : null,
    },
    location: stations.length ? { stations } : null,
  };
  // 2026-10-15 前後（YUMA・DeepSeek 3番）: 間取り・広さ・家賃の行も渡すと2通目がそれを並べて長くなり、竹内さんの実送信から遠のいた（近さ 0.48→0.46）。
  //   竹内さんの2通目（75通）で間取り・広さ・家賃を書いたのは 9〜10通で、どれも1通目に既にある値 → 行の形にある所（駅・築年・敷礼）だけ渡す
  const extraLines: string[] = [];
  const hasAny = (dep === 0 && key === 0) || built || stations.length;
  return hasAny ? { row, extraLines } : null;
}

/** お客様の希望と照らした行（希望に合う強み・満たさない希望）。何も無ければ [] */
export function savedReadFitLines(a: AppealPoints | null | undefined): string[] {
  if (!a) return [];
  const L: string[] = [];
  const wanted = a.points.filter((p) => p.why === "wanted");
  if (wanted.length) L.push(`・お客様のご希望に合う点（資料の読みで確かめた物）: ${wanted.map((p) => p.fact).join("／")}`);
  if (a.unmet.length) L.push(`・ご希望なのにこのお部屋で満たさない所（合うと書かない）: ${a.unmet.map((u) => u.label).join("／")}`);
  return L;
}

/** 2通目の材料の注記の後ろに足す行（間取り・家賃・希望との照らし）。本体の注記が空なら見出しから作る */
export function appendSavedReadLines(baseNote: string, extra: ReadonlyArray<string>): string {
  if (!extra.length) return baseNote;
  if (baseNote.trim()) return `${baseNote}\n${extra.join("\n")}`;
  return ["【1通目の物件の資料の事実（資料の字のまま。理由に使うのはここと1通目に書いてある事だけ）】", ...extra].join("\n");
}
