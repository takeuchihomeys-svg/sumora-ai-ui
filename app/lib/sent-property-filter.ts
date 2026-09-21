// app/lib/sent-property-filter.ts
// 「一度お客様に送った物件は次から外す」（純関数・DB 依存なし）。
//
// 2026-09-21 竹内「拡張ツールで物件出した事あるのは出さないようにできるか？
//   物件一括で検索して送るAIXボタン押した／11:00と17:00の部分も
//   一度共有した物件を除いてLINEに送ることが出来ればかなり質高くなる。
//   何度も同じ物件がLINEグループに送られると、一度見た物件をまたみる必要があったりするので効率が悪い」
//
// ■ 困りごとは実測で確かめた（scripts/audit-room-identity.ts・直近60日・物件19,209件）
//   **一度送った物件をまた送っているのは 6,863件（35.7%）**。
//   送り直すまでの間隔は 1〜3日 25.8% ／ 3〜7日 13.9% ／ 1〜2週 18.9% と、日をまたいで繰り返している。
//
// ■ ⚠ いちばん大事な線: **誤って外さない**
//   外すのは出口の削除なので、設計知見「出口は誤削除0でなければ入れない」が効く。
//   送るべき物件が送られないのは、同じ物件が2回届くよりずっと重い。
//   実測（scripts/audit-summary-room.ts・物件20,716件）:
//     ・送っている物件名に**号室が入っているのは 0.1%**（12件）
//     ・1回の送信の **74.2%** に「同じ建物名が2件以上」入っている（＝別の部屋を同時に送っている）
//     ・同じ建物名のまとまりの **98.0%** は家賃・間取りでも見分けられない（家賃は 0.1% しか無い）
//   → **名前だけで外すと、74.2% の送信で別の部屋まで消える**。だから:
//
//     見分けられる鍵がある時だけ外す。無ければ外さない。
//       ① 物件の URL が一致 → 同じ物件（いちばん確実）
//       ② 号室が両方にあり、名前が DUP_MIN_SCORE 以上で号室も一致 → 同じ物件
//       ③ どちらも無い → **外さない**（同じ建物の別部屋かもしれない）
//
// ■ 四者同名
//   物件名の突き合わせは sent-property-record.isSameProperty（実測で 0.95 と決めた線）をそのまま使う。
//   ここで別の線を作らない。
import { isSameProperty, normalizeRoomNo, type ExistingProperty } from "./sent-property-record";
import { normalizePropertyName, similarity } from "./property-name-match";

/** これから送る1件（並びは pdf_urls / property_summaries と同じ index） */
export type OutgoingProperty = {
  /** 物件の URL（リアプロの印刷用PDFなど）。無ければ null */
  url?: string | null;
  propertyName: string;
  roomNo?: string | null;
};

/** 既に送ってある1件 */
export type SentProperty = ExistingProperty & { property_url?: string | null };

/**
 * PDF の URL から、物件を見分ける形を作る。
 *
 * ⚠ 同じ物件でも毎回変わる部分（セッションのトークン・時刻・連番）が付くことがあるので、
 *   **クエリ文字列を落として path だけ**にする。落としても物件が変わらないことは
 *   scripts/audit-sent-prop-url.ts で確かめる（同じ物件名に path が何種類あるかを数える）。
 * ⚠ 一時置き場（Vercel Blob）の URL は送るたびに変わるので**鍵にしない**。
 *   itandi・レインズ経路はここを通らず、号室での判定にまかせる。
 */
export function normalizePropertyUrl(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  let u: URL;
  try { u = new URL(s); } catch { return ""; }
  const host = u.hostname.toLowerCase();
  // 一時置き場は送るたびに別の URL になるので鍵にならない
  if (host.endsWith("vercel-storage.com")) return "";
  return `${host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
}

/** その物件を「前に送った物」と突き合わせられるか（＝外してよいか判断できるか） */
export function canMatch(p: OutgoingProperty): boolean {
  return !!normalizePropertyUrl(p.url) || !!normalizeRoomNo(p.roomNo);
}

/**
 * 同じ物件か。
 * ① URL が両方にあって一致 → 同じ
 * ② 号室が両方にあり、名前が近くて号室も一致 → 同じ（isSameProperty に任せる）
 * ③ それ以外 → **違う物として扱う**（外さない）
 */
export function isSameOutgoing(out: OutgoingProperty, sent: SentProperty): boolean {
  const ou = normalizePropertyUrl(out.url);
  const su = normalizePropertyUrl(sent.property_url);
  if (ou && su) return ou === su;
  const or = normalizeRoomNo(out.roomNo);
  const sr = normalizeRoomNo(sent.room_no);
  if (!or || !sr) return false;   // 号室が片方でも無ければ判断しない（別部屋を消さない）
  // ⚠ 名前が「物件」等（読み取れなかった既定値）の時は、号室が一致しても別の建物の同じ号室かもしれない
  if (!isUsablePropertyName(out.propertyName) || !isUsablePropertyName(sent.property_name)) return false;
  return isSameProperty({ property_name: out.propertyName, room_no: or }, { property_name: sent.property_name, room_no: sr });
}

/**
 * その送信の URL が、物件を1件ずつ区別できているか。
 *
 * ⚠ これは**自分を守るための確認**。リアプロの印刷用PDFの URL が
 *   「path は同じでクエリで物件を指す」形だった場合、normalizePropertyUrl は
 *   全部同じ鍵になり、**2件目以降が全部「送付済み」と判定されて消える**。
 *   1回の送信の中で鍵がぶつかっているなら、その URL は物件を指していないので使わない。
 *   （実物の URL を見られないまま入れるので、形が違っても壊れないようにしておく）
 */
export function urlKeysAreDistinct(outgoing: OutgoingProperty[]): boolean {
  const keys = outgoing.map((p) => normalizePropertyUrl(p.url)).filter(Boolean);
  if (keys.length <= 1) return true;
  // ⚠ 線は「ユニークな鍵が1つだけか」。
  //   最初は「1つでもぶつかったら使わない」にしたが、それだと**同じ物件が2回入っている送信**
  //   （外したい当のケース）まで止まってしまった。
  //   ・全部が同じ鍵（ユニーク1）＝ URL が物件を指していない → 使わない
  //   ・一部だけ同じ（ユニーク2以上）＝ 同じ物件が2回入っている → 使って外す
  //   2件で両方同じ時は区別が付かないが、ユニーク1なので**外さない側**に倒れる（誤除外0を優先）。
  return new Set(keys).size > 1;
}

// ─────────────────────────────────────────────────────────────
// 建物（マンション）ごとに外す（2026-09-21 竹内さんの選択）
//
// 竹内「これで一度グループに送った物件（マンションごと）は送られんようになってるかな？」
//   → 単位は**マンションごと**／1回の送信の中の同じマンションは**全部残す**、と決まった。
//
// ■ ⚠ 名前だけで比べる時にいちばん危ないのは「〇〇Ⅱ」「〇〇Ⅲ」＝**別の建物**
//   similarity は2文字のかたまりの**集合**で測るので、繰り返しの長さの違いが消える:
//     「マスタズレジデンス道頓堀ii」 ↔ 「マスタズレジデンス道頓堀iii」 = **1.000**
//   （どちらも "ii" という組を1つ持つだけなので集合が同じになる）
//   実測（scripts/audit-building-name-threshold.ts・建物名3,409種類）で 0.95 以上のペア9組のうち
//   **7組がこの形**だった（〜i ↔ 〜ii ／ 〜west ↔ 〜westⅱ など）。
//   → 末尾の棟・号館の表記を**別に取り出して、違えば別の建物**にする。
// ─────────────────────────────────────────────────────────────

/**
 * 建物名の末尾にある「棟・号館」の表記。無ければ ""。
 *
 * ⚠ ここは**多めに拾ってよい**。拾いすぎると「別の建物」と見なして外さなくなるだけで、
 *   誤って外す側には倒れない（安全側）。
 */
export function buildingWing(normalizedName: string): string {
  const m = normalizedName.match(/(?:[ⅰ-ⅻ]+|i{1,3}|iv|vi{0,3}|ix|xi{0,2}|[vx]|\d+)(?:番館|号棟|号館|棟|館)?$/);
  return m ? m[0] : "";
}

/**
 * 物件を指していない名前。**建物の判定に使ってはいけない**。
 *
 * ⚠ 2026-09-21 竹内「ちゃんと物件を読み取ることできてるんかな？」で見つけた:
 *   拡張は検索結果から名前を取れなかった時に既定値「物件」を入れる。実測で **239件（1.1%）**。
 *   建物ごとに外す作りでは、この「物件」同士が名前一致で**同じマンション扱い**になり、
 *   名前を読めなかった物件が互いを消し合う（読み取りに失敗しただけの物件が送られなくなる）。
 *   画面の文字が混ざった名前（「設備・詳細」など 18件）も同じ。
 */
const UNUSABLE_NAMES: ReadonlySet<string> = new Set(["物件", "設備・詳細", "詳細", "お気に入り", "印刷用pdf", "図面", "-", "ー", "―"]);

/** その名前を建物の判定に使ってよいか。使えない名前は**外さない側**に倒す */
export function isUsablePropertyName(name: string | null | undefined): boolean {
  const t = (name ?? "").trim();
  if (!t) return false;
  if (UNUSABLE_NAMES.has(t.toLowerCase())) return false;
  // 数字・金額だけ（「58,000円」が名前になってしまった行）
  if (/^[\d\s,，.円万¥]+$/.test(t)) return false;
  // 正規化して1文字以下になる物は名前として短すぎる
  return normalizePropertyName(t).length >= 2;
}

/** 建物として同じか。棟の表記が違えば別の建物。名前の近さは BUILDING_MIN_SCORE で見る */
export function isSameBuilding(a: string, b: string): boolean {
  if (!isUsablePropertyName(a) || !isUsablePropertyName(b)) return false;
  const an = normalizePropertyName(a), bn = normalizePropertyName(b);
  if (!an || !bn) return false;
  if (buildingWing(an) !== buildingWing(bn)) return false;
  return similarity(an, bn) >= BUILDING_MIN_SCORE;
}

/**
 * 建物として同じと言ってよい名前の近さ。
 *
 * 実測（scripts/audit-building-name-threshold.ts・直近60日に送った建物名 3,409種類）。
 * 棟の表記を分けた後、「別名なのに似ているペア」を線ごとに数えた:
 *   0.90 → 11組 ／ 0.95 → 1組 ／ **0.96 → 0組** ／ 0.97 → 0組
 *   0.95 で残る1組は「ブエナビスタ難波サウスタワー」↔「ブエナビスタ難波サウス」＝ 別の建物。
 * 巻き込みが0になる 0.96 より1つ内側の **0.97** を採る（余裕を持たせる）。
 * ⚠ 号室と組で使う DUP_MIN_SCORE（0.95）とは別の線。名前だけで判断する分、こちらは厳しくする。
 */
export const BUILDING_MIN_SCORE = 0.97;

/**
 * 外す単位。
 *  building … 一度送ったマンションは、別の部屋でも送らない（2026-09-21 竹内さんの選択）
 *  room     … 同じ部屋だけ外す（建物が同じでも部屋が違えば送る）
 */
export type SkipLevel = "building" | "room";

export type FilterResult = {
  /** 送る物の index（元の並びのまま） */
  keep: number[];
  /** 外した物 */
  dropped: Array<{ index: number; property: OutgoingProperty; reason: "url" | "room" | "building" }>;
  /** 鍵が無くて判断できなかった数（外していない） */
  unmatchable: number;
  /** URL が物件を区別できていなかったので URL を鍵にしなかった（号室だけで判断した） */
  urlUnusable: boolean;
};

/**
 * これから送る物から、既に送ってある物を外す。
 *
 * ⚠ **過去の送信**と**同じ回の中**で線を変える（2026-09-21 竹内さんの選択）:
 *   ・過去に送った分 … building なら**マンションごと**に外す（別の部屋でも送らない）
 *   ・同じ回の中     … **部屋単位でしか外さない**。1回の提案で同じマンションの複数の部屋を
 *                      見せるのは普通の運用（実測で送信の17.2%）なので、ここで消すと提案が痩せる。
 */
export function filterOutAlreadySent(
  outgoing: OutgoingProperty[],
  sent: SentProperty[],
  level: SkipLevel = "building",
): FilterResult {
  const keep: number[] = [];
  const dropped: FilterResult["dropped"] = [];
  let unmatchable = 0;
  // URL が物件を区別できていない形だったら、URL は使わず号室・建物名で判断する
  const urlUnusable = !urlKeysAreDistinct(outgoing);
  const items = urlUnusable ? outgoing.map((p) => ({ ...p, url: null })) : outgoing;
  // 同じ送信の中で既に採った物（ここは部屋単位でしか見ない）
  const takenInThisRun: SentProperty[] = [];
  items.forEach((p, i) => {
    if (!p.propertyName.trim()) { keep.push(i); return; }
    // 同じ回の中の重複（同じ部屋が2回入っている）は外す
    const runHit = takenInThisRun.find((s) => isSameOutgoing(p, s));
    if (runHit) {
      dropped.push({ index: i, property: p, reason: normalizePropertyUrl(p.url) ? "url" : "room" });
      return;
    }
    // 過去に送った分
    const pastHit = sent.find((s) => isSameOutgoing(p, s));
    const buildingHit = level === "building" && !pastHit
      ? sent.find((s) => isSameBuilding(p.propertyName, s.property_name))
      : undefined;
    if (pastHit) {
      dropped.push({ index: i, property: p, reason: normalizePropertyUrl(p.url) && normalizePropertyUrl(pastHit.property_url) ? "url" : "room" });
      return;
    }
    if (buildingHit) {
      dropped.push({ index: i, property: p, reason: "building" });
      return;
    }
    // room モードでは、鍵が無い物は判断できないので数えておく（building では名前で判断できる）
    if (level === "room" && !canMatch(p)) unmatchable++;
    keep.push(i);
    takenInThisRun.push({ property_name: p.propertyName, room_no: normalizeRoomNo(p.roomNo), property_url: p.url ?? null });
  });
  return { keep, dropped, unmatchable, urlUnusable };
}

/**
 * 【1】【2】… の番号を 1 から詰め直す。
 * ⚠ 外した分だけ番号が飛ぶと、PDF の並びと説明文の番号が食い違って見える
 *   （拡張側も同じ理由で prepareItems が rank を詰め直している）。
 * 🌟 / 🌟★ の印はこの後 merge-pdfs がやり直すので、ここでは落とす。
 */
export function renumberSummaries(summaries: string[]): string[] {
  return summaries.map((s, i) => {
    const lines = String(s ?? "").split("\n");
    lines[0] = lines[0].replace(SUMMARY_NO_RE, `【${i + 1}】`);
    return lines.join("\n");
  });
}

/**
 * 説明文の先頭の番号。
 *
 * ⚠ **u フラグが要る**。🌟 は2つのコードユニットでできているので、`u` 無しの `🌟?` は
 *   「前半は必須・後半は任意」という意味になり、**🌟 が付いていない「【1】」に当たらない**
 *   （設計知見「🌟 はサロゲートペアなので、文字クラスに入れるなら u フラグが要る」）。
 *   merge-pdfs の記録側も同じ形を使っていて、🌟 の付かない物件の名前が
 *   「【1】心斎橋SPOT21」のまま保存されていた（2026-09-21 に一緒に直した）。
 */
export const SUMMARY_NO_RE = /^【\s*\d+\s*(?:🌟)?(?:★)?\s*】/u;

/** 説明文の1行目から物件名と号室を取り出す（merge-pdfs の記録と同じ形＝四者同名） */
export function parseSummaryHead(summary: string): { propertyName: string; roomNo: string } | null {
  const firstLine = String(summary ?? "").split("\n")[0].replace(SUMMARY_NO_RE, "").trim();
  if (!firstLine) return null;
  const roomMatch = firstLine.match(/[\s　]+(\d{1,4})(?:号室?)?$/);
  const roomNo = roomMatch ? normalizeRoomNo(roomMatch[1]) : "";
  const propertyName = roomMatch ? firstLine.slice(0, roomMatch.index ?? 0).trim() : firstLine;
  if (!propertyName) return null;
  return { propertyName, roomNo };
}

/** スタッフに見せる一文（LINE の末尾に添える）。外した物が無ければ空文字 */
export function buildExcludedNotice(dropped: FilterResult["dropped"]): string {
  if (dropped.length === 0) return "";
  const names = [...new Set(dropped.map((d) => {
    // 建物ごとに外した物は建物名だけで出す（号室を出すと「その部屋だけ」に見える）
    if (d.reason === "building") return d.property.propertyName;
    const r = normalizeRoomNo(d.property.roomNo);
    return `${d.property.propertyName}${r ? ` ${r}号室` : ""}`;
  }))];
  const head = `（送付済みのため ${dropped.length}件を除きました）`;
  // 多い時は名前を全部は出さない（LINE が長くなる）
  return names.length <= 5 ? `${head}\n${names.join("・")}` : head;
}
