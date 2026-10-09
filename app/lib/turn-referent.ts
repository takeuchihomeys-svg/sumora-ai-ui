// app/lib/turn-referent.ts — 主語の抜けたお客様の発言（「空いてますか？」「いくらですか？」「これにします」）が指している物件の候補（純関数・DB なし）
//
// 2026-10-09 竹内「主語が抜けていた場合、その主語は何のことなのか把握できるようになっているか。隠れた主語を見極める力」
//   ＋「Claude Code にあってツールに無い力 1. ブレインが必要な時に自分で調べに行ける」の設計の比較（道具を持たせる／2段／決定論で先に引く）で
//   決定論で先に引く（b）を採った: 試験（base-ds-1009）の不合格 47 のうち、材料が束に無かった物は 2（物件の資料の設備・退去日）だけで、
//   台帳・送った物・会社の事実は束に届いていた。外れの主因は「どの物件か」の材料の化け・欠け（scripts/audit-hidden-subject.ts）。
//
// 【段（scripts/audit-hidden-subject.ts の実測・60日・竹内さんの返事で正解が決まる番）】
//   ① 引用 … property-thread の turnTargets が先に決める（ここには来ない）
//   ② 直前のこちらの送信（前のお客様の発言から今の番まで・72時間）に出た物件が1件 → その物件（9/9）
//      2件以上 → 決めない。「候補: ①A・②B（送った順）」で渡す（推測で1件にしない）
//   ③ こちらが最後に出した物件が1件（同じ束＝2分以内に並んだ物件が1件だけ）→ その物件（12/13）
//   ④ お客様が最後に名前を出した物件 → その物件（10/16・弱い＝「推定」と書く）
// 渡す所: property-thread の台帳の文（ブレインと返信の両方が同じ関数で読む）。turnTargets には入れない（内覧の確認・契約の答え等の他の利用者の動きを変えない）。
// 既定 off（2026-10-09 竹内さん「本番に入れていく」: ブレインの試験の前後で確かめるまで。入れる: PROPERTY_REFERENT_FALLBACK=on）

export function turnReferentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROPERTY_REFERENT_FALLBACK ?? "").toLowerCase() === "on";
}

/** 主語が要る述語・指示語（物件・話題を言わずに聞く／決める形） */
const PRED_RE = /空いて|空き|まだあり|募集|いくら|初期費用|費用|家賃|見れ|見られ|見に行|内覧|内見|見学|ペット|これに(?:し|決)|こちらに(?:し|決)|ここに(?:し|決)|これで|ここで|そこで|決め|住め|入居|二人|2人|２人|ふたり|同棲|大丈夫|可能|でき(?:ます|る)|ありますか|どう(?:です|でしょう)|こちら|これ|ここ|それ|そちら|そこ|あれ|気になり|いいです|良いです|礼金|敷金|安く|写真|詳細|間取り/;
/** 物件・部屋を自分で言っている（主語あり） */
//   カタカナの名前に地名が続く形（「ロジワール城山の初期費用」）も名指し
const NAMED_RE = /号室|https?:\/\/|[0-9０-９]{3,4}(?![0-9０-９]*(?:円|万|日|時|分|年|月))|[ァ-ヶー]{4,}[一-龥]{0,4}(?:の|は|って|も)|[A-Za-zＡ-Ｚａ-ｚ]{4,}/;
/** 複数を指す語（1件に決めない） */
const MULTI_RE = /[2２二]件とも|どの物件も|どれも|全部|全て|すべて|いずれも|どっちも|どちらも|両方/;
/** 物件と関係の無い発言（お礼・挨拶・スタンプだけ）は外す */
const SMALLTALK_RE = /^(?:ありがとうございます|ありがとうございました|了解です|わかりました|分かりました|承知しました|よろしくお願いします|お願いします|はい)[!！。.〜~😊🙇‍♀️🙏\s]*$/u;

/** この番の文（お客様の文字の発言をつないだ物）が主語の抜けた物件の話か */
export function isHiddenSubjectTurn(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t || t.length > 160) return false;
  if (SMALLTALK_RE.test(t)) return false;
  if (!PRED_RE.test(t)) return false;
  if (NAMED_RE.test(t)) return false;
  return true;
}
/** 複数の物件を指している（「どっちも」「全部」）＝1件に決めない */
export function refersToMany(text: string): boolean {
  return MULTI_RE.test(String(text ?? ""));
}

export type ReferentMention = { at: string; roomKey: string; display: string; by: "ours" | "customer" };
export type TurnReferent =
  | { kind: "one"; roomKey: string; display: string; step: "prev_send_one" | "ours_last_one" | "customer_last"; at: string; why: string }
  | { kind: "many"; candidates: Array<{ roomKey: string; display: string; at: string }>; step: "prev_send_many" | "ours_last_many" | "refers_many"; why: string };

const ms = (iso: string) => Date.parse(iso);

/**
 * 主語の抜けた今の番の物件の候補。
 * mentions: こちら（ours）・お客様（customer）が物件を出した時刻（台帳の出来事・送った画像・手打ちの名指し）。古い順でなくてよい。
 * turnStartAt: 今の番の最初のお客様の発言の時刻。prevCustomerAt: その前のお客様の発言の時刻（無ければ null）。
 */
export function resolveTurnReferent(opts: {
  turnText: string;
  turnStartAt: string;
  prevCustomerAt: string | null;
  mentions: ReadonlyArray<ReferentMention>;
  jst: (iso: string) => string;
}): TurnReferent | null {
  if (!isHiddenSubjectTurn(opts.turnText)) return null;
  const t0 = ms(opts.turnStartAt);
  const before = opts.mentions.filter((m) => ms(m.at) < t0).sort((a, b) => ms(a.at) - ms(b.at));
  if (!before.length) return null;
  const uniq = (xs: ReadonlyArray<ReferentMention>) => {
    const seen = new Map<string, ReferentMention>();
    for (const x of xs) if (!seen.has(x.roomKey)) seen.set(x.roomKey, x); // 最初に出た時刻（送った順）
    return [...seen.values()];
  };
  const many = (xs: ReadonlyArray<ReferentMention>) => xs.map((x) => ({ roomKey: x.roomKey, display: x.display, at: x.at }));
  // ② 直前のこちらの送信（前のお客様の発言より後・72時間以内）
  const from = Math.max(opts.prevCustomerAt ? ms(opts.prevCustomerAt) : -Infinity, t0 - 72 * 3600_000);
  const prev = uniq(before.filter((m) => m.by === "ours" && ms(m.at) > from));
  if (refersToMany(opts.turnText)) {
    if (prev.length >= 2) return { kind: "many", candidates: many(prev), step: "refers_many", why: "「どっちも」「全部」等＝直前に送った物件の全部" };
    return null;
  }
  // 名前の一部（「カシータ見にいく」＝カシータ神戸元町JP）: 候補の頭のカタカナ・英字（3字以上）が文にあり、当たる候補が1件だけ
  const partial = (xs: ReadonlyArray<ReferentMention>): ReferentMention | null => {
    const t = String(opts.turnText).normalize("NFKC");
    const hits = xs.filter((x) => { const h = x.display.normalize("NFKC").match(/^[ァ-ヶーA-Za-z]{3,}/)?.[0]; return !!h && t.includes(h); });
    const keys = [...new Set(hits.map((h) => h.roomKey))];
    return keys.length === 1 ? hits[0] : null;
  };
  if (prev.length >= 2) {
    const p = partial(prev);
    if (p) return { kind: "one", roomKey: p.roomKey, display: p.display, step: "prev_send_one", at: p.at, why: `名前の一部が直前に送った物件と同じ（${opts.jst(p.at)}）` };
  }
  if (prev.length === 1) return { kind: "one", roomKey: prev[0].roomKey, display: prev[0].display, step: "prev_send_one", at: prev[0].at, why: `直前のこちらの送信に出た物件が1件（${opts.jst(prev[0].at)}）` };
  if (prev.length >= 2) return { kind: "many", candidates: many(prev), step: "prev_send_many", why: "直前のこちらの送信に物件が複数" };
  // ③ こちらが最後に出した物件（同じ束＝最後の時刻から2分以内）
  const ours = before.filter((m) => m.by === "ours" && ms(m.at) >= t0 - 14 * 86400_000);
  if (ours.length) {
    const last = ms(ours[ours.length - 1].at);
    const bundle = uniq(ours.filter((m) => last - ms(m.at) <= 2 * 60_000));
    // こちらが最後に出した後に、お客様が名前を出した物件があればそちらが新しい話（④を先に）
    const cust = before.filter((m) => m.by === "customer" && ms(m.at) > last);
    if (cust.length) { const c = cust[cust.length - 1]; return { kind: "one", roomKey: c.roomKey, display: c.display, step: "customer_last", at: c.at, why: `お客様が最後に名前を出した物件（${opts.jst(c.at)}・推定）` }; }
    if (bundle.length === 1) return { kind: "one", roomKey: bundle[0].roomKey, display: bundle[0].display, step: "ours_last_one", at: bundle[0].at, why: `こちらが最後に出した物件（${opts.jst(bundle[0].at)}）` };
    return { kind: "many", candidates: many(bundle), step: "ours_last_many", why: "こちらが最後に送った束に物件が複数" };
  }
  // ④ お客様が最後に名前を出した物件（14日以内）
  const cust = before.filter((m) => m.by === "customer" && ms(m.at) >= t0 - 14 * 86400_000);
  if (cust.length) { const c = cust[cust.length - 1]; return { kind: "one", roomKey: c.roomKey, display: c.display, step: "customer_last", at: c.at, why: `お客様が最後に名前を出した物件（${opts.jst(c.at)}・推定）` }; }
  return null;
}

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
/** 台帳の文に入れる行（主語の抜けた番だけ） */
export function turnReferentLines(r: TurnReferent, turnText: string, jst: (iso: string) => string): string[] {
  const q = Array.from(String(turnText ?? "").replace(/\s+/g, " ")).slice(0, 40).join("");
  if (r.kind === "one") {
    return [
      `▶ 今の番の物件（主語の無い発言「${q}」）: ${r.display}（${r.why}）`,
      `  → 答え・約束は ${r.display} の事として書く（物件名を本文に出してよい）。推定の時は他の物件と取り違えない書き方で。`,
    ];
  }
  const list = r.candidates.slice(0, 10).map((c, i) => `${CIRCLED[i] ?? `${i + 1}.`}${c.display}（${jst(c.at)}）`).join("・");
  if (r.step === "refers_many") return [`▶ 今の番の物件（「${q}」）: 直前に送った物件の全部 ${list}（送った順）`];
  return [
    `▶ 今の番の物件（主語の無い発言「${q}」）: 決まらない（${r.why}）。候補: ${list}（送った順）`,
    "  → 1件に決めて答えない。候補の全部に触れるか、どのお部屋か分かる書き方で確かめる（推測で物件名を1つに決めない）。",
  ];
}
