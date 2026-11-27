// app/lib/check-now-possible.ts — 今確かめられるか（事実の1行・#821・純関数・LLM/DB なし・2026-11-27 作業員A）
//
// #821 の読み（30日・条件提示と質問の場面・スタッフの返事の塊の中で押した AIX）: 一番多い組は「物件確認した × 本来 AIX の番」15番。
//   お客様が送ってきた物件・聞いた物件の空きや内装を、竹内さんはその場で確かめて AIX【物件確認した】を送り、ブレインは「確認して送る約束の返信」にしていた。
//   スタッフが今確かめられるか（管理会社の営業時間・同じ物件の確認の結果がもうあるか）がブレインに見えていなかった。
// 中身は事実だけ（統括役 11/27）: ①管理会社の営業時間の内か（time-facts の決まりの値＝平日 9〜18時・土日祝は休みの扱い・推測で書かない）
//   ②同じ物件の 物件確認した の結果がもうあるか（いつ・何と）。すぐ AIX にするかはブレインが決める（決め打ちにしない・P0 9eb6aa9c）。
// スイッチ CHECK_NOW_POSSIBLE_LINE（既定 off・段階で読む）・印 material_marks.check_now_possible（字数）
import { stagedOn, STAGE_OFF } from "./switch-stage";
import { computeTimeFacts } from "./time-facts";
import { splitPropertyName } from "./pickup-link-stages";
import { pickJa } from "./conductor-our-side";

type Env = Record<string, string | undefined>;
export const checkNowPossibleOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("CHECK_NOW_POSSIBLE_LINE", env, STAGE_OFF);

/** 確かめる事がある番か（物件の空き・内見・見積・設備・内装・写真・物件の持ち込み）。無い番は1行を出さない */
export const CHECK_ASK_RE = /空い|空き|空室|募集|内見|内覧|見積|初期費用|https?:\/\/|号室|ペット|設備|内装|写真|動画|まだあり|残って/;
export type CheckAix = { aix_type: string | null; check_pattern?: string | null; property_names?: string[] | null; sent_at?: string | null; created_at: string };
const md = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 36e5); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };

/** 今の通の文に名前が出た物件の、物件確認した の記録（days 日まで・新しい順・建物名で照らす） */
export function priorChecksFor(text: string, aix: readonly CheckAix[], nowMs: number, days = 14): Array<{ name: string; at: string; result: string }> {
  const t = String(text ?? "").normalize("NFKC").replace(/[\s　・\-‐‑–—_/／.,、。'"’]/g, "");
  const since = nowMs - days * 864e5;
  const out: Array<{ name: string; at: string; result: string }> = [];
  for (const a of [...aix].sort((x, y) => (y.sent_at ?? y.created_at).localeCompare(x.sent_at ?? x.created_at))) {
    if (a.aix_type !== "property_check_result") continue;
    const at = a.sent_at ?? a.created_at; const ms = Date.parse(at);
    if (!(ms >= since && ms <= nowMs)) continue;
    for (const n of a.property_names ?? []) {
      const b = splitPropertyName(n).building;
      if (b.length >= 3 && t.includes(b) && !out.some((o) => o.name === n)) out.push({ name: n, at, result: pickJa(a.check_pattern ?? null) || "結果の種類なし" });
    }
  }
  return out.slice(0, 3);
}

/** 事実の1行（確かめる事が無い番は空文字） */
export function checkNowPossibleLine(o: { customerText: string; aix: readonly CheckAix[]; nowMs: number; hour?: number }): string {
  if (!CHECK_ASK_RE.test(String(o.customerText ?? "").normalize("NFKC"))) return "";
  const tf = computeTimeFacts({ nowMs: o.nowMs, hour: o.hour });
  const mgmt = tf.mgmtOpen ? "管理会社は今、営業時間の内（平日 9〜18時・土日祝は休みの扱い）" : `管理会社は今、営業時間の外（次に開くのは ${tf.mgmtNextOpen ? `${tf.mgmtNextOpen.day.md}（${tf.mgmtNextOpen.day.dow}）9時` : "次の平日 9時"}の扱い）`;
  const prior = priorChecksFor(o.customerText, o.aix, o.nowMs);
  const pr = prior.length ? prior.map((p) => `同じ物件（${p.name.slice(0, 24)}）の物件確認した: ${md(p.at)}「${p.result}」`).join("／") : "今の通の物件の 物件確認した の記録（14日）: なし";
  return `【今確かめられるか（事実だけ・確認の約束の返信にするか、確かめて AIX で送るかは決めるのはあなた）】${mgmt}／${pr}`;
}
