// app/lib/line-search-knowledge.ts（純関数・DB 依存なし・LLM なし）
// 過去の LINE（messages）から物件検索の知識を抜き出す（手順6）。
//
// 2026-10-02 竹内「こんなのも過去のLINEの内容をちゃんとみたら知識つけられるので設計知見と協力しておこなう。また他の区域でも探したい
//   お客さんにたいしても最善の提案が出来るようになるなど、物件検索のブレインに必要な部分も強化する」
// ■ 抜き出す物（決定論・既存の読み方をそのまま使う＝検索・採点と同じ値）
//   anchor_usage: お客様の発言の「◯◯に出やすい」（readRelativeArea）・「◯◯まで1本／乗り換えなし」（readRideAsks）・
//     「◯◯まで N 分」（COMMUTE の読み）・「◯◯の近く／周辺」を、起点の駅（まとまりの代表）ごとに人数で数える
//   staff_phrase: スタッフの送った文のうち、相場の説明・条件を広げる提案・築年/構造/広さの理由の説明・駅までの所要の説明の1文。
//     お客様の呼びかけ（「◯◯さん」）は「〇〇さん」に・電話番号は消す。物件の名前・数字は残す（説明の型の見本＝新しい文は作らない）
// ■ DeepSeek は使わない（種類分けは語の形で足りる・費用0）
import { readRelativeArea, readRideAsks } from "./osaka-area-profile";
import { stationsInText, normStation } from "./osaka-geo";

export type MsgLite = { conversation_id: string; sender: string; text: string | null };

/** 「◯◯まで N 分」（電車の分。徒歩・車・自転車は除く） */
const MIN_PHRASE_RE = /([^\s、,・/／()（）。]{1,12}?)(?:駅)?\s*(?:まで|から|へ)\s*(?:電車|地下鉄|JR)?\s*(?:で)?\s*(?:約)?([0-9]{1,3})\s*分/g;
const NOT_TRAIN_RE = /徒歩|歩いて|車|自転車|バス|タクシー/;
const NEAR_RE = /([^\s、,・/／()（）。]{1,12}?)(?:駅)?\s*(?:の)?\s*(?:近く|周辺|付近|近辺|あたり|辺り)/g;

export type AnchorUse = { anchor: string; type: "soft" | "ride" | "minutes" | "near" };

/** お客様の1発言から起点の駅の使い方を読む */
export function anchorUsesInText(text: string, groupKey: (s: string) => string | null): AnchorUse[] {
  const t = String(text ?? "").normalize("NFKC");
  const out: AnchorUse[] = [];
  const push = (a: string | null, type: AnchorUse["type"]) => { if (a && !out.some((x) => x.anchor === a && x.type === type)) out.push({ anchor: a, type }); };
  for (const a of readRelativeArea(t).anchors) push(a.station, "soft");
  for (const a of readRideAsks(t).anchors) push(a.station, "ride");
  for (const m of t.matchAll(MIN_PHRASE_RE)) {
    if (NOT_TRAIN_RE.test(m[0])) continue;
    const hits = stationsInText(m[1]);
    const last = hits[hits.length - 1];
    if (last && last.index + last.word.length === m[1].length) push(groupKey(normStation(last.word)), "minutes");
  }
  for (const m of t.matchAll(NEAR_RE)) {
    const hits = stationsInText(m[1]);
    const last = hits[hits.length - 1];
    if (last && last.index + last.word.length === m[1].length) push(groupKey(normStation(last.word)), "near");
  }
  return out;
}

export type PhraseKind = "相場" | "条件を広げる提案" | "理由の説明" | "所要の説明";
const PHRASE_RULES: Array<{ kind: PhraseKind; re: RegExp }> = [
  { kind: "相場", re: /家賃相場|相場は|相場程|相場より/ },
  { kind: "条件を広げる提案", re: /(?:エリア|間取り|家賃|条件|築年数)[^。！!]{0,12}(?:広げ|拡げ)/ },
  // 築年・構造・広さの「ので・ため・ますが」（安い・高い・狭い理由）。駅徒歩の分だけの文（「徒歩3分の好立地」）は数えない
  { kind: "理由の説明", re: /(?:築年数|築年|木造|鉄骨|鉄筋|広さ|一回り|狭)[^。！!]{0,30}(?:ため|ので|ますが|しまいますが|お安く|相場)/ },
  { kind: "所要の説明", re: /(?:駅|線)[^。！!]{0,15}(?:まで|へ)[^。！!]{0,8}[0-9]+\s*分[^。！!]{0,12}(?:距離|圏内|で行け|で通え|となります|です)/ },
];

/** お客様の呼びかけ・電話を伏せる（名前は持たない） */
export function anonymize(s: string): string {
  return s
    // 呼びかけは文頭・区切り・助詞の後ろの「◯◯さん」（前の語を巻き込まない）
    .replace(/(^|[、。！!？?\s「『（(]|[とのがはにもでよりへ])([^\s、。！!？?「」『』（）()・とのがはにもで]{1,10})(?:さん|様|さま)/g, "$1〇〇さん")
    .replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

/** スタッフの1発言から説明の1文を抜き出す（文の区切り＝「！！」「。」） */
export function staffPhrasesInText(text: string): Array<{ kind: PhraseKind; sentence: string }> {
  const t = String(text ?? "").normalize("NFKC").replace(/\r/g, "");
  const out: Array<{ kind: PhraseKind; sentence: string }> = [];
  for (const raw of t.split(/(?<=[。！!])\s*|\n+/)) {
    const s = raw.trim();
    if (s.length < 12 || s.length > 160) continue;
    for (const r of PHRASE_RULES) {
      if (!r.re.test(s)) continue;
      out.push({ kind: r.kind, sentence: anonymize(s) });
      break;
    }
  }
  return out;
}

export type LineKnowledge = { kind: "anchor_usage" | "staff_phrase"; key: string; payload: any; evidence_count: number; title: string; content: string };

/** 会話の山から知識の行を作る（人数＝会話の数で数える） */
export function buildLineKnowledge(msgs: MsgLite[], groupKey: (s: string) => string | null, opts: { maxExamples?: number } = {}): { rows: LineKnowledge[]; counts: Record<string, number> } {
  const maxEx = opts.maxExamples ?? 12;
  const byAnchor = new Map<string, Map<AnchorUse["type"], Set<string>>>();
  const byPhrase = new Map<PhraseKind, { convs: Set<string>; examples: string[] }>();
  let custMsgs = 0, staffMsgs = 0;
  for (const m of msgs) {
    if (!m.text) continue;
    if (m.sender === "customer") {
      custMsgs++;
      for (const u of anchorUsesInText(m.text, groupKey)) {
        const a = byAnchor.get(u.anchor) ?? new Map();
        (a.get(u.type) ?? a.set(u.type, new Set()).get(u.type)!).add(m.conversation_id);
        byAnchor.set(u.anchor, a);
      }
    } else if (m.sender === "staff") {
      staffMsgs++;
      for (const p of staffPhrasesInText(m.text)) {
        const b = byPhrase.get(p.kind) ?? { convs: new Set(), examples: [] };
        b.convs.add(m.conversation_id);
        if (b.examples.length < maxEx && !b.examples.includes(p.sentence)) b.examples.push(p.sentence);
        byPhrase.set(p.kind, b);
      }
    }
  }
  const rows: LineKnowledge[] = [];
  for (const [anchor, types] of byAnchor) {
    const convs = new Set<string>();
    for (const s of types.values()) for (const c of s) convs.add(c);
    const byType = Object.fromEntries([...types].map(([k, v]) => [k, v.size]));
    const label = ({ soft: "出やすい", ride: "1本・乗換なし", minutes: "◯分", near: "近く・周辺" } as const);
    rows.push({ kind: "anchor_usage", key: `station:${anchor}`, payload: { conversations: convs.size, by_type: byType }, evidence_count: convs.size,
      title: `${anchor}を起点にしたお客様の言い方`, content: `${anchor}を起点にした言い方（会話${convs.size}）: ${Object.entries(byType).map(([k, v]) => `${label[k as keyof typeof label]}${v}`).join("・")}` });
  }
  for (const [kind, b] of byPhrase) {
    rows.push({ kind: "staff_phrase", key: `phrase:${kind}`, payload: { conversations: b.convs.size, examples: b.examples }, evidence_count: b.convs.size,
      title: `スタッフの${kind}の文`, content: `スタッフの${kind}の文（会話${b.convs.size}）: ${b.examples.slice(0, 3).join(" ／ ")}` });
  }
  rows.sort((a, b) => b.evidence_count - a.evidence_count);
  return { rows, counts: { customer_messages: custMsgs, staff_messages: staffMsgs, anchors: byAnchor.size, phrase_kinds: byPhrase.size } };
}
