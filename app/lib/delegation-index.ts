// app/lib/delegation-index.ts — 台帳 #811「任せられる度」の表（場面ごとに毎日数える・純関数・DB/LLM なし）
// 2026-11-27 作業員L（統括役の割り振り）: 場面ごとに ① そのまま送れた割合（スタッフが下書きを直さず送った）② 危ない間違い ③ AIX の番を返信にした数。
//   数える元は新しく作らない: scripts/audit-split-reply-aix.ts（KB 8ee13967）の番の行（場面 scene・ブレインの判断 brain・人の答え truth・下書き draft と送った文 sent）。
//   ① 返信の番（人も返信・下書きがある）で 下書き＝送った文（正規化して同じ）の割合。
//   ② 危ない間違い＝直した番のうち、直しで 金額・日にち／時刻・物件名と号室・約束の言葉 のどれかが変わった（消した・違う値にした）番（言い回しだけの直しは数えない）。
//   ③ ブレインは返信なのに、人は AIX（人の文に AIX の中身があった番も含む＝aixByText）。
//   数え直しは本番の会話を読む＝22時以降（scripts/audit-delegation-index.ts で audit-split-reply-aix の行に当てる予定）
export type DelegRow = { scene: string; brain: string; truth: string; draft: string | null; sent: string | null; aixByText?: boolean };
export type DangerKind = "金額" | "日時" | "物件" | "約束" | "約束の言い過ぎ";
const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "").replace(/[。、！!？?…]+$/g, "");
const pick = (re: RegExp, s: string) => [...new Set([...String(s).normalize("NFKC").matchAll(re)].map((m) => m[0].replace(/[,，\s]/g, "")))].sort().join("|");
const MONEY_RE = /\d[\d,，]*\s*(?:万|千)?円|\d+(?:\.\d+)?\s*万/g;
const DATE_RE = /\d{1,2}\s*[\/月]\s*\d{1,2}\s*日?|\d{1,2}\s*[:：時]\s*\d{0,2}\s*分?|(?:今日|明日|明後日|本日|来週|今週)(?:中|の|に)?/g;
const PROP_RE = /\d{2,4}\s*号室|[ァ-ヶー]{3,}(?:[ァ-ヶーⅠ-Ⅹ0-9]{0,6})|[一-龥]{2,}(?:マンション|ハイツ|コーポ|レジデンス|荘)/g;
/** 物件名ではない普通のカタカナ（返信によく出る言葉・設備・手続き） */
export const COMMON_KATAKANA = new Set(["ピックアップ", "オススメ", "サポート", "エリア", "ペット", "ペットサイズ", "メール", "エラー", "フォーマット", "リビング", "カード", "アクセス", "オートロック", "メッセージ", "スタッフ", "キッチン", "バストイレ", "エアコン", "インターネット", "クローゼット", "ベランダ", "バルコニー", "フローリング", "シャワー", "トイレ", "コンロ", "ガスコンロ", "システムキッチン", "ロフト", "スーモ", "ホームページ", "スケジュール", "キャンセル", "プラン", "オーナー", "フリーレント", "ルームツアー", "マンション", "アパート", "タイミング", "ポイント", "チェック", "スムーズ", "コメント", "ラインナップ", "リスト"]);
const propTokens = (s: string) => [...new Set([...String(s).normalize("NFKC").matchAll(PROP_RE)].map((m) => m[0].replace(/[,，\s]/g, "")).filter((t) => !COMMON_KATAKANA.has(t)))].sort().join("|");
const PROMISE_RE = /確認(?:させて|して|致し|いたし)|お調べ|折り返し|お送り(?:させて|致し|いたし)|ご連絡(?:させて|致し|いたし)|手配|押さえ/g;
/** 日時の鍵（純関数）: 末尾の「日・の・に・中」を外し、時刻の「時」と「:」をそろえる */
const dateKey = (s: string) => [...new Set([...String(s).normalize("NFKC").matchAll(DATE_RE)].map((m) => m[0].replace(/\s/g, "").replace(/(?:日|の|に|中)+$/, "").replace(/月/, "/").replace(/時(\d+)分?$/, ":$1").replace(/時$/, ":00")))].sort().join("|");
/** 下書きの値（| でつないだ鍵）のどれかが送った文に無いか */
const dropsOf = (d: string, s: string) => { if (!d) return false; const have = new Set(s ? s.split("|") : []); return d.split("|").some((t) => !have.has(t)); };
/** 下書きの約束をスタッフが消した（言い過ぎの約束・危ない間違いには数えない） */
export function promiseDropped(draft: string | null | undefined, sent: string | null | undefined): boolean { return !!draft && !!sent && pick(PROMISE_RE, draft) !== "" && pick(PROMISE_RE, sent) === ""; }
/** 直しで変わった危ない種類（純関数）。下書きが無い・直していない番は空 */
export function dangerOfEdit(draft: string | null | undefined, sent: string | null | undefined): DangerKind[] {
  if (!draft || !sent || norm(draft) === norm(sent)) return [];
  const out: DangerKind[] = [];
  // 2026-11-28 作業員L（#811・当てはめの絞り）: 危ないのは「下書きの値をスタッフが消した・変えた」番だけ（スタッフが値を足しただけ＝下書きは言っていない＝そのまま送っても間違いは言わない）
  if (dropsOf(pick(MONEY_RE, draft), pick(MONEY_RE, sent))) out.push("金額");
  // 2026-11-28 作業員L（#811・統括役「当てはめを絞る」）: 日にちの書き方の違い（11/18 と 11/18日・明日 と 明日の）は同じに数える
  if (dropsOf(dateKey(draft), dateKey(sent))) out.push("日時");
  // 2026-11-28 作業員L（#811 の本番の数え）: カタカナの普通の言葉（ピックアップ 43・オススメ 28・サポート 25・エリア 10 …）が物件名に数えられ、
  //   返信の番の半分以上が「危ない間違い」になっていた＝物件名の候補から普通の言葉を外す
  if (dropsOf(propTokens(draft), propTokens(sent))) out.push("物件");
  // 2026-11-28 作業員L（#811）: 約束は「下書きが言い切っていたのにスタッフが確かめの約束に直した」向きだけ（そのまま送ると確かめていない事を言い切る＝危ない）。
  //   逆の向き（下書きの「お送りさせて頂きます」等をスタッフが消した＝30日で 40番中 33番）は言い過ぎの約束で、危ない間違いには数えない（promiseDropped で別に数える）
  if (pick(PROMISE_RE, draft) === "" && pick(PROMISE_RE, sent) !== "") out.push("約束");
  // 2026-11-28 統括役の決め: 下書きが約束を言い切り、スタッフが消した（promiseDropped）は自動返信で一番危ない形（AI が守れない約束を送る）＝危ない間違いの合計に入れ、内訳は別の欄
  if (promiseDropped(draft, sent)) out.push("約束の言い過ぎ");
  return out;
}
export type DelegCell = { scene: string; replyTurns: number; asIs: number; asIsRate: number | null; edited: number; danger: number; /** 値の間違い（金額・日時・物件・言い切り）の番 */ dangerValue: number; /** 約束の言い過ぎの番 */ dangerOverPromise: number; dangerKinds: Partial<Record<DangerKind, number>>; aixTurns: number; aixAsReply: number };
// 2026-11-28 作業員L（統括役の決め・作業員A の c7aa79e00 と同じ数え方）: AIX の番は、スタッフの返事の塊の中ですぐ押した AIX（truth が AIX）だけ。
//   「2段」（約束の文を返して後で AIX）はブレインの返信と合う＝AIX の番に数えず、返信の番として「そのまま送れたか」を数える
const isAix = (s: string) => /^AIX/.test(s);
/** 場面ごとの表（純関数） */
export function delegationTable(rows: readonly DelegRow[]): DelegCell[] {
  const by = new Map<string, DelegRow[]>();
  for (const r of rows) by.set(r.scene || "-", [...(by.get(r.scene || "-") ?? []), r]);
  const out: DelegCell[] = [];
  for (const [scene, xs] of by) {
    const reply = xs.filter((r) => !isAix(r.truth) && !r.aixByText && r.draft && r.sent);
    const asIs = reply.filter((r) => norm(r.draft) === norm(r.sent)).length;
    const edited = reply.length - asIs;
    const dk: Partial<Record<DangerKind, number>> = {}; let danger = 0, dangerValue = 0, dangerOverPromise = 0;
    for (const r of reply) { const d = dangerOfEdit(r.draft, r.sent); if (d.length) { danger++; if (d.some((k) => k !== "約束の言い過ぎ")) dangerValue++; if (d.includes("約束の言い過ぎ")) dangerOverPromise++; for (const k of d) dk[k] = (dk[k] ?? 0) + 1; } }
    const aixTurns = xs.filter((r) => isAix(r.truth) || r.aixByText).length;
    const aixAsReply = xs.filter((r) => (isAix(r.truth) || r.aixByText) && /^返信/.test(r.brain)).length;
    out.push({ scene, replyTurns: reply.length, asIs, asIsRate: reply.length ? Math.round((asIs / reply.length) * 1000) / 10 : null, edited, danger, dangerValue, dangerOverPromise, dangerKinds: dk, aixTurns, aixAsReply });
  }
  return out.sort((a, b) => b.replyTurns + b.aixTurns - (a.replyTurns + a.aixTurns));
}
/** 朝の1枚の行（場面ごと・番の少ない場面は出さない） */
export function delegationLines(cells: readonly DelegCell[], minTurns = 5): string[] {
  return cells.filter((c) => c.replyTurns + c.aixTurns >= minTurns).map((c) => `- ${c.scene}: そのまま送れた ${c.asIsRate ?? "—"}%（${c.asIs}/${c.replyTurns}）・危ない間違い ${c.danger}（値の間違い ${c.dangerValue}・約束の言い過ぎ ${c.dangerOverPromise}）${c.danger ? `（${Object.entries(c.dangerKinds).map(([k, v]) => `${k}${v}`).join("・")}）` : ""}・AIX の番を返信にした ${c.aixAsReply}/${c.aixTurns}`);
}
