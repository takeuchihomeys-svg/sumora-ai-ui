// app/lib/takeuchi-seven-read.ts — 竹内さんの1通を7つの欄＋押す／待つで読む（純関数）。読み手の指示・読み取り・ブレインとの比べ・書き手への渡し方
//
// 2026-11-11 作業員5（竹内さんの決定 KB P1 1f5bd301・親 P0 2e164f41／11/11 追記「潜在意識はこの場合だったら何のことなのか細かく。
//   どうやって要点を押さえているか、どうやって信頼関係を構築しているか等の細かい部分を徹底」／弱い所 579 押す・待つの判断の理由）。
//   欄（各欄は「何を」と「どうやって」を分ける）:
//     ① point   押さえた要点（お客様の一通のどの部分＝どの物件のどの点・どの問いに答えたか＝主／後に回した所・答えなかった所）
//     ② bridge  次へのつなぎ（どの部分を細かく書いて次の一歩につなげたか）
//     ③ lead    誘導先（viewing/apply/estimate/ask_send/keep/answer_only/none）
//     ④ appeal  訴求（どの物件のどの点を推したか・推さない番は null）
//     ⑤ latent  潜在意識のカバー（種類で止めず、この物件・この時期・この人の事情で具体に何が気になっているか＋何の事実で先回りしたか）
//     ⑥ point_how 要点の押さえ方（POINT_METHODS）
//     ⑦ trust_how 信頼の作り方（TRUST_METHODS）
//     ＋ push    押す／待つ（理由＝刺さり・時期・物件の残り 等／強さ 強・中・弱）
//   Claude Code が 43通を手で読んだ表: exam-cache/anatomy-seven/seven-claude-43.tsv（リポジトリの外）。
//   ブレインの記録（brain_decision_logs.digest）と比べた結果（43通・記録あり37通）:
//     要点 合う27・ぼやけ5・外れ5／つなぎ 合う18・外れ13／誘導先 合う18・外れ11／訴求 竹内さんが推した8通すべて欄が無い（prop は物件名だけ・どの点かが無い）／
//     潜在 具体で合う3・種類だけ14・外れ18／押さえ方・信頼の作り方 欄そのものが無い（37通すべて）。
//     竹内さんが強く押した4通（1部屋のみ・問い合わせが多い・最短入居・抑えて内覧）はブレインが3通で押していない（1通は記録なし）。
//   使い方: 書き手の設計図にも採点にも、まだ使わない。既定 off（TAKEUCHI_SEVEN_READ=on で書き手への短い注記だけ作れる＝呼ぶ側の配線は試験で悪化0を見てから）。
// テスト: app/lib/__tests__/takeuchi-seven-read.test.ts
import { maskSelfNamesPair } from "./self-name-mask";
import { LEAD_TO, type LeadTo } from "./takeuchi-anatomy-roles";

/** ⑥ 要点の押さえ方（43通で見えた形） */
export const POINT_METHODS = [
  "conclusion_first", // 結論を先に（はい・グレーとなります）
  "assert",           // 言い切る（推奨させて頂きます・オススメです）
  "numbers",          // 数字・日付・期限で示す（3.24%・明日中・11:00〜12:00）
  "name_property",    // 物件名・号室で名指し
  "echo_words",       // お客様の言葉をそのまま拾う・条件を復唱
  "one_change",       // 変わった1点だけ言う（ペット無しのご条件で）
  "weak_first",       // 弱点を先に認めて強みを言う（築浅ではないが…）
  "answer_by_thing",  // 有無を言わず物（物件・見積）で答える
  "reason_fact",      // 理由を物件の事実で言う（敷金礼金がある為）
  "accept_first",     // 先に受ける（全然大丈夫です・大丈夫です）
] as const;
export type PointMethod = typeof POINT_METHODS[number];
/** ⑦ 信頼の作り方 */
export const TRUST_METHODS = [
  "support",       // サポートの姿勢（全力でサポート・ご安心ください）
  "effort",        // こちらの手間を見せる（管理会社に確認・全部屋の見積・私の方で）
  "fact",          // 事実の裏付け（審査の段階・時期の傾向・資料の事実）
  "preempt",       // 先回り（否決なら別の保証会社・昼職にしても年齢で）
  "deadline",      // 期限を切る（明日中・明日ご連絡）
  "kept_promise",  // 前の約束・前の依頼を覚えている・果たす
  "options",       // 選択肢を残す（偶数階なら白・オンライン内見・代理契約）
  "their_side",    // お客様の立場の言葉（1番後悔なく・ご家族に）
  "honest_weak",   // 弱点を正直に言う
  "meet",          // 会う機会を作る（ご挨拶も兼ねて）
  "flexible",      // 都合に合わせる（いつでも・ご都合に合わせて）
] as const;
export type TrustMethod = typeof TRUST_METHODS[number];
export type PushStrength = "strong" | "mid" | "weak";
export type SevenRead = {
  point: { what: string; how: string; skipped: string | null };
  bridge: { what: string; how: string } | null;
  lead: LeadTo | null;
  appeal: { property: string | null; point: string; how: string } | null;
  latent: { what: string; fact: string; how: string } | null;
  point_how: PointMethod[];
  trust_how: TrustMethod[];
  push: { push: boolean; strength: PushStrength | null; reason: string };
};

export const SEVEN_SYSTEM = [
  "あなたは賃貸仲介会社の社長（竹内さん）の LINE の返信1通を、竹内さんの頭の中まで細かく読み解く担当です（文は直さない）。各欄は「何を」と「どうやって」を分けて書く。",
  "① point: お客様の一通のどの部分（どの物件のどの点・どの問い）に答えたか＝主。what＝その部分、how＝どう押さえたか、skipped＝後に回した所・答えなかった所（無ければ null）。",
  "② bridge: どの部分を細かく書いて次の一歩につなげたか（what＝細かく書いた所・how＝どうつないだか）。無ければ null。",
  `③ lead: 次に何へつなげたか（${LEAD_TO.join("/")}）。`,
  "④ appeal: どの物件のどの点を推したか（property＝物件名と号室・point＝推した点・how＝どう推したか）。推していなければ null。",
  "⑤ latent: お客様が言っていない奥の心配・本当の望み。『審査の不安』『費用の不安』のような種類で止めず、この物件で・この時期に・この人の事情で具体に何が気になっているかを書く（例: 今は収入が無いので自分の名義だと落ちて第一候補を逃すのが怖い）。fact＝先回りに使った事実、how＝どう先回りしたか。無ければ null。",
  `⑥ point_how: 要点の押さえ方を一覧から選ぶ（複数可）: ${POINT_METHODS.join("/")}。`,
  `⑦ trust_how: 信頼の作り方を一覧から選ぶ（複数可）: ${TRUST_METHODS.join("/")}。`,
  "push: 内覧・申込・見積へ押したか（true）、お客様の動きを待ったか・探す側に戻ったか（false）。strength＝strong（推奨・抑えましょう・キャンセル料の線まで言う）/mid（如何でしょうか・時間枠を出す）/weak（お気に召されましたら・ご査収）/押していなければ null。reason＝その判断の理由（刺さり・時期・物件の残り・お客様の言葉 等・具体に）。",
  "名前は YUMA、伏せた所は〈〉のまま。推測で事実を足さない。各文字列は60字以内。出力は JSON だけ: {\"point\":{\"what\":\"…\",\"how\":\"…\",\"skipped\":null},\"bridge\":{\"what\":\"…\",\"how\":\"…\"},\"lead\":\"…\",\"appeal\":null,\"latent\":{\"what\":\"…\",\"fact\":\"…\",\"how\":\"…\"},\"point_how\":[\"…\"],\"trust_how\":[\"…\"],\"push\":{\"push\":false,\"strength\":null,\"reason\":\"…\"}}",
].join("\n");

/** 読み手に渡すのは伏せ済みの物だけ（申込の書類以降は呼ぶ側で turn-application-gate で外す）。名乗った本名は self-name-mask で伏せる */
export function sevenPrompt(o0: { maskedCustomer: string | null; maskedBody: string; scene: string; situation?: string | null }): string {
  const sm = maskSelfNamesPair(o0.maskedCustomer, o0.maskedBody);
  return `## 場面\n${o0.scene}\n\n${o0.situation ? `## その番の時点の状況（伏せ済み）\n${o0.situation.slice(0, 600)}\n\n` : ""}## お客様の発言（伏せ済み）\n${(sm.customer ?? "（こちらから送った番）").slice(0, 400)}\n\n## 竹内さんの返信（伏せ済み）\n${sm.staff.slice(0, 600)}`;
}

const s60 = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : null);
const pick = <T extends string>(xs: unknown, all: readonly T[]): T[] => (Array.isArray(xs) ? [...new Set(xs.filter((x): x is T => typeof x === "string" && (all as readonly string[]).includes(x)))] : []);
/** 読み取り（一覧の外は捨てる・要点が無ければ null） */
export function parseSevenRead(text: string): SevenRead | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  const o = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
  const p = o(j.point);
  if (!p || !s60(p.what)) return null;
  const b = o(j.bridge), a = o(j.appeal), l = o(j.latent), pu = o(j.push);
  const st = pu?.strength;
  return {
    point: { what: s60(p.what)!, how: s60(p.how) ?? "", skipped: s60(p.skipped) },
    bridge: b && s60(b.what) ? { what: s60(b.what)!, how: s60(b.how) ?? "" } : null,
    lead: typeof j.lead === "string" && (LEAD_TO as readonly string[]).includes(j.lead) ? (j.lead as LeadTo) : null,
    appeal: a && s60(a.point) ? { property: s60(a.property), point: s60(a.point)!, how: s60(a.how) ?? "" } : null,
    latent: l && s60(l.what) ? { what: s60(l.what)!, fact: s60(l.fact) ?? "", how: s60(l.how) ?? "" } : null,
    point_how: pick(j.point_how, POINT_METHODS),
    trust_how: pick(j.trust_how, TRUST_METHODS),
    push: { push: pu?.push === true, strength: pu?.push === true && (st === "strong" || st === "mid" || st === "weak") ? st : null, reason: s60(pu?.reason) ?? "" },
  };
}

/** 種類だけの潜在（『審査の不安』『費用の不安』で止まった物）か。具体＝物件・時期・事情のどれかの言葉が入る */
export function latentIsConcrete(what: string | null | undefined): boolean {
  const t = String(what ?? "").trim();
  if (Array.from(t).length < 12) return false;
  if (/^(?:審査|費用|初期費用|立地|設備|日程|内覧|契約)?の?(?:不安|心配|迷い)$/.test(t)) return false;
  return /[＝=→]|のに|ので|だから|ため|けど|でも|まで|間に|今は|この|号室|月|名義|収入|家族|子|仕事|前の|せっかく|待つ|埋ま|逃す|取られ/.test(t);
}

/** ブレインの記録（brain_decision_logs.digest の一部）。どの欄を持っていたかを数える（決定論の網・判断はしない） */
export type BrainDigestLite = { q?: string[] | null; dir?: string | null; cs?: string | null; act?: string | null; mode?: string | null; prop?: string | null; concern?: string | null; ms?: string | null; tl?: string | null };
export type SevenGap = { field: "point" | "bridge" | "lead" | "appeal" | "latent" | "point_how" | "trust_how" | "push"; state: "missing" | "kind_only" };
/** 竹内さんの読み（SevenRead）にあって、ブレインの記録に欄が無い・種類だけの物 */
export function brainSevenGaps(tk: SevenRead, b: BrainDigestLite | null): SevenGap[] {
  const out: SevenGap[] = [];
  if (!b) return (["point", "bridge", "lead", "appeal", "latent", "point_how", "trust_how", "push"] as const).map((field) => ({ field, state: "missing" as const }));
  if (!(b.q && b.q.length) && !b.dir) out.push({ field: "point", state: "missing" });
  if (!b.cs && !b.dir) out.push({ field: "bridge", state: "missing" });
  if (!b.act && !b.mode) out.push({ field: "lead", state: "missing" });
  // 訴求: ブレインは物件名（prop）だけ＝推した点の欄が無い
  if (tk.appeal) out.push({ field: "appeal", state: b.prop ? "kind_only" : "missing" });
  if (tk.latent) { const bl = [b.concern, b.tl].filter(Boolean).join(" "); out.push(...(bl ? (latentIsConcrete(bl) ? [] : [{ field: "latent" as const, state: "kind_only" as const }]) : [{ field: "latent" as const, state: "missing" as const }])); }
  // ⑥⑦・押す/待つの理由はブレインの記録に欄そのものが無い
  if (tk.point_how.length) out.push({ field: "point_how", state: "missing" });
  if (tk.trust_how.length) out.push({ field: "trust_how", state: "missing" });
  if (tk.push.push) out.push({ field: "push", state: "missing" });
  return out;
}

/** 既定 off。入れる TAKEUCHI_SEVEN_READ=on */
export function sevenReadOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TAKEUCHI_SEVEN_READ ?? "").trim().toLowerCase() === "on";
}

/**
 * 書き手の設計図に足す短い注記（近い過去の竹内さんの番の読み＝手本の『なぜ』）。off なら null。
 *   どこに: compose-blueprint の手本の行の後ろ（作業員6 の ComposeIntent が受ける）。数は呼ぶ側で1〜2通まで。文は写させない（形と理由だけ）。
 */
export function sevenBlueprintNote(r: SevenRead | null, env?: Record<string, string | undefined>): string | null {
  if (!r || !sevenReadOn(env)) return null;
  const L: string[] = [`要点: ${r.point.what}（${r.point.how}）${r.point.skipped ? `／後に回した: ${r.point.skipped}` : ""}`];
  if (r.latent) L.push(`奥の心配: ${r.latent.what} → ${r.latent.how}（使った事実: ${r.latent.fact}）`);
  if (r.appeal) L.push(`推した点: ${r.appeal.property ?? "物件"}の${r.appeal.point}`);
  if (r.bridge) L.push(`つなぎ: ${r.bridge.what}（${r.bridge.how}）`);
  L.push(`押す/待つ: ${r.push.push ? `押す(${r.push.strength ?? "?"})` : "待つ"}・理由 ${r.push.reason}`);
  if (r.point_how.length || r.trust_how.length) L.push(`押さえ方 ${r.point_how.join(",")}／信頼 ${r.trust_how.join(",")}`);
  return L.join("\n");
}
