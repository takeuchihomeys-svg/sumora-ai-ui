// app/lib/next-send-link.ts — 統括の next_send の「つながり」: 前のどの通のどの項目を受けて次を送るか・つながりの種類・なぜ・根拠（純関数・DB/LLM なし）
//   2026-11-19 作業員M（統括役の割り振り・竹内さん 11/15「前の返信の内容・前に送った文を把握する部分が弱い可能性」「次に送る事の関連性も含めて具体的に強化」）。
//   名前は作業員L の meta.situation_now とそろえる: our_items の item_id（前に送った文の項目）・promises_open の promise_id（開いている約束）・
//   asks の ask_id（要件の帳面 askIdOf）・sent の sent_id。次に送る物の中身は決めない（決めるのはブレインと統括）＝ここは「受け先」と「つながりの種類」の記録だけ。
//   スイッチ NEXT_SEND_LINK（11/19 から既定 shadow＝meta.next_send_link と統括の指示書の欄に記録だけ／off＝何もしない）。書き手・道には渡さない
//   テスト: app/lib/__tests__/next-send-link.test.ts

type Env = Record<string, string | undefined>;
export type NextSendLinkMode = "off" | "shadow";
export function nextSendLinkMode(env: Env = typeof process !== "undefined" ? process.env : {}): NextSendLinkMode {
  // 2026-11-19 統括役の決定: 既定 shadow（記録だけ・書き手と道には渡さない）。止める NEXT_SEND_LINK=off
  return (env.NEXT_SEND_LINK ?? "").trim().toLowerCase() === "off" ? "off" : "shadow";
}

/** つながりの種類（引き継ぎの7つ） */
export type LinkKind =
  | "answer_then_advance"  // 答えを受けて進める（こちらが聞いた事にお客様が答えた）
  | "keep_promise"         // 約束を果たす（開いている約束・前の番の約束して結果がまだの要件）
  | "invite_reply"         // 誘いの返事を受ける（内覧・申込の扉への返事）
  | "reshape_no_reply"     // 返事が無いので形を変える（期限を過ぎた問い・誘い・送った物件への反応が無い）
  | "same_property"        // 同じ物件の続き
  | "other_property"       // 別の物件に移る
  | "new_topic";           // 新しい話題
export const LINK_KIND_JA: Record<LinkKind, string> = {
  answer_then_advance: "答えを受けて進める", keep_promise: "約束を果たす", invite_reply: "誘いの返事を受ける", reshape_no_reply: "返事が無いので形を変える",
  same_property: "同じ物件の続き", other_property: "別の物件に移る", new_topic: "新しい話題",
};

export type LinkRef = { item_id?: string; promise_id?: string; ask_id?: string; sent_id?: string };
export type NextSendLink = { kind: LinkKind; refs: LinkRef[]; why: string; basis: string[] };

type OurItem = { item_id: string; kind: string; label?: string; text?: string; answered: boolean | null; at?: string; expect?: string };
type Promise_ = { promise_id: string; kind: string; object: string | null; due_h?: number | null };
type Sent = { sent_id: string; kind: string; props?: string[] };
type Meta = Record<string, unknown>;

const RESULT_AIX = /^(?:property_check_result|estimate_sheet|property_send|property_recommendation|acknowledge_check)/;
const VIEW_AIX = /^(?:viewing_invite|meeting_place|greeting_viewing)/;

/** 統括の next_send のつながりを決める（純関数）。材料が無ければ null */
export function nextSendLinkOf(meta: Meta | null | undefined): NextSendLink | null {
  if (!meta) return null;
  const sn = meta.situation_now as { v?: number; our_items?: OurItem[]; promises_open?: Promise_[]; sent?: Sent[] } | undefined;
  const carry = meta.ask_carry as { open?: string[]; promised?: string[]; items?: Array<{ ask_id: string; state: string }> } | undefined;
  const action = typeof meta.action === "string" && meta.reply_mode !== "auto_reply" ? meta.action : "";
  const cp = meta.current_property as { name?: string } | string | null | undefined;
  const curProp = typeof cp === "string" ? cp : cp?.name ?? null;
  const items = sn?.v === 1 ? sn.our_items ?? [] : [];
  const promises = sn?.v === 1 ? sn.promises_open ?? [] : [];
  const sent = sn?.v === 1 ? sn.sent ?? [] : [];
  const basis: string[] = [];

  // ① 約束を果たす: 開いている約束があり、最終の AIX が結果を運ぶ AIX（確認・見積・物件を送る）
  if (RESULT_AIX.test(action) && (promises.length || carry?.promised?.length)) {
    const refs: LinkRef[] = [...promises.slice(0, 3).map((p) => ({ promise_id: p.promise_id })), ...(carry?.promised ?? []).slice(0, 3).map((a) => ({ ask_id: a }))];
    basis.push(promises.length ? `開いている約束 ${promises.length}（${promises.slice(0, 2).map((p) => p.kind).join("・")}）` : "", carry?.promised?.length ? `前の番の約束して結果がまだの要件 ${carry.promised.length}` : "", `最終の AIX ${action}`);
    return { kind: "keep_promise", refs, why: "前に約束した事の結果を、結果を運ぶ AIX で返す番", basis: basis.filter(Boolean) };
  }
  // ② 誘いの返事を受ける: 前の通の誘い（内覧・申込の扉）が答え済みになった＝お客様が誘いに返した
  const invites = items.filter((x) => x.kind === "invite");
  const lastInvite = invites[invites.length - 1];
  if (lastInvite && lastInvite.answered === true && (VIEW_AIX.test(action) || /application/.test(action) || !action)) {
    return { kind: "invite_reply", refs: [{ item_id: lastInvite.item_id }], why: `前の通の誘い（${lastInvite.label ?? "誘い"}）にお客様が返した番`, basis: [`our_items ${lastInvite.item_id} answered`, action ? `最終の AIX ${action}` : "返信"] };
  }
  // ③ 答えを受けて進める: こちらが聞いた事（question）にお客様が答えた
  const qs = items.filter((x) => x.kind === "question");
  const lastQ = qs[qs.length - 1];
  if (lastQ && lastQ.answered === true) {
    return { kind: "answer_then_advance", refs: [{ item_id: lastQ.item_id }], why: "こちらが聞いた事にお客様が答えた＝答えを受けて次の段へ", basis: [`our_items ${lastQ.item_id} answered`] };
  }
  // ④ 返事が無いので形を変える: 期限を過ぎて返事の無い問い・誘い・送った物件
  const unanswered = items.filter((x) => x.answered === false && (x.kind === "question" || x.kind === "invite" || x.kind === "property"));
  if (unanswered.length && !(carry?.open?.length)) {
    const u = unanswered[unanswered.length - 1];
    return { kind: "reshape_no_reply", refs: [{ item_id: u.item_id }], why: `前の通の${u.kind === "property" ? "送った物件" : u.kind === "invite" ? "誘い" : "問い"}に返事が無い＝同じ形で重ねず形を変える`, basis: [`our_items ${u.item_id} unanswered`] };
  }
  // ⑤ 物件の続き: 前に送った物件と今の物件
  const lastProps = [...sent].reverse().find((s) => (s.props ?? []).length)?.props ?? [];
  if (curProp && lastProps.length) {
    const same = lastProps.some((p) => p && (p.includes(curProp.slice(0, 6)) || curProp.includes(p.slice(0, 6))));
    const ref = [...sent].reverse().find((s) => (s.props ?? []).length);
    return { kind: same ? "same_property" : "other_property", refs: ref ? [{ sent_id: ref.sent_id }] : [], why: same ? "前に送った物件の続きの番" : "前に送った物件と別の物件に移った番", basis: [`current_property ${curProp.slice(0, 20)}`, `前に送った物件 ${lastProps.slice(0, 2).join("・")}`] };
  }
  // ⑥ 前の番のまだの要件が残っている（答えていない要件を受ける）
  if (carry?.open?.length) return { kind: "answer_then_advance", refs: carry.open.slice(0, 3).map((a) => ({ ask_id: a })), why: "前の番でまだ答えていない要件を受ける", basis: [`前の番のまだの要件 ${carry.open.length}`] };
  // ⑦ 新しい話題
  if (items.length || sent.length) return { kind: "new_topic", refs: [], why: "前の通の項目に当たらない新しい話題", basis: [`our_items ${items.length}・sent ${sent.length}`] };
  return null;
}

/** 試験・記録の短い印（例 "keep_promise:2"） */
export const nextSendLinkDigest = (l: NextSendLink | null | undefined): string | null => (l ? `${l.kind}:${l.refs.length}` : null);
