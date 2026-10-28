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

// 2026-10-28 竹内さんの決定（設計知見 701e2665・咲「相談なのですが、今、水商売をしていて…審査通るように職場の案内…」）:
//   お客様から審査について相談があった時は、段階を問わず AIX【電話をかける】で状況と進め方を打ち合わせる（こちらから審査の電話を持ち掛けるのは申込の段階の熱量が高い時だけ）。
//   下の行の「通常の審査の相談は電話にしない」（10/27・84519320 の線）と食い違う → SCREENING_CONSULT_PHONE=on の時は新しい決定（10/28）で書く。
//   網は狭く（本番90日の「審査」を含むお客様の通211を読んで決めた）: 同じ文の中で「審査」と「相談」が並ぶ・審査のための職場の案内を頼む時だけ。
//   職業（夜職・水商売・ホスト）を言っただけ・初回の条件の紙（【その他ご要望】）は掛けない＝竹内さんは初回はピックアップ・返信で答えていた（5f0befb7・4a79a43e・60547092・969f0162・d88bc551 10/17）。
//   掛かる: 咲 79f97cea（相談なのですが…水商売…審査通るように職場の案内）・d3a56a97（審査のことで職業のことを相談…→竹内さん AIX 電話）。
//   掛けない: a0cfe4c4（審査通過のお礼。入居日のご相談＝別の文）・2f352488（「相談しやすい物件を紹介」＝探す条件）・ac34b364（在籍確認がいつ来るか＝手続きの質問）・試験の q021・q054・q117・q186（竹内さんが電話にしていない）。
export function screeningConsultPhoneEnabled(env: Env = envOf()): boolean {
  // 10/29 既定 on（試験 consult-phone-on 6問×3 悪化0・咲の再生で AIX 内覧＋電話に分かれた）。止める時は SCREENING_CONSULT_PHONE=off
  return (env.SCREENING_CONSULT_PHONE ?? "on").trim().toLowerCase() !== "off";
}
const SCREENING_RE = /審査/;
const WORKPLACE_REQ_RE = /(?:職場|勤務先|勤め先)の?(?:案内|紹介)/;
const CONDITION_SHEET_RE = /【その他ご要望|【ご希望の駅徒歩/;
/** 今の番のお客様の発言が審査の相談か（網・狭く） */
export function screeningConsultTurn(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!SCREENING_RE.test(t) || CONDITION_SHEET_RE.test(t)) return false;
  if (WORKPLACE_REQ_RE.test(t)) return true;
  return t.split(/[。！？!?]/).some((x) => /審査/.test(x) && /相談/.test(x) && !/相談(?:し|でき)やす|物件|紹介|ピックアップ/.test(x));
}

/** LLM の前の今の番の材料の行（網に掛かった番だけ・スイッチ off なら空） */
export function screeningPhoneTurnLine(text: string | null | undefined, env: Env = envOf()): string {
  const consultOn = screeningConsultPhoneEnabled(env);
  if (consultOn && screeningConsultTurn(text) && !(screeningPhoneLineEnabled(env) && nameLendingTurn(text))) {
    return "【今の番（材料・竹内さんの決定 10/28）】お客様の今の発言は審査についての相談（職業の事情・職場の案内・在籍確認 等）。"
      + "竹内さんは、お客様から審査の相談があった時は段階を問わず文で答えず、電話で状況と進め方を打ち合わせる＝AIX【電話をかける】（phone_call）を送る番"
      + "（返信で『審査に通りやすい保証会社中心に』『審査面は全力でサポート』『管理会社に確認』と済ませない。同じ発言の他の事は電話の中で一緒に話す）。"
      + "本当に審査の相談か（審査の期間・流れ・必要書類の質問は返信で説明する番）はあなたが会話から決める。";
  }
  if (!screeningPhoneLineEnabled(env) || !nameLendingTurn(text)) return "";
  return "【今の番（材料・竹内さんの決定 10/27）】お客様の今の発言に、名義を貸す・借りる・他人名義で契約する話がある。"
    + "名義貸しなど審査面で怪しい話は、竹内さんは文で答えず、電話で状況と進め方を打ち合わせる＝AIX【電話をかける】（phone_call）を送る番"
    + "（同じ発言の空きの確認・新着の依頼は電話の中で一緒に話す）。"
    + (consultOn
      ? "お客様から審査の相談（職業・収入・名義・職場の案内 等）があった時も電話で打ち合わせる（10/28 竹内さん）。"
      : "ただし通常の審査の相談（保証人がいない・収入が不安・審査に通るか心配）は電話にしない（物件確認した→審査について（ご相談））。")
    + "本当に審査面で怪しい話か（ただの言い間違い・名義の変更の手続きの質問ではないか）はあなたが会話から決める。";
}
