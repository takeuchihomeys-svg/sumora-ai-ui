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
  equipment?: { roomFloor?: number | null; totalFloors?: number | null; basement?: boolean | null } | null;
};

export type CardCell = { key: string; head: string; value: string; sub: string | null };
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
  const cells: CardCell[] = [
    { key: "room", head: "部屋/階", ...pair(room, floor) },
    { key: "state", head: "状態/入居", ...pair(stateLabel(t, lines), moveInShort(t, lines)) },
    { key: "madori", head: "間取り/㎡", ...pair(madori, sqm) },
    { key: "rent", head: "賃料/管理費", ...pair(s.rent, s.admin) },
    { key: "deposit", head: "敷金/礼金", ...pair(monthsLabel(t?.deposit), monthsLabel(t?.keyMoney)) },
    { key: "guarantee", head: "保証金/償却", ...pair(monthsLabel(t?.guaranteeDeposit), amortLabel(t?.evidence?.amortization)) },
    { key: "ad", head: "AD", value: ad ?? DASH, sub: null },
    { key: "built", head: "築年/階建", ...pair(age, total) },
    { key: "score", head: "点数", value: mark.score != null ? `${mark.score}点` : DASH, sub: mark.label },
  ];
  return { name, room, address: row.location?.ward ?? null, access, building, mark, cells, headline: cardHeadline(row) };
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

/** まとめの回の物件を1つの並びに（🌟★ → 🌟 → 点の高い順。同じ回の中の並びと同じ規則） */
export function mergeRoundItems<T extends ReviewOrderRow>(batches: ReadonlyArray<{ items: ReadonlyArray<T> }>): T[] {
  return sortForReview(batches.flatMap((b) => b.items));
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
