// screening-phone-material.ts — 審査面で怪しい話（名義貸し・他人名義）の番の材料の1行（純関数・既定 off）
//
// 2026-10-27 竹内さんの答え（苦手な問題① q093「ここまだ空いてますか／お客さんの名義貸してくれるみたいで／新着も」）:
//   正解の AIX【電話をかける】が合っている。名義貸しなど審査面で怪しい話は、電話で状況と進め方を打ち合わせる。
//   ブレインは毎回 AIX【物件確認した】（空きの確認）を出していた。材料の phone_call の説明は「お客様が電話で話したい時」だけで、
//   こちらから電話で打ち合わせる番があることがブレインに届いていなかった（原因①＝材料が届いていない）。
//   通常の審査の相談（保証人がいない・収入が不安など）は 10/20 の決定（設計知見 84519320・物件確認した→審査について（ご相談））のまま＝この行の外。
// 網（候補を拾うだけ・決めるのはブレイン）: 名義を貸す・借りる・他人名義（本人以外の名義で契約する話）。
// 入れる: SCREENING_PHONE_LINE=on

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export function screeningPhoneLineEnabled(env: Env = envOf()): boolean {
  return (env.SCREENING_PHONE_LINE ?? "").trim().toLowerCase() === "on";
}

// 「名義貸してくれる」「名義を貸す」「名義借り」「他人名義」「〇〇の名義で契約」
// 過去の出来事の打ち明け（「以前友人に名義を貸した際に飛ばれて」＝審査落ちの理由・q036）は外す（竹内さんは探し方と交渉の約束にした）
const NAME_LENDING_RE = /名義(?:を|は|も)?(?:貸|借|かし|かり)(?!(?:し|り)?た)|名義貸し(?!た)|名義借り|他人(?:の)?名義|(?:親|友人|友達|知人|彼氏|彼女|会社|お客さん)の名義で/;

/** 今の番のお客様の発言が名義貸し・他人名義の話か（網） */
export function nameLendingTurn(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  return NAME_LENDING_RE.test(t);
}

/** LLM の前の今の番の材料の行（網に掛かった番だけ・スイッチ off なら空） */
export function screeningPhoneTurnLine(text: string | null | undefined, env: Env = envOf()): string {
  if (!screeningPhoneLineEnabled(env) || !nameLendingTurn(text)) return "";
  return "【今の番（材料・竹内さんの決定 10/27）】お客様の今の発言に、名義を貸す・借りる・他人名義で契約する話がある。"
    + "名義貸しなど審査面で怪しい話は、竹内さんは文で答えず、電話で状況と進め方を打ち合わせる＝AIX【電話をかける】（phone_call）を送る番"
    + "（同じ発言の空きの確認・新着の依頼は電話の中で一緒に話す）。"
    + "ただし通常の審査の相談（保証人がいない・収入が不安・審査に通るか心配）は電話にしない（物件確認した→審査について（ご相談））。"
    + "本当に審査面で怪しい話か（ただの言い間違い・名義の変更の手続きの質問ではないか）はあなたが会話から決める。";
}
