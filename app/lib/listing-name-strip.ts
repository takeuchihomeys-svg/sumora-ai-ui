// app/lib/listing-name-strip.ts — 資料の物件名からサイト名・「最新」の付記だけを外す（純関数）
//
// 2026-10-28 竹内さん（ももか 10/21 の物件オススメ「🌟ACT正雀(イタンジ最新) 102号室」）
//   「itandi と謎の情報が入っている。資料にイタンジ等の名前が入っていたら抜いておく」。
//   出どころ: ITANDI の建物名そのものに管理会社が付けた付記（「(イタンジ最新)」）。拡張がそのまま property_pickups.property_name に記録し、
//   物件オススメの見出しは aix-material-facts.alignStarHeadToMaterial が資料の字にそろえるので、付記ごと本文と送付の記録（sent_properties）に入った。
//   本番の記録（10/28）: sent_properties 7建物・31行（ACT正雀 15・シャンタラム吹田 6・アート北巽 4 …）。
//   外すのは「かっこの中にサイト名か『最新』がある」かっこだけ（竹内さんの決定＝推奨どおり）。
//   旧名「(旧:〜)」・フリガナ「(ギャラリー谷町)」・「(フルリノベーション)」「(OR)」は外さない（別の判断・監査で読んでから）。
//   切替 LISTING_NAME_STRIP=on の時だけ（既定 off）。入口（ピックアップの記録）と出口（物件オススメの見出しをそろえる所）の2か所で使う。
// テスト: app/lib/__tests__/listing-name-strip.test.ts

export function listingNameStripEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LISTING_NAME_STRIP ?? "").trim().toLowerCase() === "on";
}

/** かっこの中にあれば外す語（サイト名・「最新」） */
const SITE_WORD_RE = /イタンジ|ITANDI|itandi|Itandi|リアプロ|REALPRO|Realpro|レインズ|REINS|reins|SUUMO|suumo|スーモ|HOME'?S|ホームズ|アットホーム|at\s?home|athome|最新/;
/** 全角・半角のかっこ1組（入れ子は見ない） */
const PAREN_RE = /\s*[（(]([^（）()]{1,20})[）)]\s*/g;

/** 物件名からサイト名・「最新」の付記のかっこを外す。外す物が無ければそのまま。全部外れて空になる時は元のまま */
export function stripListingAnnotation(name: string): string;
export function stripListingAnnotation(name: string | null | undefined): string | null | undefined;
export function stripListingAnnotation(name: string | null | undefined): string | null | undefined {
  if (!name) return name;
  const out = name.replace(PAREN_RE, (all, inner: string) => (SITE_WORD_RE.test(inner) ? "" : all)).trim();
  return out ? out : name;
}

/** 切替つき（off は元のまま） */
export function maybeStripListingName<T extends string | null | undefined>(name: T, enabled: boolean = listingNameStripEnabled()): T {
  return (enabled ? stripListingAnnotation(name) : name) as T;
}

/**
 * 出口: 本文の見出しの行（「🌟建物 号室」「【建物 号室】」）だけから付記のかっこを外す（本文の他の行は触らない）。
 *   行 ID が無く見出しを資料にそろえない時（alignStarHeadToMaterial が動かない時）も、LLM が資料の字を写した付記を落とす
 */
export function stripListingAnnotationInHeads(text: string): { text: string; changed: boolean } {
  let changed = false;
  const out = String(text ?? "").split("\n").map((l) => {
    // 見出しの行だけ: 🌟の行／【建物 号室】の行（監査 10/28: 社内の「【グループ】…物件（リアプロ）」は見出しでない＝触らない）
    if (!/^\s*🌟/.test(l) && !/^\s*【[^】]*[0-9０-９]{2,5}(?:号室)?\s*】/.test(l)) return l;
    let hit = false;
    // かっこは空白1つに置き換え（「ACT正雀(イタンジ最新)102号室」でも建物と号室の間が空く）→ 】の前・行末の空白と重なった空白を詰める
    const s0 = l.replace(PAREN_RE, (all, inner: string) => (SITE_WORD_RE.test(inner) ? ((hit = true), " ") : all));
    if (!hit) return l; // 付記が無い行は1文字も変えない（行末の空白も残す）
    const s = s0.replace(/\s+】/g, "】").replace(/[ \t]+$/, "");
    const fixed = s.replace(/(\S) {2,}/g, "$1 ");
    if (fixed !== l) changed = true;
    return fixed;
  });
  return { text: out.join("\n"), changed };
}
