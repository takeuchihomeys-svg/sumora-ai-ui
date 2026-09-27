// app/lib/room-jo.ts（純関数・DB/LLM 依存なし・import なし＝property-brain・sheet-facts・画面のどこからでも使える）
// 洋室の帖数: お客様の希望（「7畳以上の部屋」）と、物件の資料の文字・間取り図の読み取りの帖数を、決まった手順で読んで比べる。
//
// 2026-09-27 竹内（未桜さん「大国町エリアで1Kでできたら7畳以上の部屋で探してます」）:
//   「7畳以上は、帖数が資料に書かれていなかったら間取り図から読み取る」。
//   それまでは preferences に「7畳以上の部屋」と文字で入るだけで、検索にも判定にも効いていなかった
//   （normalizeFloorPlanWant は「1K(7畳)以上」を間取りとしてだけ読み、帖数は捨てていた）。
//
// 実測（2026-09-27・property_pickups 157行・scripts/tmp-jo-*.ts）:
//   - 説明文（summary_text）に帖数は 0件。資料の文字層（pdf_text）の「間取タイプ 1K[洋:6.5畳]」の形で 13件・
//     画像の読み取り（image_lines）の「間取り: 1K【洋6帖】」で 15件。形は「[洋:9.98畳]」「[6.6帖K]」「[9.7帖]」（種類なし）
//     「[洋室約8.6帖×K]」「[洋:6.2畳 K:2畳]」「[DK:7.2畳 洋:4.3畳]」「洋室7帖」「（洋:7畳）」
//   - 間取り図の読み取り（property_sheet_facts.image_facts.rooms）は 84件中 68件で帖数あり
//   - お客様の書き方（property_customers 306人中 15人）: 「7畳以上の部屋」「1K(7畳)以上」「6帖以上」「寝室8帖以上」
//     「できれば寝室4.5畳以上欲しい」「洋室が5~6帖以上」「5畳以上必須、和室でも可」「8畳程度」「希望は7畳前後」
//     「1K(収納広ければ7畳～)」／LDK の帖数「リビング10帖以上」「リビング22.1帖」／希望ではない「5帖の部屋にエアコンがないのが気になる」
//
// 決まり:
//   - 希望の種類は「洋」（洋室・寝室・和室・居室・部屋・種類なし）と「LDK」（リビング・LDK・LD・DK・ダイニング）に分ける。
//     洋室の下限だけが判定（ROOM_JO_*）に効く。LDK の帖数は読むだけ（判定にはまだ入れない）
//   - 「以上・〜・から」と数字だけ（「7畳」）は下限そのもの。「前後・程度・くらい」は目安（approx）。「以下・まで・未満」・
//     「気になる・ない・嫌・NG」の文は希望として読まない
//   - 物件の洋室の帖数は、居室（洋・和・種類なしの居室）の一番広い帖数（「寝室8帖以上」の 2LDK は 1部屋でも 8帖あれば合う）。
//     種類の書いていない帖数（「1K[9.7帖]」）は 1R・1K の時だけ居室とみなす（1DK・1LDK では DK の帖数かもしれないので使わない）
//   - 資料の文字で決まらなければ間取り図の読み取り（sheet-prompt の rooms）を使う。それも無ければ「要確認」

const nfkc = (s: string) => String(s ?? "").normalize("NFKC");

/** 漢数字の帖数（「六畳」「四畳半」）を数字に（希望の文だけ） */
function kanjiJo(s: string): string {
  const D: Record<string, string> = { 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10" };
  return s
    .replace(/([一二三四五六七八九十])\s*(?=[帖畳]半)/g, (_m, d: string) => D[d])
    .replace(/(\d+)\s*([帖畳])半/g, (_m, n: string, u: string) => `${n}.5${u}`)
    .replace(/(?<![一-龥])([一二三四五六七八九十])\s*(?=[帖畳])/g, (_m, d: string) => D[d]);
}

// ── お客様の希望 ─────────────────────────────────────────────────────────────

export type RoomJoKind = "洋" | "LDK";
export type RoomJoWant = {
  kind: RoomJoKind;
  /** 下限の帖数（「5~6帖以上」は 5） */
  jo: number;
  /** 「前後・程度・くらい」＝目安 */
  approx: boolean;
  /** 「できれば・できたら・あれば」 */
  soft: boolean;
  /** 読んだ元の文（短く） */
  text: string;
};

/** 希望の文の種類の語（数字の前にある一番近い物で決める）。数字の後ろの「1K」「1LDK」の K・LDK は間取りの型なので見ない */
const WANT_LABEL_RE = /(リビング|ダイニング|(?<![0-9])S?L\.?D\.?K|(?<![0-9])LD(?!K)|(?<![0-9L])DK|洋室|洋間|洋|寝室|和室|和|居室|部屋|個室)/g;
const WANT_LDK_LABEL = /^(?:リビング|ダイニング|S?L\.?D\.?K|LD|DK)$/;
/** 希望として読まない文（上限・気になる点・不満） */
const WANT_SKIP_RE = /以下|まで|未満|気にな|ない|無い|嫌|いや|NG|ダメ|だめ|狭い|狭く|小さい|小さく/;
const APPROX_RE = /^\s*(?:前後|程度|くらい|ぐらい|位|ほど|ちょっと)/;
const SOFT_RE = /できれば|出来れば|できたら|出来たら|あれば|なるべく|理想/;
/** 帖数の範囲の目安（洋室 3〜30帖・LDK 5〜40帖。外は別の数＝号室・家賃の読み違い） */
const WANT_RANGE: Record<RoomJoKind, [number, number]> = { 洋: [3, 30], LDK: [5, 40] };

/**
 * 1つの文から帖数の希望を読む（純関数）。
 *   「7畳以上の部屋」「7帖以上」「1K(7畳)以上」「洋室7帖以上」→ 洋 7 ／「7畳」だけ→ 洋 7 ／「LDK12帖以上」「リビング10帖以上」→ LDK 12・10
 */
export function parseRoomJoWants(text: string | null | undefined): RoomJoWant[] {
  const out: RoomJoWant[] = [];
  const t = kanjiJo(nfkc(String(text ?? ""))).toUpperCase().replace(/[〜～]/g, "~");
  for (const clause of t.split(/[\n。、,，／/]|・(?![0-9])/)) {
    if (!/[帖畳]|\dJ(?![A-Z])/.test(clause)) continue;
    const soft = SOFT_RE.test(clause);
    const re = /(\d{1,2}(?:\.\d{1,2})?)\s*(?:[~\-]\s*(\d{1,2}(?:\.\d{1,2})?)\s*)?(?:帖|畳|J(?![A-Z]))/g;
    for (const m of clause.matchAll(re)) {
      const at = m.index ?? 0;
      const after = clause.slice(at + m[0].length, at + m[0].length + 10);
      // 上限・不満の文（「6畳以下」「5帖の部屋にエアコンがないのが気になる」）は希望として読まない
      if (WANT_SKIP_RE.test(after) || WANT_SKIP_RE.test(clause.slice(at + m[0].length))) continue;
      // 「1K(7畳)以上」: 括弧を閉じた後の「以上」も下限
      const afterParen = after.replace(/^\s*[)）]\s*/, "");
      const approx = APPROX_RE.test(afterParen);
      // 種類: 数字の前（同じ文の中）で一番近い語
      const before = clause.slice(0, at);
      const labels = [...before.matchAll(WANT_LABEL_RE)];
      const last = labels.length ? labels[labels.length - 1][1] : "";
      const kind: RoomJoKind = WANT_LDK_LABEL.test(last.replace(/\./g, "")) ? "LDK" : "洋";
      const jo = parseFloat(m[1]);
      const [lo, hi] = WANT_RANGE[kind];
      if (!Number.isFinite(jo) || jo < lo || jo > hi) continue;
      out.push({ kind, jo, approx, soft, text: clause.trim().slice(0, 40) });
    }
  }
  return out;
}

/**
 * 洋室の帖数の下限（純関数）。文を全部読んで、洋の希望の一番大きい下限（目安でない物を先に）。無ければ null。
 *   未桜さん「大国町エリアで1Kでできたら7畳以上の部屋で探してます」→ 7
 */
export function parseRoomJoMin(...texts: Array<string | null | undefined>): number | null {
  return roomJoWantOf(texts)?.jo ?? null;
}

/** 洋室の帖数の希望（下限・目安か・できればか）。LDK の希望は入れない */
export function roomJoWantOf(texts: ReadonlyArray<string | null | undefined>, kind: RoomJoKind = "洋"): RoomJoWant | null {
  const all = texts.flatMap((s) => parseRoomJoWants(s)).filter((w) => w.kind === kind);
  if (!all.length) return null;
  const firm = all.filter((w) => !w.approx);
  const pool = firm.length ? firm : all;
  return pool.reduce((a, w) => (w.jo > a.jo ? w : a));
}

// ── 物件の資料の文字 ─────────────────────────────────────────────────────────

export type RoomJoItemKind = "洋" | "和" | "LDK" | "DK" | "K" | "S" | "他" | "?";
export type RoomJoItem = { kind: RoomJoItemKind; jo: number };

function itemKindOf(label: string): RoomJoItemKind {
  const l = label.toUpperCase().replace(/\./g, "");
  if (/^S?LDK$|^LD$|リビング/.test(l)) return "LDK";
  if (/^DK$|ダイニング/.test(l)) return "DK";
  if (/^K$|キッチン|台所/.test(l)) return "K";
  if (/^和/.test(l)) return "和";
  if (/^(?:S|サービスルーム|納戸)$/.test(l)) return "S";
  if (/ロフト|収納|WIC|クローゼット|バルコニー|ベランダ|玄関|テラス|庭/.test(l)) return "他";
  return "洋";
}

/** 資料の種類の語（「洋:」「洋室」「LDK」「K」…）。LDK・DK・K は前が数字でない時だけ（「1K」「1LDK」は間取りの型） */
const ITEM_LABEL = String.raw`(?:(?<![0-9A-Za-z])(?:S?L\.?D\.?K|LD|DK|K)|洋室|洋間|洋|和室|和|寝室|居室|リビング|ダイニング|キッチン|サービスルーム|納戸|ロフト|WIC|収納|(?<![0-9A-Za-z])S(?![A-Za-z]))`;
const NUM = String.raw`(\d{1,2}(?:\.\d{1,2})?)`;
const UNIT = String.raw`(?:帖|畳|J(?![A-Za-z])|jo\b)`;
/** 範囲の外は帖数ではない（号室・㎡・年の読み違い） */
const ITEM_OK = (k: RoomJoItemKind, v: number) => Number.isFinite(v) && v >= 1.5 && v <= (k === "LDK" || k === "DK" ? 60 : 40);

/**
 * 資料の文字（pdf_text・説明文・画像の読み取りの行）から部屋ごとの帖数を読む（純関数）。
 *   ①間取りの型の後ろの括弧の中（「1K[洋:6.5畳]」「1DK【DK:7.2畳 洋:4.3畳】」「1LDK[LDK11.9 x 洋4.4]」「1K[9.7帖]」＝種類なしは「?」）
 *   ②間取りの型の直後の帖数（「1K 6帖」＝種類なし）
 *   ③種類の語の付いた帖数（「洋室 約7.4帖」「LDK11.2帖・洋室6帖」「洋6.0J」）。種類の語の無い帖数は ③では読まない（収納1帖・バルコニー3帖と取り違えない）
 */
export function readRoomJoItems(text: string | null | undefined): RoomJoItem[] {
  const t = nfkc(String(text ?? "")).replace(/[〜～]/g, "~");
  const out: RoomJoItem[] = [];
  const seen = new Set<string>();
  const push = (kind: RoomJoItemKind, v: number) => {
    if (!ITEM_OK(kind, v)) return;
    const key = `${kind}|${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, jo: v });
  };
  const covered: Array<[number, number]> = [];
  // ① 括弧の中
  const bracketRe = /[1-9]\s*(?:S?LDK|SDK|DK|SK|K|R)(?![A-Za-z])\s*[[［(（【]([^\]］)）】]{1,60})[\]］)）】]/g;
  for (const m of t.matchAll(bracketRe)) {
    covered.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    const inner = m[1];
    const tokRe = new RegExp(String.raw`(${ITEM_LABEL})?\s*[:：]?\s*約?\s*≒?\s*${NUM}\s*(${UNIT})?`, "g");
    for (const k of inner.matchAll(tokRe)) {
      const label = k[1] ?? "";
      const unit = k[3] ?? "";
      // 種類も単位も無い数は、「x」「×」の区切りの前だけ読む（2026-09-27 実物 #711「1K[9.3xK]」＝洋室9.3帖）。
      //   括弧の中が数だけの「1K[25.39]」（#678）は専有面積なので読まない
      const next = inner.slice((k.index ?? 0) + k[0].length);
      if (!label && !unit && !/^\s*[x×X＊*]/.test(next)) continue;
      push(label ? itemKindOf(label) : "?", parseFloat(k[2]));
    }
  }
  const inCovered = (i: number) => covered.some(([a, b]) => i >= a && i < b);
  // ② 間取りの型の直後の帖数（「1K 6帖」「1R・7.5帖」）
  for (const m of t.matchAll(new RegExp(String.raw`[1-9]\s*(?:K|R)(?![A-Za-z])\s*[・:：\s]?\s*約?\s*${NUM}\s*${UNIT}`, "g"))) {
    if (inCovered(m.index ?? 0)) continue;
    push("?", parseFloat(m[1]));
  }
  // ③ 種類の語の付いた帖数
  for (const m of t.matchAll(new RegExp(String.raw`(${ITEM_LABEL})\s*[:：]?\s*(?:約|≒)?\s*${NUM}\s*${UNIT}`, "g"))) {
    if (inCovered(m.index ?? 0)) continue;
    push(itemKindOf(m[1]), parseFloat(m[2]));
  }
  return out;
}

/** 文字の中の最初の間取りの型（「間取タイプ」「間取り:」の行を先に）。無ければ null */
export function madoriOfText(text: string | null | undefined): string | null {
  const t = nfkc(String(text ?? "")).toUpperCase();
  const line = t.split("\n").find((l) => /間取/.test(l) && /[1-9]\s*(?:S?LDK|SDK|DK|SK|K|R)(?![A-Z])/.test(l)) ?? t;
  const m = line.match(/([1-9])\s*(S?LDK|SDK|DK|SK|K|R)(?![A-Z])/);
  return m ? `${m[1]}${m[2]}` : null;
}

/**
 * 居室（洋・和）の一番広い帖数（純関数）。種類なし（?）は 1R・1K（型が分からない時は DK・LDK の帖数が無い時）だけ居室とみなす。
 *   読めなければ null
 */
export function mainRoomJo(items: ReadonlyArray<RoomJoItem>, madori: string | null | undefined): number | null {
  const plan = String(madori ?? "").toUpperCase();
  const rk = /^[1-9](?:K|R|SK)$/.test(plan);
  const living = items.filter((r) => r.kind === "洋" || r.kind === "和").map((r) => r.jo);
  const unlabeled = items.filter((r) => r.kind === "?").map((r) => r.jo);
  const hasDk = items.some((r) => r.kind === "DK" || r.kind === "LDK");
  // 種類なしを使うのは 1R・1K（型の分からない時は DK/LDK の帖数が別に無く、種類なしが1つだけの時）
  const useUnlabeled = rk || (!plan && !hasDk && unlabeled.length === 1);
  const pool = [...living, ...(useUnlabeled && living.length === 0 ? unlabeled : [])];
  return pool.length ? Math.max(...pool) : null;
}

/** 種類の中で一番広い帖数（LDK の希望を見る時の LDK・DK） */
export function maxJoOfKinds(items: ReadonlyArray<RoomJoItem>, kinds: ReadonlyArray<RoomJoItemKind>): number | null {
  const v = items.filter((r) => kinds.includes(r.kind)).map((r) => r.jo);
  return v.length ? Math.max(...v) : null;
}

/** 資料の文字から居室の帖数（間取りの型は渡された物 → 文字の中の型の順） */
export function roomJoFromText(text: string | null | undefined, madori?: string | null): number | null {
  const items = readRoomJoItems(text);
  if (!items.length) return null;
  return mainRoomJo(items, madori || madoriOfText(text));
}

// ── 間取り図の読み取り（sheet-prompt の rooms: [{name, jo}]） ───────────────────────

/** 読んだ部屋の名前 → 帖数の種類（sheet-facts.roomKindOf と同じ線。純関数の import を増やさないため同じ物を持つ） */
export function roomNameKind(name: string | null | undefined): RoomJoItemKind {
  const t = nfkc(String(name ?? "")).toUpperCase();
  if (/L\.?D\.?K|^LD$|リビング/.test(t)) return "LDK";
  if (/D\.?K|ダイニング/.test(t)) return "DK";
  if (/^K$|キッチン|台所|KITCHEN/.test(t)) return "K";
  if (/納戸|サービス|^S$|ロフト|収納|WIC|CLOSET|クローゼット|BALCONY|バルコニー/.test(t)) return "他";
  if (/和/.test(t)) return "和";
  if (/洋|寝室|居室|ROOM|BR|BED/.test(t)) return "洋";
  return "?";
}

/** 間取り図の読み取りの部屋から居室の一番広い帖数（読めなければ null） */
export function roomJoFromImageRooms(rooms: ReadonlyArray<{ name?: string | null; jo?: number | null }> | null | undefined, madori?: string | null): number | null {
  const items: RoomJoItem[] = (rooms ?? [])
    .filter((r) => typeof r?.jo === "number" && Number.isFinite(r.jo as number))
    .map((r) => ({ kind: roomNameKind(r.name), jo: r.jo as number }))
    .filter((r) => ITEM_OK(r.kind, r.jo));
  return items.length ? mainRoomJo(items, madori) : null;
}

// ── 判定 ────────────────────────────────────────────────────────────────────

export type RoomJoResult = "ok" | "ng" | "unknown";
/** 目安（「7畳前後」）の時に許す幅（帖） */
export const ROOM_JO_APPROX_SLACK = 1;

/** 洋室の帖数の判定（純関数）。jo が読めなければ unknown。目安の希望は 1帖下まで ok */
export function judgeRoomJo(want: Pick<RoomJoWant, "jo" | "approx">, jo: number | null | undefined): RoomJoResult {
  if (jo == null || !Number.isFinite(jo)) return "unknown";
  const line = want.approx ? want.jo - ROOM_JO_APPROX_SLACK : want.jo;
  return jo + 1e-9 >= line ? "ok" : "ng";
}
