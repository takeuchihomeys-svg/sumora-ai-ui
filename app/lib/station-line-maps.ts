// サーバー側の「リアプロの路線名 → ITANDI／REINS の路線名」の写し（2026-11-10 作業員B）。
// 正本は chrome-extension/popup-maps.js の ITANDI_LINE_MAP_FILL・REINS_LINE_MAP。
// 3サイトの表記は別物（memory feedback_site_naming_separation）。ここは「リアプロの内部名」をキーにした変換だけを持つ。
// 正本とずれたら app/lib/__tests__/station-line-maps.test.ts が落ちる（popup-maps.js を読んで1件ずつ比べる）。
// 使う所: app/api/station-map（スタッフの手直し）・app/api/token-resolve（AI で解決した駅）。

// リアプロ路線名 → ITANDI の路線ラベル（DevTools 実測）
export const ITANDI_LINE_MAP: Record<string, string | string[]> = {
  "大阪市高速軌道御堂筋線": "高速電気軌道第1号線(大阪メトロ御堂筋線)",
  "大阪市高速軌道谷町線": "高速電気軌道第2号線(大阪メトロ谷町線)",
  "大阪市高速軌道四つ橋線": "高速電気軌道第3号線(大阪メトロ四つ橋線)",
  "大阪市高速軌道中央線": "高速電気軌道第4号線(大阪メトロ中央線)",
  "大阪市高速軌道千日前線": "高速電気軌道第5号線(大阪メトロ千日前線)",
  "大阪市高速軌道堺筋線": "高速電気軌道第6号線(大阪メトロ堺筋線)",
  "大阪市高速軌道長堀鶴見緑地線": "高速電気軌道第7号線(大阪メトロ長堀鶴見緑地線)",
  "大阪市高速軌道今里筋線": "高速電気軌道第8号線(大阪メトロ今里筋線)",
  "大阪市高速軌道南港ポートタウン線": "大阪市高速電気軌道南港ポートタウン線(大阪メトロ南港ポートタウン線)",
  "北大阪急行南北線": "北大阪急行電鉄",
  "阪急電鉄神戸線": "阪急神戸本線",
  "阪急電鉄宝塚線": "阪急宝塚本線",
  "阪急電鉄京都線": "阪急京都本線",
  "阪急電鉄千里線": "阪急千里線",
  "阪急電鉄箕面線": "阪急箕面線",
  "阪神電鉄本線": "阪神本線",
  "阪神電鉄阪神なんば線": "阪神なんば線",
  "南海電鉄南海本線": "南海本線",
  "南海電鉄南本線": "南海本線",
  "南海電鉄高野線": "南海高野線",
  "南海電鉄泉北線": "南海泉北線(泉北線)",
  "南海電鉄空港線": "南海空港線",
  "南海電鉄汐見橋線": "南海汐見橋線",
  "南海電鉄多奈川線": "南海多奈川線",
  "南海電鉄高師浜線": "南海高師浜線",
  "京阪電気鉄道京阪線": "京阪本線",
  "京阪電気鉄道中之島線": "京阪中之島線",
  "京阪電気鉄道交野線": "京阪交野線",
  "大阪環状線": "JR大阪環状線",
  "JR東西線": "JR東西線",
  "片町線": "JR片町線(学研都市線)",
  "桜島線": "JR桜島線(JRゆめ咲線)",
  "阪和線": "阪和線(天王寺～和歌山)",
  "福知山線": "JR福知山線(新大阪～篠山口)(JR宝塚線)",
  "東海道本線": ["JR東海道本線(京都～大阪)(JR京都線)", "JR東海道本線(大阪～神戸)(JR神戸線(大阪～神戸))"],
  "おおさか東線": "おおさか東線",
  "関西本線": "JR関西本線(加茂～ＪＲ難波)(大和路線)",
  "近鉄難波・奈良線": ["近鉄難波線", "近鉄奈良線"],
  "近鉄南大阪線": "近鉄南大阪線",
  "近鉄大阪線": "近鉄大阪線",
  "近鉄長野線": "近鉄長野線",
  "近鉄道明寺線": "近鉄道明寺線",
  "近鉄けいはんな線": "近鉄けいはんな線",
  "阪堺電気軌道阪堺線": "阪堺電軌阪堺線",
  "阪堺電気軌道上町線": "阪堺電軌上町線",
  "大阪モノレール本線": "大阪モノレール線",
  "大阪モノレール彩都線": "国際文化公園都市線(大阪モノレール彩都線)",
  "能勢電鉄": "能勢電鉄妙見線",
  "能勢電鉄妙見線": "能勢電鉄妙見線",
  "能勢電鉄日生線": "能勢電鉄日生線",
  "近鉄信貴線": "近鉄信貴線",
  "近鉄西信貴ケーブル線": "近鉄西信貴鋼索線(西信貴ケーブル)",
  "水間鉄道水間線": "水間鉄道水間線",
  "関西空港線": "JR関西空港線",
};

// リアプロ路線名 → REINS の沿線名（テキスト入力）
// ※ 阪急の3本（神戸線・宝塚線・京都線）は memory の表では「〜本線」。どちらが REINS の画面の表記かは未確定（竹内さんに確認中・決まるまで変えない）
export const REINS_LINE_MAP: Record<string, string> = {
  "大阪市高速軌道御堂筋線": "大阪メトロ御堂筋線",
  "大阪市高速軌道谷町線": "大阪メトロ谷町線",
  "大阪市高速軌道中央線": "大阪メトロ中央線",
  "大阪市高速軌道堺筋線": "大阪メトロ堺筋線",
  "大阪市高速軌道四つ橋線": "大阪メトロ四つ橋線",
  "大阪市高速軌道千日前線": "大阪メトロ千日前線",
  "大阪市高速軌道長堀鶴見緑地線": "大阪メトロ長堀鶴見線",
  "大阪市高速軌道今里筋線": "大阪メトロ今里筋線",
  "大阪市高速軌道南港ポートタウン線": "南港ポートタウン線",
  "阪急電鉄神戸線": "阪急神戸線",
  "阪急電鉄宝塚線": "阪急宝塚線",
  "阪急電鉄京都線": "阪急京都線",
  "阪急電鉄千里線": "阪急千里線",
  "阪急電鉄箕面線": "阪急箕面線",
  "阪神電鉄本線": "阪神本線",
  "阪神電鉄阪神なんば線": "阪神なんば線",
  "南海電鉄南海本線": "南海本線",
  "南海電鉄南本線": "南海本線",
  "南海電鉄高野線": "南海高野線",
  "南海電鉄泉北線": "南海泉北線",
  "南海電鉄空港線": "南海空港線",
  "南海電鉄多奈川線": "南海多奈川線",
  "南海電鉄汐見橋線": "南海汐見橋線",
  "南海電鉄高師浜線": "南海高師浜線",
  "京阪電気鉄道京阪線": "京阪本線",
  "京阪電気鉄道中之島線": "京阪中之島線",
  "京阪電気鉄道交野線": "京阪交野線",
  "北大阪急行南北線": "北大阪急行",
  "JR東西線": "東西線",
  "大阪環状線": "大阪環状線",
  "おおさか東線": "おおさか東線",
  "片町線": "片町線",
  "阪和線": "阪和線",
  "福知山線": "福知山線",
  "関西線": "関西線",
  "関西本線": "関西線",
  "関西空港線": "関西空港線",
  "桜島線": "桜島線",
  "大阪モノレール本線": "大阪モノレール本線",
  "大阪モノレール彩都線": "大阪モノレール彩都線",
  "近鉄難波・奈良線": "近鉄奈良線",
  "近鉄南大阪線": "近鉄南大阪線",
  "近鉄大阪線": "近鉄大阪線",
  "近鉄けいはんな線": "近鉄けいはんな線",
  "近鉄信貴線": "近鉄信貴線",
  "近鉄道明寺線": "近鉄道明寺線",
  "近鉄長野線": "近鉄長野線",
  "能勢電鉄": "能勢電鉄",
  "能勢電鉄妙見線": "能勢電鉄",
  "能勢電鉄日生線": "能勢電鉄",
  "水間鉄道": "水間鉄道",
  "水間鉄道水間線": "水間鉄道",
  "東海道本線": "東海道本線",
  "泉北高速鉄道線": "泉北線",
  "阪堺電気軌道上町線": "阪堺電気軌道上町線",
  "阪堺電気軌道阪堺線": "阪堺電気軌道阪堺線",
};

/** リアプロの路線名の並びから ITANDI の路線ラベルを作る。表に無い路線は unmapped に入れて、変換した値には混ぜない */
export function mapRealproToItandi(realproLines: string[]): { lines: string[]; unmapped: string[] } {
  const out: string[] = [];
  const unmapped: string[] = [];
  for (const l of realproLines) {
    const m = ITANDI_LINE_MAP[l];
    if (m === undefined) { unmapped.push(l); continue; }
    for (const x of Array.isArray(m) ? m : [m]) if (!out.includes(x)) out.push(x);
  }
  return { lines: out, unmapped };
}

/** REINS は1本だけ（拡張と同じく最初の路線）。表に無ければ null */
export function mapRealproToReins(realproLines: string[]): string | null {
  const first = realproLines[0];
  if (!first) return null;
  return REINS_LINE_MAP[first] ?? null;
}

export type SiteLinesPrev = { itandi_lines?: string[] | null; reins_line?: string | null };
export type SiteLinesResult = {
  itandi_lines: string[];
  reins_line: string | null;
  /** 各列をどうしたか: rebuilt=作り直した / kept=前の値を残した（変換できない路線があった・路線の指定が無い） */
  itandi: "rebuilt" | "kept";
  reins: "rebuilt" | "kept";
  /** 表に無くて変換できなかったリアプロの路線名 */
  unmapped_itandi: string[];
  unmapped_reins: string[];
};

/**
 * スタッフがリアプロの路線を直した時に、ITANDI・REINS の列も同じ対応表で作り直す（station-map の POST）。
 * - changed=true（リアプロの路線が新しく入った）: 全部変換できた列だけ作り直す。1本でも表に無い路線がある列は前の値のまま（中途半端に混ぜない）
 * - changed=false（路線の指定なし）: 前の値を残す。ただし前の値が空の列だけ、今のリアプロの路線から埋める（全部変換できた時だけ）
 */
export function deriveSiteLines(realproLines: string[], prev: SiteLinesPrev | null, changed: boolean): SiteLinesResult {
  const prevItandi = Array.isArray(prev?.itandi_lines) ? prev!.itandi_lines! : [];
  const prevReins = prev?.reins_line ?? null;
  const it = mapRealproToItandi(realproLines);
  const reinsNew = mapRealproToReins(realproLines);
  const unmappedReins = realproLines.length && reinsNew === null ? [realproLines[0]] : [];

  const canItandi = realproLines.length > 0 && it.unmapped.length === 0;
  const canReins = realproLines.length > 0 && reinsNew !== null;
  const wantItandi = changed || prevItandi.length === 0;
  const wantReins = changed || !prevReins;

  const itandiRebuilt = wantItandi && canItandi;
  const reinsRebuilt = wantReins && canReins;
  return {
    itandi_lines: itandiRebuilt ? it.lines : prevItandi,
    reins_line: reinsRebuilt ? reinsNew : prevReins,
    itandi: itandiRebuilt ? "rebuilt" : "kept",
    reins: reinsRebuilt ? "rebuilt" : "kept",
    unmapped_itandi: it.unmapped,
    unmapped_reins: unmappedReins,
  };
}
