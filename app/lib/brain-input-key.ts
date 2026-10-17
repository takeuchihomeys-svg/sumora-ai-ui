// app/lib/brain-input-key.ts — ブレインの「入力の鍵」（純関数）
//
// 2026-10-18 竹内さん「質を落とさずに API を減らす」の調べ（本番14日）: 同じ入力でブレインが2回回る番がある
//   （bg-async の後60秒以内のもう1回・sweep の拾い直し・戦略のゼロからの作り直しと重なる分析）。
//   入力の鍵＝最後のお客様の発言の時刻＋最後のこちら（スタッフ・AIX）の送信の時刻＋最後に押した AIX の時刻
//   ＋今のお客様の番（最後のこちらの送信の後のお客様の連投）の文の指紋。
//   鍵が同じ＝ブレインに渡る会話は同じ（新しい発言・送信・AIX の押下も、画像の読み取りによる文の書き換えも無い）。
//   鍵が変われば必ず回す（新しい発言を見落とさない）。

export type KeyMsg = { sender: string; created_at: string | null | undefined; text?: string | null };

/** 32bit FNV-1a（指紋。暗号ではない・同じ文なら同じ値） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * msgs: 古い順でも新しい順でもよい（時刻で並べ直す）。直近 20 通ほどで足りる（今の番と最後の送信が入っていればよい）。
 * lastAixPressAt: 最後に押した AIX の時刻（aix_usage_logs）。無ければ null
 */
export function brainInputKeyOf(msgs: readonly KeyMsg[], lastAixPressAt?: string | null): string {
  const rows = msgs
    .map((m) => ({ m, ts: m.created_at ? Date.parse(m.created_at) : NaN }))
    .filter((x) => Number.isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts);
  let cust = -Infinity, out = -Infinity;
  for (const { m, ts } of rows) {
    if (m.sender === "customer") cust = Math.max(cust, ts);
    else out = Math.max(out, ts);
  }
  // 今のお客様の番＝最後のこちらの送信より後のお客様の通（画像の読み取りで文が書き換わると指紋が変わる）
  const turn = rows.filter((x) => x.m.sender === "customer" && x.ts > out).map((x) => x.m.text ?? "").join("\n");
  const a = lastAixPressAt ? Date.parse(lastAixPressAt) : NaN;
  const f = (x: number) => (Number.isFinite(x) ? new Date(x).toISOString() : "-");
  return `c:${f(cust)}|o:${f(out)}|a:${f(a)}|h:${fnv1a(turn)}`;
}

export type InputKeyReuseInput = {
  /** 今の鍵 */
  key: string;
  /** 前回の本分析（last_brain_meta）が書いた鍵。無ければ null（このスイッチを入れる前の分析） */
  prevKey: string | null | undefined;
  /** 前回の本分析の出どころ（cached・aix_patch は判断を持ち越さないので使わない） */
  prevSource: string | null | undefined;
  /** 前回の本分析の時刻（brain_full_analyzed_at） */
  prevAnalyzedAt: string | null | undefined;
  /** スタッフの宣言直後・画像の読み取り完了など、呼び出し側が分析し直しを求めている */
  forced: boolean;
  nowMs: number;
  env?: Record<string, string | undefined>;
};

/** 同じ鍵の前回の判断を使い回す最長（nothingNewSinceLastAnalysis と同じ6時間） */
export const INPUT_KEY_REUSE_HOURS = 6;
const JST_MS = 9 * 60 * 60 * 1000;
const jstDay = (ms: number) => Math.floor((ms + JST_MS) / 86_400_000);

/**
 * 同じ入力の鍵の前回の判断を使い回すか（純関数）。使い回す＝ブレイン（LLM）を呼ばない。
 * 日付をまたいだら使い回さない（「明日」「今日」の判断が変わる）。戻す BRAIN_INPUT_KEY_REUSE=off
 */
export function decideInputKeyReuse(i: InputKeyReuseInput): { reuse: boolean; reason: string } {
  const env = i.env ?? (typeof process !== "undefined" ? process.env : {});
  if ((env.BRAIN_INPUT_KEY_REUSE ?? "").trim().toLowerCase() === "off") return { reuse: false, reason: "switch_off" };
  if (i.forced) return { reuse: false, reason: "forced" };
  if (!i.prevKey) return { reuse: false, reason: "no_prev_key" };
  if (i.prevKey !== i.key) return { reuse: false, reason: "key_changed" };
  if (i.prevSource === "cached" || i.prevSource === "aix_patch") return { reuse: false, reason: "prev_not_reusable" };
  const at = i.prevAnalyzedAt ? Date.parse(i.prevAnalyzedAt) : NaN;
  if (!Number.isFinite(at)) return { reuse: false, reason: "no_prev_time" };
  const elapsed = i.nowMs - at;
  if (elapsed < 0 || elapsed >= INPUT_KEY_REUSE_HOURS * 3_600_000) return { reuse: false, reason: "too_old" };
  if (jstDay(at) !== jstDay(i.nowMs)) return { reuse: false, reason: "day_changed" };
  return { reuse: true, reason: "same_key" };
}
