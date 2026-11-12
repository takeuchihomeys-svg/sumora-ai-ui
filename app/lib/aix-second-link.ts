// app/lib/aix-second-link.ts — AIX の2通目（✨ aix-template-generate）とブレイン・1通目のつなぎ目の直し（純関数・DB/LLM なし・既定 off）
//
// 2026-11-12 作業員25（竹内さん 11/12「AIX２通目の部分もちゃんとブレインと連携できているか／AIX一通目とちゃんと連携できているか／
//   足りていない土台や細分化で来ていない部分はないのか／細かい部分も改善する」）。費用0の読み（地図と実物 48組 exam-cache/anatomy-seven/aix-second-pairs.json）で見つけた切れ目のうち、確かな2つ:
//
//   ① 約束の読みが1通目を知らない（PROMISE_READ_UNIFIED=on の時だけ直す・既定 off＝今のまま）
//      2通目の材料（second-message-materials.openPromises）は promise-tracker.trackPromises＝文しか見ない。1通目が🌟の物件の札（「ピックアップしました」の字が無い）だと、
//      その札で果たしたピックアップ・新着の約束を「まだ果たしていない約束」として2通目に渡していた（実物の1通目 #0・#21 で再現）。
//      → 作業員4 の promise-read.readPromises（AIX の記録で果たした事も見る・約束の読みの1つの出所）に寄せ、1通目にボタンの種類（aixType）を付けて読む。
//
//   ② ブレインの「決め手の残り」（customer_mindset.decideGap＝お客様の言葉と点）が2通目に届いていない（AIX_SECOND_LINK=on の時だけ渡す・既定 off）
//      2通目の訴求の判断（second-appeal-judge・既定 on）と網（second-appeal-points）に渡るのは latent_intent・customer_concern・customer_emotion・hesitancy_pattern・key_topics だけ。
//      竹内さんは決め手の残りの言葉に1通目のお部屋が応える時、それを2通目の推す軸にする（#28「できればカウンターキッチンだと嬉しい」→
//      「現在YUMAさんご希望のご条件に近いお部屋でカウンターキッチン付のお部屋はこちらのお部屋1部屋となります！！」・AI の文には無かった）。
//      → 決め手の残りを「お客様の言葉・点・1通目のお部屋にその言葉があるか」の1行にして材料に渡す（決めるのは訴求の判断・道は変えない＝道の後の材料）。
//
// 語彙: 約束の種類は promise-read.ts（PromiseReadKind）・決め手の点は customer-mindset.ts（DECIDE_GAP_POINTS）・欄の名前は conductor-field-links の customer_mindset／exchange_ledger と同じ。
// テスト: app/lib/__tests__/aix-second-link.test.ts
import { readPromises, PROMISE_READ_KIND_JA, type PromiseMsg, type PromiseReadKind } from "./promise-read";
import { promiseKind, type OpenPromise, type PromiseKind } from "./promise-tracker";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export function aixSecondLinkOn(env: Env = envOf()): boolean {
  return (env.AIX_SECOND_LINK ?? "").trim().toLowerCase() === "on";
}

// ── ① 約束の読み（1通目の AIX で果たした約束を開いていると読まない） ──

/** 時刻付きの発言（second-message-materials の timed と同じ形） */
export type TimedMsg = { sender: string; text: string; createdAt: string; isAix: boolean };
/** promise-tracker と同じ「追う種類」（promise-read の TRACKED と同じ範囲） */
const TRACKED_READ: ReadonlySet<PromiseReadKind> = new Set(["pickup", "new_arrival", "check_vacancy", "check_mgmt", "negotiate", "estimate", "send_doc", "contact"]);

/**
 * 2通目の材料の「まだ果たしていない約束」を promise-read で読む。
 *   1通目（sentMessage）にボタンの種類（actionType）を付ける＝物件オススメ・ピックアップの札でピックアップ・新着の約束が閉じる。
 *   形は promise-tracker の OpenPromise（2通目の注記 buildSecondMaterialsNote がそのまま使える）。種類の名前は tracker の言葉（物件探し・確認…）に戻す。
 */
export function openPromisesAfterFirst(tm: ReadonlyArray<TimedMsg>, o: { nowMs: number; actionType?: string | null; sentMessage?: string | null }): OpenPromise[] {
  const sm = String(o.sentMessage ?? "").trim();
  const a = String(o.actionType ?? "").trim();
  // 1通目は一番後ろの同じ本文の通（無ければ付けない＝AIX の記録なしで読む）
  let firstIdx = -1;
  if (sm) for (let i = tm.length - 1; i >= 0; i--) if (tm[i].sender !== "customer" && tm[i].text.trim() === sm) { firstIdx = i; break; }
  const msgs: PromiseMsg[] = tm.map((m, i) => ({
    sender: m.sender, text: m.text, created_at: m.createdAt,
    is_aix_generated: m.isAix,
    aixType: i === firstIdx && a ? a : null,
  }));
  const latest = new Map<PromiseReadKind, OpenPromise>();
  for (const p of readPromises({ msgs, nowMs: o.nowMs })) {
    if (p.by !== "staff" || p.fulfilled || !TRACKED_READ.has(p.kind)) continue;
    latest.set(p.kind, {
      kind: (p.trackerKind ?? promiseKind(p.sentence)) as PromiseKind,
      sentence: p.sentence, at: p.at, elapsedH: p.elapsedH, hasDeadline: p.hasDeadline,
      status: p.waiting ? "待ち（新着・審査の結果次第）" : "期限内",
    });
  }
  return [...latest.values()].sort((x, y) => x.at.localeCompare(y.at));
}
export { PROMISE_READ_KIND_JA };

// ── ② 決め手の残り（customer_mindset.decideGap）→ 2通目の材料の1行 ──

export type DecideGapLike = { point?: string | null; solve?: string | null; property?: string | null; quote?: string | null } | null | undefined;
/** meta.customer_mindset.decideGap（brain-layers の digest.mg と同じ物）を取り出す */
export function decideGapOfMeta(meta: unknown): DecideGapLike {
  const m = meta && typeof meta === "object" ? (meta as { customer_mindset?: { decideGap?: DecideGapLike } | null }).customer_mindset : null;
  const g = m && typeof m === "object" ? m.decideGap : null;
  return g && typeof g === "object" && String(g.quote ?? "").trim() ? g : null;
}

const nk = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
/** お客様の言葉から、1通目に出てくるか確かめる語（カタカナ・漢字の3字以上の塊・「ガス」のような2字のカタカナ） */
export function gapWords(quote: string): string[] {
  const q = nk(quote);
  const out = new Set<string>();
  for (const m of q.matchAll(/[ァ-ヴー]{2,}|[一-龯々]{2,}[ァ-ヴー一-龯々]*/g)) {
    const w = m[0];
    // 一般の言葉（お部屋・物件・希望・条件・家賃）は当てない
    if (/^(?:部屋|物件|希望|条件|家賃|管理費|お願|感じ|予定|嬉|出来|一緒)$/.test(w)) continue;
    if (w.length >= 2) out.add(w);
  }
  return [...out].slice(0, 6);
}

/**
 * 決め手の残りを2通目の材料の1行に。1通目のお部屋にお客様の言葉がある時は「推す軸の一番に」と添える（竹内さん #28 の形）。
 *   ⚠ 決めるのは訴求の判断（second-appeal-judge）と書き手。ここは材料（道は変えない・本文を書き換えない）。
 *   別の物件で解く番（solve=c）で、1通目にその言葉が無い時は「この点に触れるなら事実だけ」と添える（作らない）。
 */
export function secondDecideGapLine(gap: DecideGapLike, firstMessage: string | null | undefined): string | null {
  if (!gap) return null;
  const quote = String(gap.quote ?? "").trim().slice(0, 40);
  if (!quote) return null;
  const point = String(gap.point ?? "").trim() || "その他";
  const first = nk(String(firstMessage ?? ""));
  const hit = first ? gapWords(quote).filter((w) => first.includes(w)) : [];
  const head = `決め手の残り（ブレインの読み・お客様の言葉）: 「${quote}」（${point}${gap.property ? `・${String(gap.property).slice(0, 30)}` : ""}）`;
  if (hit.length) return `${head} → 1通目のお部屋に「${hit.join("・")}」がある＝2通目でこの点を推す軸の一番に（お客様のご希望に応えるお部屋だと伝える・資料の字のまま）`;
  return `${head} → 1通目のお部屋の資料にこの言葉は無い＝触れるなら資料にある事実だけ（無い物を作らない）`;
}
