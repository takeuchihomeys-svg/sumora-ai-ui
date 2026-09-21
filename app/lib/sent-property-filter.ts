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

export type FilterResult = {
  /** 送る物の index（元の並びのまま） */
  keep: number[];
  /** 外した物 */
  dropped: Array<{ index: number; property: OutgoingProperty; reason: "url" | "room" }>;
  /** 鍵が無くて判断できなかった数（外していない） */
  unmatchable: number;
  /** URL が物件を区別できていなかったので URL を鍵にしなかった（号室だけで判断した） */
  urlUnusable: boolean;
};

/**
 * これから送る物から、既に送ってある物を外す。
 * ⚠ 同じ送信の中の重複も外す（実測では再送の37.5%が1日以内＝同じ回の重複が多い）。
 */
export function filterOutAlreadySent(outgoing: OutgoingProperty[], sent: SentProperty[]): FilterResult {
  const keep: number[] = [];
  const dropped: FilterResult["dropped"] = [];
  let unmatchable = 0;
  // URL が物件を区別できていない形だったら、URL は使わず号室だけで判断する
  const urlUnusable = !urlKeysAreDistinct(outgoing);
  const items = urlUnusable ? outgoing.map((p) => ({ ...p, url: null })) : outgoing;
  // 同じ送信の中で既に採った物も「送ったこと」にする（1回の送信に同じ部屋が2回入るのを防ぐ）
  const takenInThisRun: SentProperty[] = [];
  items.forEach((p, i) => {
    if (!p.propertyName.trim()) { keep.push(i); return; }
    if (!canMatch(p)) { unmatchable++; keep.push(i); return; }
    const hit = [...sent, ...takenInThisRun].find((s) => isSameOutgoing(p, s));
    if (hit) {
      dropped.push({ index: i, property: p, reason: normalizePropertyUrl(p.url) && normalizePropertyUrl(hit.property_url) ? "url" : "room" });
      return;
    }
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
  const names = dropped.map((d) => {
    const r = normalizeRoomNo(d.property.roomNo);
    return `${d.property.propertyName}${r ? ` ${r}号室` : ""}`;
  });
  const head = `（送付済みのため ${dropped.length}件を除きました）`;
  // 多い時は名前を全部は出さない（LINE が長くなる）
  return names.length <= 5 ? `${head}\n${names.join("・")}` : head;
}
