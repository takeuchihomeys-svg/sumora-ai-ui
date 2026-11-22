// scripts/lib/writer-field-metrics.ts — 統括が決めた欄が書き手に届き、下書きに入ったかの数え方（純関数・LLM なし・DB なし）
//
// 2026-11-23 作業員L（台帳 #466・統括役の頼み: 欄ごとの数の名前を決めて quality_daily に書ける形に・作業員P の地図 #610 の葉にする）
//   ① 数の名前（quality_daily.metric）: writer_link:field:<欄>:delivered（書き手の注記に届いた割合）／writer_link:field:<欄>:in_draft（下書きに入った割合）
//      ／writer_link:brief:<指示書の欄>:in_draft。value は %（小数1桁）、n は値のあった番の数。scope は "reply"
//   ② 下書きに入ったかの見方（audit-writer-linkage の初版は全部の欄を値の語の一致で見ていた）。直近72時間を目で読むと数え方の誤りが3つあった:
//      ・focus … 値は「relation＝短い了承。受けて関係を続ける番」のような方向の指示で、語は下書きに出ない（下書きは指示どおり短い受けだった）
//               → 方向の種類で見る（relation＝短い受け・promise_make＝約束の言い方・ほかは数えない）
//      ・our_side … 「・開いている約束: なし」まで値に数え、「（23時間前・…）」の時間の語（23時）を探していた → 「なし」は値なし・括弧の中の時間は外し、引用「」の中身で見る
//      ・asks … 値はお客様の言葉そのもので、「かしこまりました」「宜しくお願い致します」のような挨拶まで要件に数え、お客様の言い方の語を探していた
//               → 挨拶だけの値は要件にしない・英数字の語（1DK・30日）と漢字カタカナの語で見る
import { tokensOfValue } from "../../app/lib/compose-brief-uptake";

const PROMISE_KIND_RE: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/確認の約束/, /確認(?:させて|致し|いたし|出来次第|でき次第)/],
  [/探すの約束|物件を送るの約束/, /ピックアップ|お送り(?:させて|致し|いたし)|出来次第お送り/],
  [/見積の約束/, /御?見積/],
];
export const squash = (s: string) => s.normalize("NFKC").replace(/[\s、。・「」（）()／/：:→＝！!？?]/g, "");
const GREETING_ONLY = /^(?:はい|了解|承知|かしこまりました|わかりました|分かりました|ありがとうございます|宜しくお願い|よろしくお願い|申し訳ござい|すみません|お願い致します|お願いします)[^。！!？?]{0,16}[。！!]?$/;

/** 挨拶の言い回しを外した残り（「引き続き宜しくお願いします」「こちらこそありがとうございました」は残りが空＝要件でない） */
export function greetingRest(v: string): string {
  return v.normalize("NFKC").replace(/こちらこそ|引き続き|何卒|どうぞ|今後とも|本当に|色々と?|(?:宜し|よろし)く(?:お願い(?:します|致します|いたします|しま)?)?|ありがとう(?:ございます|ございました)?|お願い(?:します|致します|いたします)|すみません|申し訳ござい(?:ません)?(?:が)?|了解(?:です|しました)?|承知(?:しました|致しました)?|かしこまりました|わかりました|分かりました|はい|[\s、。！!？?〜ー😊🙇🙏✨]/gu, "");
}
/** 値が数える対象か（数えない時は null の理由） */
export function skipReason(key: string, value: string): string | null {
  const v = String(value ?? "").trim();
  if (!v) return "値なし";
  if (key === "our_side" && /開いている約束[:：]\s*なし\s*$/.test(v)) return "値なし";
  if (key === "asks" && (GREETING_ONLY.test(v.normalize("NFKC")) || greetingRest(v).length < 4)) return "挨拶だけ";
  if (key === "focus" && !/^(?:relation|promise_make)\s*[＝=]/.test(v)) return "方向の種類が数えない物";
  return null;
}

/** 値の語（欄ごとの見方） */
export function tokensFor(key: string, value: string): string[] {
  let v = String(value ?? "");
  if (key === "our_side") {
    const q = [...v.matchAll(/「([^」]+)」/g)].map((m) => m[1]).join(" ");
    v = (q || v).replace(/（[^）]*(?:前|後)[^）]*）/g, "");
  }
  const base = tokensOfValue(v);
  const ascii = (v.normalize("NFKC").match(/[A-Za-z0-9][A-Za-z0-9.,]*(?:LDK|DK|K|R|万円|円|帖|㎡|分|日|月|階)?/g) ?? []).filter((x) => x.length >= 2);
  return [...new Set([...base, ...ascii].map(squash).filter((x) => x.length >= 2))];
}

/** 下書きに入ったか。null は数えない */
export function inDraftOf(key: string, value: string, draft: string): boolean | null {
  if (skipReason(key, value)) return null;
  const d = String(draft ?? "");
  if (key === "focus") {
    if (/^relation/.test(value)) return d.replace(/\s/g, "").length <= 90; // 短い受け（竹内さんの短い了承の返しの長さ）
    if (/^promise_make/.test(value)) return /させて(?:頂|いただ)き|出来次第|でき次第|お送り(?:させて|致し)/.test(d);
  }
  // 2026-11-23: our_side の開いている約束は、書き手は約束の種類を言い直す（「確認出来次第ご連絡」「ピックアップ出来次第お送り」）＝種類の言い方で見る
  if (key === "our_side") { const k = PROMISE_KIND_RE.find(([re]) => re.test(value)); if (k && k[1].test(d)) return true; }
  const toks = tokensFor(key, value);
  if (!toks.length) return null;
  const dr = squash(d);
  return toks.some((x) => dr.includes(x));
}

export type MetricRow = { metric: string; scope: string; value: number | null; n: number; detail: Record<string, unknown> };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** audit-writer-linkage の表 → quality_daily の行（作業員N2・P が書く） */
export function metricRowsOf(o: {
  fields: ReadonlyArray<{ key: string; val: number; writerOk: number; inDraftN: number; inDraft: number }>;
  brief: Readonly<Record<string, { n: number; used: number }>>;
  hours: number;
}): MetricRow[] {
  const out: MetricRow[] = [];
  for (const f of o.fields) {
    if (!f.val) continue;
    out.push({ metric: `writer_link:field:${f.key}:delivered`, scope: "reply", value: pct(f.writerOk, f.val), n: f.val, detail: { hours: o.hours } });
    if (f.inDraftN) out.push({ metric: `writer_link:field:${f.key}:in_draft`, scope: "reply", value: pct(f.inDraft, f.inDraftN), n: f.inDraftN, detail: { hours: o.hours, counted: f.inDraftN, of: f.val } });
  }
  for (const [k, c] of Object.entries(o.brief)) if (c.n) out.push({ metric: `writer_link:brief:${k}:in_draft`, scope: "reply", value: pct(c.used, c.n), n: c.n, detail: { hours: o.hours } });
  return out;
}
