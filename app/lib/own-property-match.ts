// app/lib/own-property-match.ts
// お客様が送ってきた物件（スクショ・共有文）が、**こちらが前に送った物件と同じか**を判定する（純関数・DB 依存なし）。
//
// 2026-09-22 竹内（𝓡さん事例）「この3件はこちらがお客さんに送った物件を、お客さんが気に入ったから送ってくれた形。
//   こっちが送った物件をお客さんが送ってくることもある。物件名や画像を見たらちゃんと判断できるようにする」
//
// 実物: 9/19 こちらが6件・9/20 に3件を物件資料の画像で送付 → 9/22 お客様が3件のスクショ
//   ＋「この三つの物件良さそうですが、もう少し見てみたいので、送っていただきたいです」
//   → 下書き「お送り頂きました3件の募集状況確認させて頂きます！！」（お客様が見つけた新しい物件として扱った）
//   → 実送信「ご査収いただきありがとうございます😌！！かしこまりました！！引き続き新着物件を…お送りさせて頂きます！！」
//   ＝ スタッフは「こちらの提案を気に入ってくれた・似た物件をもっと見たい」と読んでいる。
// 【原因】お客様が物件を送ってきた時に、それがこちらの送った物件かを照らし合わせる所が**どこにも無かった**。
//   全部「お客様が見つけた物件」扱いで、物件確認（募集状況の確認）の文になっていた。
//
// 判定: 物件名の近さ（property-name-match と同じ線 0.7）＋号室。
//   同じ名前・同じ号室（または片方に号室が無い）→ same_room ／ 同じ名前・違う号室 → same_building ／ それ以外 → none
//   ⚠ 読み取りは誤読するので**名前が近くない物は「分からない」**（違うとは言わない）。
import { matchKnownProperty, MATCH_MIN_SCORE } from "./property-name-match";

export type ScreenshotProperty = { name: string; room: string | null };

/** 号室の表記ゆれ（0507 と 507・「号室」付き）を揃える */
export function normalizeRoom(room: string | null | undefined): string | null {
  const r = (room ?? "").normalize("NFKC").replace(/号室?/g, "").replace(/\s/g, "").replace(/^0+(?=\d)/, "");
  return /^\d{2,4}[A-Za-z]?$/.test(r) ? r.toUpperCase() : null;
}

const IMAGE_HEAD_RE = /^\s*\[画像\]\s*/;
/** 画像の種類のラベル（Vision が先頭に付ける事がある） */
const TYPE_LABEL_RE = /^(?:floor_plan|property_photo|estimate|id_document|other|screenshot)\s*$/i;

/**
 * お客様が送ったスクショの読み取り文（"[画像] …"）から物件名・号室を取り出す。
 * 実物の形（9/22 𝓡さん）:
 *   A「[画像] ラクラス阿倍野元町 0507 6.4万円（省なし）…」         → 1行目: 名前＋号室
 *   B「[画像] floor_plan / 物件種目：… / 物件名：〇〇 / 号室：1202（12階部分）」→ 物件名：／号室：
 *   C「[画像] エステムコート難波サウスプレイスVIリリアン 201 号室 / 【所在地】…」→ 1行目: 名前＋号室
 * 物件の資料らしくない画像（見積書・身分証・チャットのスクショ）は取り出さない（null）。
 */
export function extractScreenshotProperty(text: string | null | undefined): ScreenshotProperty | null {
  const t = (text ?? "").normalize("NFKC");
  if (!IMAGE_HEAD_RE.test(t)) return null;
  const lines = t.replace(IMAGE_HEAD_RE, "").split(/\n|\s\/\s/).map((l) => l.replace(/\*+/g, "").trim()).filter(Boolean);
  // B: 「物件名：」「号室：」
  const nameLine = lines.find((l) => /^物件名\s*[:：]/.test(l));
  if (nameLine) {
    const name = nameLine.replace(/^物件名\s*[:：]\s*/, "").trim();
    const roomLine = lines.find((l) => /^(?:号室|部屋番号|号室名)\s*[:：]/.test(l));
    const room = roomLine ? normalizeRoom((roomLine.replace(/^[^:：]+[:：]\s*/, "").match(/[0-9]{2,4}[A-Za-z]?/) ?? [])[0]) : null;
    return name.length >= 2 ? { name, room } : null;
  }
  // A / C: 1行目（種類のラベルは飛ばす）の「名前 号室」
  const first = lines.find((l) => !TYPE_LABEL_RE.test(l)) ?? "";
  const m = first.match(/^(.{2,40}?)\s+([0-9]{2,4}[A-Za-z]?)\s*(?:号室|号)?(?:\s|$|[0-9.]+万)/);
  if (!m) return null;
  const name = m[1].trim();
  // 住所・駅・金額から始まる行は物件名ではない
  if (/^(?:大阪|東京|京都|兵庫|〒|【|賃料|家賃|所在地|交通)/.test(name) || /[0-9.]+万円/.test(name)) return null;
  return { name, room: normalizeRoom(m[2]) };
}

const ROMAN_FULL: Record<string, string> = { "Ⅰ": "i", "Ⅱ": "ii", "Ⅲ": "iii", "Ⅳ": "iv", "Ⅴ": "v", "Ⅵ": "vi", "Ⅶ": "vii", "Ⅷ": "viii", "Ⅸ": "ix", "Ⅹ": "x", "Ⅺ": "xi", "Ⅻ": "xii" };

/**
 * 名前の中のシリーズ番号（ローマ数字・数字）。**途中にあっても拾う**。
 * 2026-09-22 実測の誤照合: 「エステムコート難波サウスプレイス**VIII**ハイド」↔「…サウスプレイス**VI**レジダー」を
 *   名前の近さ（0.7以上）だけで同じ物件にしていた。棟の判定（sent-property-filter の buildingWing）は
 *   **末尾**の番号しか見ないので、途中の番号の違いが素通りした。
 */
export function seriesTokens(name: string): string {
  const t = name.normalize("NFKC").replace(/[Ⅰ-Ⅻ]/g, (c) => ROMAN_FULL[c] ?? c).toLowerCase();
  const romans = t.match(/(?<![a-z])(?:x{0,3})(?:ix|iv|v?i{1,3}|v)(?![a-z])/g) ?? [];
  const digits = t.match(/\d+/g) ?? [];
  return [...romans, ...digits].join(",");
}

export type SentProperty = { name: string; room: string | null; sentAt: string | null };
export type OwnMatch = { kind: "same_room" | "same_building" | "none"; sent: SentProperty | null; score: number };

/** お客様の1件 × こちらが送った物件の一覧 → 同じか */
export function matchOwnProperty(item: ScreenshotProperty, sent: ReadonlyArray<SentProperty>): OwnMatch {
  const byName = new Map<string, SentProperty[]>();
  for (const s of sent) { const a = byName.get(s.name) ?? []; a.push(s); byName.set(s.name, a); }
  const hit = matchKnownProperty(item.name, [...byName.keys()], MATCH_MIN_SCORE);
  if (!hit) return { kind: "none", sent: null, score: 0 };
  // シリーズ番号（Ⅱ・VIII・2）が違えば別の建物。片方にだけある時も「分からない」に倒す（誤って同じと言わない）
  if (seriesTokens(item.name) !== seriesTokens(hit.name)) return { kind: "none", sent: null, score: hit.score };
  const cands = byName.get(hit.name) ?? [];
  const room = normalizeRoom(item.room);
  const sameRoom = cands.find((c) => !room || !normalizeRoom(c.room) || normalizeRoom(c.room) === room);
  if (sameRoom) return { kind: "same_room", sent: sameRoom, score: hit.score };
  return { kind: "same_building", sent: cands[cands.length - 1] ?? null, score: hit.score };
}

/**
 * 生成に渡す「お客様が送ってきた物件のうち、こちらが送った物件」の説明。
 * こちらが送った物件が1件も無ければ空（今までどおりお客様が見つけた物件として扱う）。
 */
export function buildOwnPropertyNote(results: ReadonlyArray<{ item: ScreenshotProperty; match: OwnMatch }>): string {
  const ours = results.filter((r) => r.match.kind === "same_room");
  if (ours.length === 0) return "";
  const unknown = results.length - ours.length;
  const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "");
  const list = ours.map((r) => `・${r.match.sent!.name}${r.match.sent!.room ? ` ${normalizeRoom(r.match.sent!.room)}号室` : ""}（こちらが${md(r.match.sent!.sentAt)}に送った物件）`).join("\n");
  const all = unknown === 0;
  return `【🏠 お客様が送ってきた物件は、こちらが前に送った物件${all ? "" : "を含む"}（確定事実・記録で照合済み）】
${list}${all ? "" : `\n（残り${unknown}件はこちらの記録に無い）`}
→ ${all ? "お客様が新しく見つけた物件ではない。" : ""}こちらの提案をお客様が見て、気に入って送り返してくれた形。
→ こちらが送った物件を「お送り頂きました物件」と呼ばない。送った時に確認している物件の「募集状況確認させて頂きます」の宣言もしない
  （実送信: この場面でスタッフが募集状況確認を宣言したのは 0/9回）。
→ お客様の言っている事（気に入った・もっと見たい・内覧したい・費用を知りたい 等）にそのまま答える。
→ 照合した事そのもの（どれがこちらの送った物件か）はスタッフ向けの事実。本文には書かない。`;
  // 2026-09-22 YUMA 再現: 照合の結果を本文にそのまま書いた（1/3回）ので最後の1行を足した。
  //   言い回しを引用して禁止すると写すので、形（照合の事実は本文に書かない）で伝える
  // ⚠ 「ご査収頂きありがとうございます」から入るのは実送信 1/9回なので必須にしない
  //   （設計知見「必須にしてよいのは過半数が守っている形だけ」）
}
