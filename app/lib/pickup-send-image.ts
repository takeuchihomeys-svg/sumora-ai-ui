// app/lib/pickup-send-image.ts（純関数・何も import しない・画面とサーバーで共用）
// お客様に送る物件の画像＝「元の資料のページ（奇数ページ＝弊社帯の面）をそのまま画像にした物」を決める。
//
// 2026-09-27 竹内「物件はいま文字とか入れなおしてるけど、そのままの画像つかったら大丈夫」（＝資料の画像を加工しない）。
//   調べた事実（保存済みの資料 103件・Vercel Blob の写し）:
//   ・リアプロの資料 85件は全部、文字の書体（MS ゴシック）を PDF の中に持っていない（埋め込みなし）。開いた機械の MS ゴシックで描かれる。
//     サーバー（Linux）には MS ゴシックが無いので、page_image_url は同梱の Noto Sans JP に**全部の文字を差し替えて**描いている＝「文字を入れなおした」画像。
//     MS ゴシックの無い端末（iPhone 等）の画面で描いても、別の書体に差し替わる。
//   ・itandi の資料 18件は書体を全部 PDF の中に持っている（埋め込み）→ どこで描いても元の字形（サーバーでも字形の線で描く＝fillText が0回）。
//   ・スタッフのパソコン（Windows）の画面で描いた物（trim_image_url の主経路）は、Chrome で資料を開いた時と同じ（実測: 差 0.98／Noto 2.85）。
//   → 送る画像は「資料の書体のまま描けた時だけ」作る。書体を差し替えないと描けない所（サーバーの予備・MS ゴシックの無い端末）では作らない。
//     切り取りもしない（ページ全体・奇数ページ＝弊社帯の面だけ。偶数ページ＝元付業者の面は送らない）。
//   ※ 列の名前は trim_image_url のまま（2026-09-24 の「トリミング」の名残）。中身は 2026-09-24 から切り取りなし（keepRatio 1.0）で、
//     2026-09-27 からは「資料の書体のまま描けたページ全体」だけを入れる。

/** お客様に送る面（奇数ページ＝弊社帯）。1物件の資料は「1＝弊社帯・2＝元付業者」の2ページ組（保存済み 103件が全部2ページ） */
export const SEND_PAGE = 1;

/**
 * お客様に送る物件の画像（AIX【物件ピックアップ】【物件オススメ】・💾 画像保存）。元の資料のページをそのまま描いた物だけ。
 * page_image_url（サーバーが書体を差し替えて描いた画像）・agent_image_url（元付業者の面）は**選ばない**（引数の型にも入れない）。
 * 無ければ null（＝画面が先に元の資料から作る）
 */
export function pickSendImageUrl(r: { trim_image_url?: string | null }): string | null {
  return r.trim_image_url || null;
}

/** pdfjs の置き換えの CSS（`"MS Gothic",g_d0_sf2,serif`）の先頭の家族名＝資料が求めている書体。読めなければ null */
export function requestedFamilyFromSubstitution(css: string | null | undefined): string | null {
  const s = String(css ?? "").trim();
  if (!s) return null;
  const first = s.split(",")[0].trim().replace(/^["']|["']$/g, "").trim();
  // pdfjs が付ける内部名（g_d0_sf2 等）・総称（serif 等）は資料の書体ではない
  if (!first || /^g_d\d+_/.test(first) || /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(first)) return null;
  return first;
}

/**
 * pdfjs の getTextContent（fontExtraProperties: true）の styles から、PDF に埋め込まれていない（端末の書体で描く）書体の名前を集める。
 * 埋め込まれている書体には fontSubstitution が付かない（＝どこで描いても元の字形）
 */
export function requestedSystemFamilies(styles: Record<string, { fontSubstitution?: string | null; [k: string]: unknown } | undefined> | null | undefined): string[] {
  const out: string[] = [];
  for (const st of Object.values(styles ?? {})) {
    const f = requestedFamilyFromSubstitution(st?.fontSubstitution ?? null);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

export type OriginalRenderJudge =
  | { ok: true }
  | { ok: false; reason: "font_missing" | "no_text_drawn"; missing: string[]; message: string };

/**
 * 元の資料の画像がまだ無い時に、何をすれば送れるか（スタッフ向け・スマホで押した時に出る）。
 * 2026-09-27 竹内「なぜ送れないのか？画像をそのままの蓮産業の画像で保存していたらそのまま使える」:
 *   資料が届いた時点でパソコン（拡張・MS ゴシックあり）が画像を先に作って保存する（/pickup-prerender）。スマホはその画像を使うだけ
 */
export const PC_PRERENDER_HINT = "パソコンの拡張でまだ画像が作られていません（パソコンで売上サポを開くと作られます。数分後にもう一度押してください）";

/** 端末に書体が無い時の文（スタッフ向け） */
export function fontMissingMessage(missing: readonly string[]): string {
  return `この端末には資料の書体（${missing.join("・")}）が無く、元の資料と同じ文字で画像にできません。${PC_PRERENDER_HINT}`;
}

/** サーバーの予備でも元の資料のまま描けない時の文（リアプロの資料＝MS ゴシックの埋め込みなし） */
export const SERVER_FONT_MISSING_MESSAGE = `資料の書体（MS ゴシック）がサーバーに無く、元の資料と同じ文字で画像にできません。${PC_PRERENDER_HINT}`;

/** パソコンが先に画像を作る範囲（届いてからの日数）。古い行は送らないので作らない */
export const PRERENDER_MAX_AGE_DAYS = 7;
/** 1回に作る数（1件 数秒・画面を止めない量） */
export const PRERENDER_BATCH = 10;

/**
 * パソコンが先に「送る画像」を作っておく行か（純関数）。
 * 元の資料（PDF）があり・送る画像がまだ無く・送っていない（pending）・期限切れでない・届いてから PRERENDER_MAX_AGE_DAYS 日以内
 */
export function needsPrerender(r: { pdf_blob_url?: string | null; trim_image_url?: string | null; status?: string | null; expired_at?: string | null; created_at?: string | null }, nowMs: number = Date.now()): boolean {
  if (!r.pdf_blob_url || r.trim_image_url) return false;
  if (r.status !== "pending" || r.expired_at) return false;
  const t = r.created_at ? Date.parse(r.created_at) : NaN;
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= PRERENDER_MAX_AGE_DAYS * 86_400_000;
}

/**
 * 画面で描いた画像が「元の資料と同じ」か（純関数）。
 * @param requested  資料が端末の書体で描くよう求めている書体（requestedSystemFamilies）
 * @param available  その書体が端末にあるか（画面が測った結果）
 * @param textChars  資料の文字層の文字数
 * @param textDraws  描いた文字の命令の数（fillText／strokeText）
 */
export function judgeOriginalRender(p: { requested: readonly string[]; available: (family: string) => boolean; textChars: number; textDraws: number }): OriginalRenderJudge {
  const missing = p.requested.filter((f) => !p.available(f));
  if (missing.length > 0) return { ok: false, reason: "font_missing", missing, message: fontMissingMessage(missing) };
  // 2026-09-24 からの検査: 文字のある資料なのに1文字も描けていない（白い表）
  //   ※ 埋め込みの書体を字形の線で描く描き方では fillText が0回になるので、端末の書体を求める資料（requested あり）の時だけ見る
  if (p.requested.length > 0 && p.textChars >= 40 && p.textDraws === 0) {
    return { ok: false, reason: "no_text_drawn", missing: [], message: `文字が描けない（資料の文字 ${p.textChars}字・描いた文字 0）` };
  }
  return { ok: true };
}

/**
 * サーバー（pdf-render・Node）で描いた画像が元の資料と同じか。
 * Node の pdfjs は埋め込みの書体を字形の線で描き（fillText を使わない）、埋め込みの無い書体だけを fillText（＝同梱の Noto Sans JP に差し替え）で描く。
 * → 描いた文字の命令が0回＝全部の文字が資料の書体のまま（itandi の資料）。1回でもあれば書体を差し替えた（リアプロの資料）
 */
export function serverRenderIsOriginal(textDraws: number | null | undefined): boolean {
  return textDraws === 0;
}
