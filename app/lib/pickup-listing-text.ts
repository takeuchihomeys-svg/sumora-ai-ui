// app/lib/pickup-listing-text.ts（純関数・import なし・画面とサーバーで共用）
// 売上サポのピックアップの物件カードに、物件資料（PDF の文字層 pdf_text）の文字をそのまま出すための読み取り。
//
// 2026-09-27 竹内（YUMA テストの AIXツールのスクショを見て）:
//   「物件名に号室もいれる」「AD の項目は重要なので物件名の横にもスタンプでいれる」
//   ＋ 9/27「物件の資料の中の文字変えなくても…文字抜かなくてそのまま使う」（feedback_pickup_material_verbatim）
// 決まり:
//   - 号室: 資料の「号室名 703（7階部分）」の 703 を先に使い、無い行（itandi 等）は保存済みの room_no（2.5.31 から資料の文字のまま）。
//     先頭の 0・英字（005B）を落とさない。どちらも無ければ出さない（推測しない）
//   - AD の札: 資料の「A D 2ヶ月（税込）（-1万）」「広告料 2ヶ月（税込）」「A D 100％」を 1文字も変えずに（A と D の間の空白・括弧の付け足しも）。
//     AD は元付業者のページ（偶数ページ）の末尾にある → 文字層の中で最後に出る物を採る（弊社帯の奇数ページには書かれない）。
//     「広告掲載 可」「webサービス広告掲載 [許可]」は AD ではない（「広告料」「広告費」だけ・値は数字か なし）。無ければ出さない
//   - 説明文の「AD 2ヶ月」（拡張の一覧の列・資料から足した行）は資料の文字ではないので札には使わない（カードの AD のマスは今まで通り）

/** AD の見出し（リアプロの元付は「A D」と空白が入る・全角も） */
const AD_HEAD = String.raw`(?<![A-Za-zＡ-Ｚａ-ｚ])(?:A\s?D|Ａ\s?Ｄ)(?![A-Za-zＡ-Ｚａ-ｚ])|広告料|広告費`;
/**
 * リアプロの資料は元付業者のページの最後の行が AD の欄で、見出しは元付の書き方のまま（9/20〜 145行の実物）:
 *   「A D 2ヶ月（税込）（-1万）」「広告料 2ヶ月（税込）」「BK 2ヶ月（税込）」「業務委託料 2ヶ月（税込）」「委託業務報酬 250％（税込）」
 *   「対応補助業務手数料 3ヶ月（ー11,000円(税込)）」。前の欄の続きに付く時もある（「…迄 広告料 2ヶ月（税込）」）
 *   → 最後の行の中ではこの広い見出しも AD とみなす（「契約事務手数料」「仲介手数料」は当たらない）
 */
const AD_HEAD_LAST_LINE = String.raw`${AD_HEAD}|(?<![A-Za-zＡ-Ｚａ-ｚ])(?:BK|ＢＫ)(?![A-Za-zＡ-Ｚａ-ｚ])|[一-龥]{0,6}(?:委託料|業務報酬|委託報酬|業務手数料)`;
/** 値の始まり（数字・なし／無し）。値から後ろは行の終わりまで資料の文字のまま（括弧の付け足し・空白も） */
const AD_VALUE_START = String.raw`(?=[\d０-９]|なし|無し)`;
const LAST_LINE_RE = new RegExp(String.raw`(?:${AD_HEAD_LAST_LINE})[ \t　]*[:：]?[ \t　]*${AD_VALUE_START}`, "gu");
/** 行の途中（itandi 等）: 見出し → 値（単位まで）→ 括弧の付け足しは空白まで */
const AD_VALUE = String.raw`(?:[\d０-９][\d０-９.,，．]*[ \t　]?(?:ヶ月|ヵ月|カ月|か月|ケ月|ヶ|%|％|円|万円)?|なし|無し)`;
const AD_PHRASE_RE = new RegExp(String.raw`(?:${AD_HEAD})[ \t　]*[:：]?[ \t　]*${AD_VALUE}[^\s]*`, "gu");

/**
 * 資料の文字層から AD の書き方を資料の文字のまま（無ければ null）。
 *   ①最後の行（リアプロの元付業者のページの AD の欄）に見出し＋値があれば、見出しから行の終わりまで
 *   ②無ければ文字全体で「AD／広告料／広告費 ＋ 値」の最後に出る物（元付業者のページ・itandi の「広告費 100 ％」）
 *   値の無い欄（「A D」だけ）・「広告掲載 [許可]」は AD ではない → null
 */
export function listingAdText(pdfText: string | null | undefined): string | null {
  const t = String(pdfText ?? "").replace(/\r/g, "");
  if (!t.trim()) return null;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const hits = [...last.matchAll(LAST_LINE_RE)];
  if (hits.length) return last.slice(hits[hits.length - 1].index).trim();
  const all = [...t.matchAll(AD_PHRASE_RE)].map((m) => m[0].trim()).filter(Boolean);
  return all.length ? all[all.length - 1] : null;
}

/**
 * AD の札を「芯」（見出し＋値＋（税込）（税抜））と「付け足し」（残りの括弧書き）に分ける。つなげると元の文字と同じ（1文字も落とさない）。
 *   「A D 2ヶ月（税込）（-1万）」→ 芯「A D 2ヶ月（税込）」＋付け足し「（-1万）」
 */
export function splitAdStamp(text: string): { core: string; rest: string } {
  const m = text.match(/^(.*?(?:[\d０-９][\d０-９.,，．]*[ \t　]?(?:ヶ月|ヵ月|カ月|か月|ケ月|ヶ[⽉月]?|%|％|円|万円)?|なし|無し)(?:[（(]税[込抜][）)])?)([\s\S]*)$/u);
  if (!m) return { core: text, rest: "" };
  return { core: m[1], rest: m[2] };
}

/** 資料の「号室名 703（7階部分）」の号室（資料の文字のまま・無ければ null） */
export function listingRoomText(pdfText: string | null | undefined): string | null {
  const m = String(pdfText ?? "").match(/号室名[ \t　]*[:：]?[ \t　]*([0-9A-Za-z０-９Ａ-Ｚａ-ｚ\-－]+)/u);
  return m ? m[1] : null;
}

/**
 * 物件名に号室を付ける（「ラ・フォーレ東天満 703」）。号室が無ければ名前だけ。
 *   名前の末尾に同じ号室（「… 703」「… 703号室」）が既にあれば付けない（二重にしない）
 */
export function nameWithRoom(name: string | null | undefined, room: string | null | undefined): string {
  const n = String(name ?? "").trim();
  const r = String(room ?? "").trim();
  if (!r) return n;
  if (!n) return r;
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|[\\s　])${esc}(?:号室)?$`, "u").test(n)) return n;
  return `${n} ${r}`;
}

/**
 * カードに出す号室（資料の号室名 → 保存済みの room_no）。無ければ null。
 *   資料の文字を先にする: 2.5.31 より前の行は room_no の先頭の 0 が落ちている（9/20〜 145行中 13行: 資料「0403」↔ room_no「403」）
 */
export function cardRoom(roomNo: string | null | undefined, roomText: string | null | undefined): string | null {
  return String(roomText ?? "").trim() || String(roomNo ?? "").trim() || null;
}

// ── 画像で分析をカードにまとめる（2026-09-27 竹内「画像で分析の部分も上の部分にまとめる。点数のと画像で分析がわかれていたらみにくい」）──

export type ImageAnalysisLike = {
  match?: unknown; match_raw?: unknown; ok_count?: unknown;
  checks?: Array<{ id?: string; result?: string; why?: string }> | unknown;
  review?: { status?: string; reasons?: string[] } | null;
  [k: string]: unknown;
} | null | undefined;

/** カードの「🔍 画像」の札の状態 */
export type ImageChip =
  | { kind: "scored"; match: number; ok: number; ng: number; text: string }
  | { kind: "needs_check"; text: string }
  | { kind: "unscored"; text: string }
  | { kind: "waiting"; text: string };

/**
 * 1件の画像で分析の札（純関数）。
 *   分析済み・点あり →「🔍 画像 86点（◎5・×1）」／物件と資料が合わない →「🔍 画像 要確認」／分析したが点なし →「🔍 画像 点なし」／
 *   まだ分析していない → showWaiting の時だけ「🔍 画像の分析待ち」（画像で確かめる希望が無いお客様では出さない＝null）
 */
export function imageChipOf(a: ImageAnalysisLike, showWaiting: boolean): ImageChip | null {
  if (!a) return showWaiting ? { kind: "waiting", text: "🔍 画像の分析待ち" } : null;
  if (a.review?.status === "要確認") return { kind: "needs_check", text: "🔍 画像 要確認" };
  const checks = Array.isArray(a.checks) ? (a.checks as Array<{ result?: string }>) : [];
  const ok = checks.filter((c) => c?.result === "ok").length;
  const ng = checks.filter((c) => c?.result === "ng").length;
  if (typeof a.match === "number" && Number.isFinite(a.match)) {
    return { kind: "scored", match: a.match, ok, ng, text: `🔍 画像 ${a.match}点${checks.length ? `（◎${ok}・×${ng}）` : ""}` };
  }
  return { kind: "unscored", text: "🔍 画像 点なし" };
}

/**
 * 回（まとめた回）の画像で分析の1行: 「🔍 画像で分析 9/10件（分析待ち 1件・要確認 0件）」。1件も分析していなければ null
 */
export function roundImageLine(items: ReadonlyArray<{ image_analysis?: ImageAnalysisLike; status?: string | null }>): string | null {
  const done = items.filter((x) => !!x.image_analysis);
  if (!done.length) return null;
  const needsCheck = done.filter((x) => x.image_analysis?.review?.status === "要確認").length;
  // 分析待ちは未送信（pending）の物だけ（送信済み・見送りはもう分析しない＝👑 の行の「分析待ち」と同じ数え方）。status が無い時は未送信とみる
  const waiting = items.filter((x) => !x.image_analysis && (x.status == null || x.status === "pending")).length;
  const extra = [waiting ? `分析待ち ${waiting}件` : "", needsCheck ? `要確認 ${needsCheck}件` : ""].filter(Boolean).join("・");
  return `🔍 画像で分析 ${done.length}/${items.length}件${extra ? `（${extra}）` : ""}`;
}

/** 👑 の行の点（「判定 162点・画像 86点」）。画像の点が無ければ判定の点だけ */
export function pointsLabel(score: number | null | undefined, a: ImageAnalysisLike): string {
  const s = typeof score === "number" ? `判定 ${score}点` : "判定 －";
  const m = a && a.review?.status !== "要確認" && typeof a.match === "number" ? `・画像 ${a.match}点` : "";
  return `${s}${m}`;
}
