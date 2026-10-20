// app/lib/send-account.ts — LINE の送り先のアカウント（スモラ・イエヤス・ギガ賃貸）を「会話」で決める（純関数・画面からも読む）
//
// 2026-10-20 竹内さん（P1 f9d261d4）「AIX ツールから物件送る際にアカウントが別の場合、そこのアカウントから送れるように。
//   今お客さんがアカウントでかぶっていて、AIX ツールから物件送る際にギガ賃貸のお客さんがイエヤスに送られてしまうなどのバグが起きる事がある。
//   ちゃんとアカウントごとに間違えないように、ギガ賃貸のアカウントの AIX ツールから送る場合はギガ賃貸に飛ぶようにする」
//
// 【根っこ】
//   ① 売上サポ（property_pickups）の行は、拡張がお客様（property_customers）の id だけを渡すと、送り先の会話を
//      「そのお客様に結んだ会話のうち updated_at が一番新しい物」で決めていた（property-pickups-server.resolveConversationId・
//      customer-family.parentConversationFor）。同じ人がスモラとイエヤスの両方にいる（イエヤスとスモラは LINE の id も同じ）と、
//      プロフィールの更新・友だち追加などで updated_at が動いた方に結ばれ、話していないアカウントに物件が届いた。
//   ② 送る API（send-line-message・予約の送信）は、会話の id を受け取っていても、アカウントは画面から来た値を信じ、
//      会話のアカウントと合っているかを見ていなかった（来なければ LINE の id で line_contacts を引く＝同じ id が2つのアカウントにある）。
// 【直し】
//   ・送る直前の確かめ（checkSendAccount）: 会話のアカウントと送ろうとしているアカウントが違えば送らない。アカウントは会話の物を使う。
//   ・お客様 → 会話の選び方（pickConversationForCustomer）: 「お客様が最後に話した会話」を選ぶ（updated_at は使わない）。
//     2つ以上のアカウントにまたがる時は ambiguous を返し、画面（AIX ツール）で送る前に確かめる。
//   戻す: SEND_ACCOUNT_GATE=off（送る直前の確かめ）／ PICKUP_CONV_BY_CUSTOMER_MSG=off（会話の選び方を旧の updated_at に）

export type AccountKey = "sumora" | "ieyasu" | "giga" | "hasu";

const KEYS: readonly AccountKey[] = ["sumora", "ieyasu", "giga", "hasu"];
const JA_TO_KEY: Record<string, AccountKey> = { "スモラ": "sumora", "イエヤス": "ieyasu", "ギガ賃貸": "giga", "蓮": "hasu", "蓮産業": "hasu" };
const KEY_TO_LABEL: Record<AccountKey, string> = { sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ賃貸", hasu: "蓮産業" };

/** 英語のキー・日本語の名前 → キー（分からなければ null） */
export function toAccountKey(a: string | null | undefined): AccountKey | null {
  const s = String(a ?? "").trim();
  if (!s) return null;
  if ((KEYS as readonly string[]).includes(s)) return s as AccountKey;
  return JA_TO_KEY[s] ?? null;
}

/** 画面に出す名前（分からなければ「不明」） */
export function accountLabelOf(a: string | null | undefined): string {
  const k = toAccountKey(a);
  return k ? KEY_TO_LABEL[k] : "不明";
}

export type SendAccountCheck =
  | { ok: true; key: AccountKey | null; source: "conversation" | "requested" | "none" }
  | { ok: false; reason: "account_mismatch"; message: string; requested: AccountKey; conversation: AccountKey };

/**
 * 送る直前のアカウントの確かめ。
 *   会話のアカウントが分かる → 送ろうとしているアカウント（画面・予約の行）が違えば止める。合っていれば会話のアカウントで送る。
 *   会話のアカウントが分からない（会話の id が無い古い呼び出し）→ 送ろうとしているアカウント（今まで通り）。
 */
export function checkSendAccount(requested: string | null | undefined, conversationAccount: string | null | undefined): SendAccountCheck {
  const req = toAccountKey(requested);
  const conv = toAccountKey(conversationAccount);
  if (conv && req && conv !== req) {
    return {
      ok: false, reason: "account_mismatch", requested: req, conversation: conv,
      message: `この会話は ${KEY_TO_LABEL[conv]} の LINE ですが、${KEY_TO_LABEL[req]} から送ろうとしました。別のアカウントのお客様に届かないよう送信を止めました（画面を開き直してから送ってください）`,
    };
  }
  if (conv) return { ok: true, key: conv, source: "conversation" };
  if (req) return { ok: true, key: req, source: "requested" };
  return { ok: true, key: null, source: "none" };
}

/** 送る直前の確かめを使うか（既定は使う） */
export function sendAccountGateEnabled(env: Record<string, string | undefined>): boolean {
  return (env.SEND_ACCOUNT_GATE ?? "").trim().toLowerCase() !== "off";
}

/** お客様 → 会話の選び方を「お客様が最後に話した会話」にするか（既定は使う） */
export function pickConvByCustomerMsgEnabled(env: Record<string, string | undefined>): boolean {
  return (env.PICKUP_CONV_BY_CUSTOMER_MSG ?? "").trim().toLowerCase() !== "off";
}

export type CustomerConvLite = {
  id: string;
  account: string | null;
  updated_at?: string | null;
  /** その会話でお客様が最後に話した時刻（無ければ null） */
  last_customer_at?: string | null;
};

export type CustomerConvPick = { id: string | null; ambiguous: boolean; accounts: AccountKey[] };

const ms = (s: string | null | undefined): number => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : -Infinity; };

/**
 * 1人のお客様（property_customers）に結んだ会話から、送り先の会話を1つ選ぶ。
 *   ① お客様が最後に話した会話（last_customer_at が新しい物）② 同じなら updated_at が新しい物。
 *   ambiguous: 2つ以上のアカウントにまたがる（画面で送る前に確かめる・ログに残す）
 */
export function pickConversationForCustomer(convs: ReadonlyArray<CustomerConvLite>): CustomerConvPick {
  const list = convs.filter((c) => c && c.id);
  const accounts = [...new Set(list.map((c) => toAccountKey(c.account)).filter((k): k is AccountKey => !!k))];
  if (list.length === 0) return { id: null, ambiguous: false, accounts };
  const sorted = [...list].sort((a, b) => (ms(b.last_customer_at) - ms(a.last_customer_at)) || (ms(b.updated_at) - ms(a.updated_at)) || a.id.localeCompare(b.id));
  return { id: sorted[0].id, ambiguous: accounts.length > 1, accounts };
}

/** 送る前の確かめの文（同じお客様が2つ以上のアカウントにいる時）。送り先のアカウントをはっきり書く */
export function multiAccountConfirmMessage(target: string | null | undefined, accounts: ReadonlyArray<string | null | undefined>): string | null {
  const keys = [...new Set(accounts.map((a) => toAccountKey(a)).filter((k): k is AccountKey => !!k))];
  if (keys.length < 2) return null;
  const t = toAccountKey(target);
  const list = keys.map((k) => KEY_TO_LABEL[k]).join("・");
  return `このお客様は ${list} の${keys.length}つのアカウントに LINE があります。\n${t ? `【${KEY_TO_LABEL[t]}】` : "（アカウント不明）"}の会話に送ります。よろしいですか？\n（違うアカウントで話している時はキャンセルして、そのアカウントの会話から送ってください）`;
}
