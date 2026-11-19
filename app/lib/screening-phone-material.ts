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

// 2026-11-15 作業員H（弱い所 aix:screening-consult-phone-call・統括役の頼み）: 竹内さんが審査の相談で AIX【電話をかける】を選んだ本番の番の型。
//   上の網（「審査」と「相談」が同じ文）に掛からない言い方で、竹内さんが電話にしていた（本番 90日の「審査」を含むお客様の通 62 を読んだ）:
//     fff5b6a3 11/08「彼氏との同棲で家探してて、ここ住みたかったんですけど、彼氏名義で審査落ちててここって厳しいですよね？？」→ 竹内さん AIX【電話】（ブレインは物件確認の2段）
//     732692f2 09/28「ここの物件、日本セーフティと全保連だと思うのですが。日本セーフティが通らなさそうみたいで。審査面が心配なんですよ。」→ 竹内さん AIX【電話】
//   型＝「この物件（ここ・この物件・〇〇号室）」で、お客様自身の審査の傷（落ちた・通らなさそう・否決・ブラック・滞納）を言い、通るか（厳しい・大丈夫・心配）を聞く。
//   掛けない（竹内さん・スタッフが電話にしていない本番の言い方）: 「ここって私、審査的には通りそうですかね」（傷を言っていない＝AIX【保証会社について】a0c5ecf0）・
//     「ここの物件が審査厳しいって聞いたんですけど」（物件の噂）・「こっちの審査落ちたら」（先の話）・「前の物件が審査落ちした為新たに物件を紹介」（探す依頼）・
//     「1番手の保証会社のところは審査通りませんでした」（物件の指し方が無い・q117）・初回の条件の紙。
//   網は候補だけ（決めるのはブレイン）。既定 off（SCREENING_RISK_HERE_PHONE=on で入る）。根の決まりは 10/28 竹内さんの決定 701e2665（お客様から審査の相談→段階を問わず電話）
export function screeningRiskHerePhoneEnabled(env: Env = envOf()): boolean {
  return (env.SCREENING_RISK_HERE_PHONE ?? "").trim().toLowerCase() === "on";
}
const HERE_PROPERTY_RE = /ここ|この(?:物件|お?部屋|マンション)|こちらの(?:物件|お?部屋)|\d{3,4}号室/;
const OWN_SCREENING_SCAR_RE = /審査(?:に|が|で|は)?落ち(?:て|た|まし|ちゃ)|落ちて(?:て|る|い)|通らな(?:さそう|かった)|通りませんでした|否決|ブラック|ブラリス|滞納/;
const ASK_PASS_RE = /厳し|通る|通り|大丈夫|無理|難し|心配|不安|いけ/;
/** 今の番のお客様の発言が「この物件で、自分の審査の傷を言って通るか聞く」相談か（網・狭く） */
export function screeningRiskHereTurn(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!/審査/.test(t) || CONDITION_SHEET_RE.test(t)) return false;
  if (/落ちたら|通らなかったら|否決になったら/.test(t) && !/落ちて(?:て|る)|落ちた(?:ので|から|んで|けど)/.test(t)) return false;
  return HERE_PROPERTY_RE.test(t) && OWN_SCREENING_SCAR_RE.test(t) && ASK_PASS_RE.test(t);
}

/** LLM の前の今の番の材料の行（網に掛かった番だけ・スイッチ off なら空） */
export function screeningPhoneTurnLine(text: string | null | undefined, env: Env = envOf()): string {
  const consultOn = screeningConsultPhoneEnabled(env);
  if (screeningRiskHerePhoneEnabled(env) && !screeningConsultTurn(text) && !(screeningPhoneLineEnabled(env) && nameLendingTurn(text)) && screeningRiskHereTurn(text)) {
    return "【今の番（材料・竹内さんの決定 10/28 の型）】お客様の今の発言は、この物件について、お客様自身の審査の傷（審査に落ちた・通らなさそう・ブラック・滞納 等）を言って、通るかを聞く審査の相談。"
      + "竹内さんは、お客様から審査の相談があった時は段階を問わず文で答えず、電話で状況と進め方を打ち合わせる＝AIX【電話をかける】（phone_call）を送る番"
      + "（本番: 竹内さん 11/08「彼氏名義で審査落ちててここって厳しいですよね」・09/28「日本セーフティが通らなさそう…審査面が心配」→ どちらも AIX【電話】）。"
      + "返信で『審査に通りやすい保証会社中心に』『審査面は全力でサポート』と済ませない・保証会社の確認（物件確認）の約束にしない。同じ発言の空きの確認は電話の中で一緒に話す。"
      + "傷を言わずに『ここって審査通りそうですか』と聞くだけなら保証会社の説明（AIX【保証会社について】）の番＝本当に傷を言った相談かはあなたが会話から決める。";
  }
  if (consultOn && screeningConsultTurn(text) && !(screeningPhoneLineEnabled(env) && nameLendingTurn(text))) {
    return "【今の番（材料・竹内さんの決定 10/28）】お客様の今の発言は審査についての相談（職業の事情・職場の案内・在籍確認 等）。"
      + "竹内さんは、お客様から審査の相談があった時は段階を問わず文で答えず、電話で状況と進め方を打ち合わせる＝AIX【電話をかける】（phone_call）を送る番"
      + "（返信で『審査に通りやすい保証会社中心に』『審査面は全力でサポート』『管理会社に確認』と済ませない）。"
      // 2026-11-12 竹内さんの決定（KB 030882c3・q406 咲 79f97cea）: 同じ発言に誘導への答え（内覧の候補日への日の答え 等）がある時は、
      //   先に AIX【待ち合わせ場所】で日を確定し、その後に AIX【電話をかける】で審査の相談。旧の「同じ発言の他の事は電話の中で一緒に話す」は、
      //   日の答えまで電話にまとめさせ q406 が off でも 1/3 で電話だけになっていた（作業員14）。
      + "同じ発言にこちらの誘いへの答え（内覧の候補日への日の答え 等）がある時は、その AIX（日の答えなら待ち合わせ場所）を先に送り、審査の電話はその後の2つ目の AIX にする。誘いへの答えが無い時だけ、同じ発言の他の事は電話の中で一緒に話す。"
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
