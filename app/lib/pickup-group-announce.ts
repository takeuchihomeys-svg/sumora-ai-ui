// app/lib/pickup-group-announce.ts（純関数・DB も LINE も触らない）
// ★物件出し★グループ（hanbancyo_settings.pickup_group_id）に「いつ・何を」送るかの決まり。
//
// 2026-09-27 竹内「売上番長のグループにアナウンスされるのは、AIX ツールで物件の解析が終わった時にする。その時アナウンス入れる形で、
//   PDF もここに添付しなくて大丈夫（ブレインの際）。ブレイン以外の状態なら今まで通りここのグループに共有する」
//   （「売上番長のグループ」＝スクショの「★物件出し★」＝ピックアップ用グループ pickup_group_id。本当の売上番長グループ group_id の
//    「AIX要対応」は触らない・2026-09-29 竹内さんに確認済み）
//
// 決まり:
//   - ブレイン（拡張の brainMode・スタッフモード以外・お客様が分かる回）: 検索のたびの本文＋結合 PDF のリンク（merge-pdfs）は送らない。
//     行（property_pickups.group_notice='deferred'）に印を付け、AIXツールの解析（まとめ＝自動の読み取り＋順位＋👑）が終わった時に
//     1回だけアナウンス（finishCompleteGroup → pickup-group-announce-server）。PDF は添付しない
//   - ブレイン以外（通常・スタッフモード・ブレインでもお客様が分からない回）: 今まで通り検索のたびに本文と PDF のリンク
//   - 同じまとめで二重に送らない: まとめに「アナウンスした行」（announced_item_ids）を残し、まだ知らせていない deferred の行がある時だけ送る
//     （まとめた後に同じ回の物件が遅れて届き、前のまとめに足された時だけ「追加分を含めて並べ直しました」で1回送る）
//   - 戻す時は環境変数 PICKUP_GROUP_DEFER=off（全部、今まで通り検索のたびに送る）
import { imageBonusOf, signedPoints } from "@/app/lib/pickup-image-bonus";
import { nameWithRoom } from "@/app/lib/pickup-listing-text";

// ── いつ送るか（merge-pdfs）──────────────────────────────────────────────

export type GroupNoticeInput = {
  /** 拡張が LINE に送る回か（send_to_line） */
  sendToLine: boolean;
  /** 拡張の 🧠 ブレイン（chrome.storage.local.brainMode） */
  brainMode: boolean | null | undefined;
  /** 拡張のスタッフモード（スタッフが自分で選んで送る） */
  staffMode: boolean | null | undefined;
  /** お客様（property_customer_id）が分かるか。分からない回は自動のまとめ（解析の完了）に乗らない */
  hasCustomer: boolean;
  /** 環境変数 PICKUP_GROUP_DEFER（"off" で今まで通り） */
  deferEnv?: string | null;
};

export type GroupNoticePlan = {
  /** 検索のたびに本文＋PDF のリンクを★物件出し★グループへ送る（今まで通り） */
  perSearch: boolean;
  /** 送らずに印を付け、解析が終わった時に1回アナウンスする */
  deferred: boolean;
  reason: "no_line" | "env_off" | "staff_mode" | "not_brain" | "no_customer" | "brain";
};

export function groupNoticePlan(i: GroupNoticeInput): GroupNoticePlan {
  if (!i.sendToLine) return { perSearch: false, deferred: false, reason: "no_line" };
  if (String(i.deferEnv ?? "").toLowerCase() === "off") return { perSearch: true, deferred: false, reason: "env_off" };
  if (i.staffMode === true) return { perSearch: true, deferred: false, reason: "staff_mode" };
  if (i.brainMode !== true) return { perSearch: true, deferred: false, reason: "not_brain" };
  // お客様が分からない回は売上サポの自動まとめ（解析の完了）に乗らない＝アナウンスが来ない → 今まで通り送る
  if (!i.hasCustomer) return { perSearch: true, deferred: false, reason: "no_customer" };
  return { perSearch: false, deferred: true, reason: "brain" };
}

/** 行に付ける印（property_pickups.group_notice） */
export const GROUP_NOTICE_DEFERRED = "deferred";

// ── 送るか（解析の完了・finishCompleteGroup）──────────────────────────────

export type AnnounceRowFlag = { id: number; group_notice?: string | null };

export type AnnouncePlan = {
  send: boolean;
  /** 前に一度アナウンスしたまとめに、追加の行が足された（「追加分を含めて並べ直しました」） */
  update: boolean;
  /** 今回はじめて知らせる deferred の行 */
  newIds: number[];
  /** 送った後に残す「アナウンスした行」（前の分＋今回） */
  announcedAfter: number[];
};

/**
 * まとめの行（group_notice 付き）と、前にアナウンスした行から、今回送るかを決める。
 *   deferred の行が1つも無いまとめ（ブレイン以外・デプロイ前の行・スタッフモードの回だけ）は送らない＝検索のたびに送ってある
 */
export function announcePlan(rows: ReadonlyArray<AnnounceRowFlag>, announced: ReadonlyArray<number> | null | undefined): AnnouncePlan {
  const before = new Set((announced ?? []).filter((n) => Number.isFinite(n)));
  const deferred = rows.filter((r) => r.group_notice === GROUP_NOTICE_DEFERRED).map((r) => r.id);
  const newIds = deferred.filter((id) => !before.has(id)).sort((a, z) => a - z);
  const announcedAfter = [...new Set([...before, ...deferred])].sort((a, z) => a - z);
  return { send: newIds.length > 0, update: newIds.length > 0 && before.size > 0, newIds, announcedAfter };
}

// ── 何を送るか ────────────────────────────────────────────────────────

export type AnnounceItem = {
  id: number;
  verdict?: string | null;
  status?: string | null;
  score?: number | null;
  reason_codes?: string[] | null;
  image_analysis?: { [k: string]: unknown } | null;
  summary_text?: string | null;
  property_name?: string | null;
  room_no?: string | null;
};

export type AnnounceInput = {
  customerName: string | null;
  /** まとめたサイトごとの件数（{realpro: 20, itandi: 12}） */
  sites: Record<string, number>;
  /** まとめの順位の並び（rankCompleteGroup の order と同じ順） */
  items: ReadonlyArray<AnnounceItem>;
  /** 👑（まとめの best_id）。無ければ null */
  bestId: number | null;
  /** AIXツールのそのお客様・その回（絶対 URL）。無ければ出さない */
  link: string | null;
  update?: boolean;
  /** 解析が途中で止まった（status=error）。並びは付いていない */
  stopped?: boolean;
  /** 上位に並べる件数（👑 を除く） */
  topN?: number;
  /** 2026-09-29 見張り（screen-watch）: この回の検索の注意（「⚠ 条件が入り切っていない検索（東三国が入っていない）」）。件数の行の後に1行ずつ */
  watchNotes?: ReadonlyArray<string>;
};

const SITE_LABEL: Record<string, string> = { realpro: "リアプロ", realnetpro: "リアプロ", itandi: "itandi", reins: "レインズ" };
const LINE = "━━━━━━━━━━━━━━";
/** LINE のテキストの上限（5,000字）より十分小さく */
const MAX_CHARS = 4500;

export function siteLabelJa(sites: Record<string, number>): string {
  return Object.entries(sites ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${SITE_LABEL[k] ?? k} ${n}`).join("・");
}

/** 説明文の頭の【2🌟★】を外す（🌟 は拡張の送った時点の印で、解析後の並びとは違うので出さない） */
function stripHead(line: string): string {
  return line.replace(/^【[^】]*】\s*/u, "").trim();
}

/** 1件の説明（1行目＝物件名 号室・2行目以降＝説明文の残り）。説明文が無ければ物件名＋号室 */
function itemLines(it: AnnounceItem): string[] {
  const s = String(it.summary_text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  if (s.length) return [stripHead(s[0]) || nameWithRoom(it.property_name, it.room_no), ...s.slice(1)];
  const n = nameWithRoom(it.property_name, it.room_no);
  return n ? [n] : [];
}

/** 点の書き方（売上サポの札と同じ数）: 画像を足した時「合計 167点・判定 163・画像 +4」（short は「合計 167点」）／それ以外「163点」 */
export function announcePoints(it: AnnounceItem, opts?: { short?: boolean }): string {
  if (typeof it.score !== "number" || !Number.isFinite(it.score)) return "";
  const b = imageBonusOf({ reason_codes: it.reason_codes ?? null, image_analysis: it.image_analysis as never });
  if (!b) return `${it.score}点`;
  if (opts?.short) return `合計 ${it.score + b.points}点`;
  return `合計 ${it.score + b.points}点・判定 ${it.score}・画像 ${signedPoints(b.points)}`;
}

const VERDICT_JA: Record<string, string> = { hold: "保留", drop: "外す候補" };
const isOpen = (it: AnnounceItem) => !it.status || it.status === "pending";

/**
 * アナウンスの本文。形は今までの「〇〇さん 物件（リアプロ）／一番オススメ／一覧」に合わせ、
 *   一番オススメ＝解析後の 👑・並び＝まとめの順位（合計の点）・PDF のリンクの代わりに AIXツールのリンク
 */
export function buildAnnouncement(i: AnnounceInput): string {
  const topN = i.topN ?? 5;
  const name = i.customerName ? (i.customerName.endsWith("さん") ? i.customerName : `${i.customerName}さん`) : "";
  const siteText = siteLabelJa(i.sites);
  const lines: string[] = [];
  lines.push(i.stopped ? "⚠ AIXツールの解析が途中で止まりました" : i.update ? "🧠 AIXツールの解析が終わりました（追加分を含めて並べ直しました）" : "🧠 AIXツールの解析が終わりました");
  lines.push(`${name ? `${name} ` : ""}物件${siteText ? `（${siteText}）` : ""}`);

  const counts = { pass: 0, hold: 0, drop: 0 };
  for (const it of i.items) if (it.verdict === "pass" || it.verdict === "hold" || it.verdict === "drop") counts[it.verdict]++;

  if (!i.stopped) {
    const best = i.bestId != null ? i.items.find((it) => it.id === i.bestId) ?? null : null;
    if (best) {
      lines.push(LINE);
      const pts = announcePoints(best);
      lines.push(`👑 一番オススメ${pts ? `（${pts}）` : ""}`);
      lines.push(...itemLines(best));
    }
    // 上位（👑 を除く・外す候補と送信済み・見送りは出さない）
    const rest = i.items.filter((it) => it.id !== i.bestId && it.verdict !== "drop" && isOpen(it)).slice(0, topN);
    if (rest.length) {
      lines.push(LINE);
      rest.forEach((it, k) => {
        const [head, ...tail] = itemLines(it);
        const pts = announcePoints(it, { short: true });
        const note = [pts, it.verdict ? VERDICT_JA[it.verdict] ?? "" : ""].filter(Boolean).join("・");
        lines.push(`【${k + (best ? 2 : 1)}】${head ?? ""}${note ? `（${note}）` : ""}`);
        tail.forEach((l) => lines.push(l));
        lines.push("");
      });
      if (lines[lines.length - 1] === "") lines.pop();
    }
  }
  lines.push(LINE);
  const cnt = [`通す ${counts.pass}`, counts.hold ? `保留 ${counts.hold}` : "", counts.drop ? `外す候補 ${counts.drop}` : ""].filter(Boolean).join("・");
  lines.push(`全${i.items.length}件（${cnt}）`);
  for (const n of (i.watchNotes ?? []).slice(0, 3)) if (n) lines.push(n);
  if (i.link) {
    lines.push("▶ AIXツールで見る");
    lines.push(i.link);
  }
  let text = lines.join("\n");
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS - 1) + "…";
  return text;
}

/** AIXツールのそのお客様・その回（新着物件カードと同じ /conditions?pickup=&batch=）。batch＝まとめの一番古い回 */
export function announceLink(baseUrl: string, propertyCustomerId: string | null, firstBatchId: string | null): string | null {
  if (!propertyCustomerId) return null;
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const q = `pickup=${encodeURIComponent(propertyCustomerId)}${firstBatchId ? `&batch=${encodeURIComponent(firstBatchId)}` : ""}`;
  return `${base}/conditions?${q}`;
}
