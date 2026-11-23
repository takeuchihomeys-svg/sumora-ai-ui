// app/lib/aix-catalog-map.ts — AIX のボタンごとの「届ける情報の種類・押す条件・押さない時・近いボタンとの分け方」の表（純関数・文字列だけ）
//
// 作業員21・2026-11-12（竹内さん「返信か AIX かの判断は実際は簡単な部分。AIX が何に該当するか分かれば AIX で送れるようになる」・統括役の依頼）。
// 親 P0 ca55d42b・P1 03bd2c71・4b744a33。情報の種類 K1〜K16 は 作業員21 の情報の種類の表（brain-info-kind.ts の11行を16に分けた物）と1対1。
// なぜ: ブレインに渡す一覧は ①brain-core の AIX_CAPABILITY_MAP（ボタンが何を生成するか・古い説明が混じる）と ②aix-catalog の catalogBlockForBrain（ボタン×ピッカー）の
//   2か所で、同じボタンの説明が食い違う所があった（例: acknowledge_check が同じ指示文で「お客様あてに代表確認を送る」と「お客様宛てではない・選ばない」の両方）。
//   ここでは「そのボタンはどの種類の情報を届けるか」を1か所に持ち、catalogBlockForBrain の各ボタンの頭の行をこの表から作る。
// 置き方（道を引っぱらない）: 書くのは事実の確かめだけ（届ける情報／手元に有るか／近いボタンとの違い）。「迷ったら AIX」「押す」「次の一手」は書かない。
//   「押さない時」は AIX_DECISION_ORDER の②③（材料で答えられる＝返信／結果がまだ無い＝約束の返信）と同じ向き。AIX_CAPABILITY_MAP の文は触らない
//   （作業員19 の BRAIN_PROMPT_RULES_1112 が同じ文を差し替えるため・食い違わない）。
// スイッチ: BRAIN_AIX_CATALOG_MAP（既定 off＝catalogBlockForBrain は1文字も変わらない・on の時だけ各ボタンの頭の行をこの表から作り、種類との対応の1段を足す）。

type Env = Record<string, string | undefined>;
export function aixCatalogMapEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.BRAIN_AIX_CATALOG_MAP ?? "").trim().toLowerCase() === "on";
}

/** 情報の種類 K1〜K16（試験・解剖の表と同じ名前）。staffOnly＝スタッフだけが知る情報か */
export const INFO_KINDS_16: Readonly<Record<string, { name: string; staffOnly: boolean }>> = {
  K1: { name: "募集状況・空き", staffOnly: true },
  K2: { name: "管理会社に確認した結果（設備・入居・畳・エアコン・代理契約・審査の見込み）", staffOnly: true },
  K3: { name: "交渉の結果（値下げ・割引・名義・切り替え）", staffOnly: true },
  K4: { name: "撮影した写真・室内イメージ", staffOnly: true },
  K5: { name: "見積の金額（御見積書・貸主からの報酬と還元額）", staffOnly: true },
  K6: { name: "内覧日程の確定（候補日・待ち合わせ・当日の確認）", staffOnly: true },
  K7: { name: "電話で話した内容", staffOnly: true },
  K8: { name: "会社の事実（手数料0円・分割はカード払いのみ・審査期間と流れ・必要書類・保証会社の種類）", staffOnly: false },
  K9: { name: "資料に書いてある事（現況・入居可能日・退去予定・設備・費用）", staffOnly: false },
  K10: { name: "物件の記録（送った物件・空室確認の結果・オススメ済み）", staffOnly: false },
  K11: { name: "会話の事実（お客様が言った条件・事情）", staffOnly: false },
  K12: { name: "初回の挨拶・条件ヒアリング", staffOnly: false },
  K13: { name: "前の約束の結果が手元にある（探した物件・確認の結果）", staffOnly: true },
  K14: { name: "気持ち・不安（検討・埋まるかも・費用）", staffOnly: false },
  K15: { name: "申込の合図・申込の手続き", staffOnly: false },
  K16: { name: "1通に種類の違う依頼が複数", staffOnly: false },
};

export type ButtonMapRow = {
  /** 届ける情報の種類（K 番号）。空＝どの種類にもつながらない（スタッフ操作・文を送らない・お客様の発言が起点でない） */
  kinds: string[];
  /** 届ける情報（短く・事実） */
  deliver: string;
  /** 手元に有るかの確かめ（押す条件＝材料・結果・日程が手元にあるか） */
  have: string;
  /** 押さない時（材料で答えられる＝返信／結果がまだ無い＝約束の返信）。AIX_DECISION_ORDER ②③と同じ向き */
  notWhen: string;
  /** 近いボタンとの分け方 */
  near: string;
  /** 竹内さんの実例の数（実送信・試験の正解の asks・30日の押下。未計測は未計測と書く） */
  count: string;
};

/** ボタン（aixType）ごとの表。property_check_result は画面のボタン名ごとに別の行（下の SUB_ROWS） */
export const BUTTON_MAP: Readonly<Record<string, ButtonMapRow>> = {
  property_send: {
    kinds: ["K13"], deliver: "スタッフが検索して選んだ物件（資料）。K11（お客様が言った条件）への「後で果たす物」",
    have: "送れる物件がスタッフの手元に有るか（条件がそろっていて探し終えている）",
    notWhen: "送れる物件がまだ無い番＝「ピックアップしお送りさせて頂きます」の約束の返信（2段）。探したが合う物が無い＝全力サポート",
    near: "1件に絞って推すのは物件オススメ／探した結果が無いのは全力サポート／条件がそろっていないのは条件ヒアリング",
    count: "試験の正解 AIX:property_send 7・2段:pickup（約束の側）44",
  },
  property_recommendation: {
    kinds: ["K13"], deliver: "スタッフが選んだ1件（資料の画像）とその推しどころ",
    have: "推す1件が手元に有るか（送った束の中から／新着が1件出た／代わり）",
    notWhen: "お客様の発言への答えとしては少ない（スタッフが自分から出す物）。複数を送った中から推すのは複数送った時だけ",
    near: "複数件をまとめて送るのは物件ピックアップした／募集終了の代わりは 物件確認した→物件なかった の後",
    count: "実送信 248回（新着1件 60%・送った中から 23%）・試験の正解 4",
  },
  estimate_sheet: {
    kinds: ["K5"], deliver: "管理会社の資料から作った御見積書の金額（最大限割引）",
    have: "見積る物件が会話に有るか（物件の画像・URL・こちらが送った物件・見積の依頼）／御見積書が作られているか",
    notWhen: "物件がまだ無い費用の質問＝「初期費用も最大限割引…抑えます」の返信（見積を約束しない）／御見積書を作る前＝「御見積書を作成しお送りさせて頂きます」の約束の返信（2段）",
    near: "初期費用の中身の質問は初期費用について／安さを不審に思われたら初期費用を説明／更に安くならないかは確認します（代表確認）",
    count: "実送信 見積書送る 153回（60日）・試験の正解 AIX:estimate_sheet 40・2段:estimate 26",
  },
  viewing_invite: {
    kinds: ["K6"], deliver: "スタッフの空いている日時（内覧の候補日）・退去予定の部屋の内覧開始日",
    have: "内覧の希望が日時なしか・初めての日時の指定か。退去予定の部屋は内覧開始日が資料に有るか",
    notWhen: "退去予定（入居中）の部屋で開始日が資料に無い＝「内覧開始日を確認させて頂きます」の約束の返信（2段）。資料に退去予定日が有る＝「〇月〇日以降ご内覧出来ます」と返信",
    near: "日と時刻が決まった後は待ち合わせ／日時の可否・時刻の即答は返信",
    count: "試験の正解 AIX:viewing_invite 27",
  },
  meeting_place: {
    kinds: ["K6"], deliver: "内覧の確定（日時）と待ち合わせの場所・住所（番地まで）",
    have: "日と開始時刻が決まっているか・待ち合わせ場所が未送信か",
    notWhen: "候補日を出す前の日時の指定は内覧日調整／送信済みなら日時・場所の変更を頼まれた時だけ",
    near: "候補日を出すのは内覧日調整／内覧当日の確認・内覧後のお礼は内覧挨拶",
    count: "試験の正解 AIX:meeting_place 9",
  },
  greeting_viewing: {
    kinds: ["K6"], deliver: "内覧の日時（内覧前・当日の確認）／内覧に行ったスタッフが分かった事（内覧後）",
    have: "確定した内覧の当日か・まだ当日の挨拶を送っていないか／内覧が終わったか",
    notWhen: "お客様の「遅れます・向かいます」は返信（お気をつけてお越しください）／今日もう当日の挨拶を送っていれば出さない",
    near: "待ち合わせ場所を送るのは待ち合わせ",
    count: "試験の正解 1・30日の押下 ブレイン選択5に対し1（時刻でスタッフが出す物）",
  },
  application_push: {
    kinds: ["K15"], deliver: "申込の手続き（申込書の様式・必要書類の案内）",
    have: "お客様が自分から申込の意思を言葉にしたか／内覧の後か（見積書の後の前向き反応だけでは足りない）",
    notWhen: "審査・必要書類・入居までの流れの質問は返信で説明（会社の事実）／申込の書類の手前で止める（申込の門）",
    near: "見積書の後は内覧のご案内が先（内覧日調整）",
    count: "試験の正解 11・見積書の後に申込へを押したのは 185件中18（10%）",
  },
  condition_hearing: {
    kinds: ["K12"], deliver: "条件ヒアリングのフォーム（8項目・お客様からもらっている条件は書き入れる）",
    have: "エリアと家賃の両方がそろっていないか・まだ物件を送っていないか",
    notWhen: "エリアと家賃が分かっていればフォームではなく物件ピックアップの約束（2段）",
    near: "初回の挨拶は返信→1〜2分後にフォーム（AIX は1つにまとめず、先の返信を落とさない）",
    count: "試験の正解 8（初回 7問）",
  },
  cost_explain: {
    kinds: ["K5"], deliver: "貸主から頂く報酬（AD）と還元額（スタッフ入力のみ）＋安くできる仕組み（会社の事実）",
    have: "安さを強く疑われたか・この物件の具体額（貸主からの報酬・還元額）がスタッフの手元に有るか",
    notWhen: "2,980円・仲介手数料0円の仕組みだけは会社の事実＝返信で答える（30日の押下は選んだ5に対し1）",
    near: "初期費用の中身は初期費用について／金額だけは見積書送る",
    count: "試験の正解 4・30日 ブレイン選択5・押下1（返信で答えた3）",
  },
  cost_breakdown: {
    kinds: ["K5"], deliver: "送った御見積書の内訳（項目・合計・家賃だけで入居できるか・日割家賃の扱い）。御見積書の画像をスタッフが貼る",
    have: "会話で最後に送った御見積書が有るか",
    notWhen: "御見積書がまだ無い費用の質問は返信（初期費用を抑える）／見積書の後の総額・追加分の確認は追加分入りの御見積書の送り直し（見積書送る）",
    near: "安さへの不審は初期費用を説明／金額の依頼は見積書送る",
    count: "試験の正解 1・実送信 ゆうこ事例（9/15）ほか",
  },
  guarantor_info: {
    kinds: ["K2"], deliver: "物件ごとの保証会社名と種類（独立系・信販系・信用系・管理会社に確認した物）",
    have: "その物件の資料に保証会社名が書いてあるか（書いてあれば K9）",
    notWhen: "資料に保証会社が書いてある物件1件の質問・保証会社の一般的な事・通りやすさの一般論は返信（30日の押下は選んだ10に対し0・返信で答えた6）",
    near: "審査の見込みを管理会社に確認するのは 確認した→審査について／保証会社の種類（会社の事実）は返信",
    count: "試験の正解 1・30日 ブレイン選択10・押下0",
  },
  phone_call: {
    kinds: ["K7"], deliver: "「電話をかける」ボタンと案内文（お客様がボタンから公式 LINE に電話できる）",
    have: "お客様が電話で話したいと言ったか（他の話題が同じ発言にあっても電話の依頼を先に受ける）",
    notWhen: "本文で電話番号を書かない",
    near: "電話の後のまとめはスタッフが 電話終了後 で送る（ブレインは選ばない）",
    count: "試験の正解 4",
  },
  phone_followup: {
    kinds: ["K7"], deliver: "電話で話した内容のまとめ（通話の中身はスタッフだけが知る）",
    have: "通話の中身は会話に無い＝スタッフが押す",
    notWhen: "ブレインは選ばない（スタッフ操作）",
    near: "電話の依頼は電話をかける",
    count: "未計測（ブレインが選ばないため試験に無い）",
  },
  zenryoku_support: {
    kinds: ["K13"], deliver: "スタッフが探した結果（今は条件に合うお部屋が無い）＋新着が出次第お送りする約束",
    have: "探し終えて、送れる物件が無かったか",
    notWhen: "送れる物件が有る時は物件ピックアップした／出し切った後に条件を足した番は新着待ちの返信",
    near: "物件ピックアップした／物件オススメ（新着1件）",
    count: "試験 出し切り 7問（正解は AIX 全力サポートか新着待ちの返信）",
  },
  acknowledge_check: {
    kinds: ["K3"], deliver: "御見積書の後に「更に安くならないか」と聞かれた時の、弊社代表に更なる割引を確認する約束（お客様あて・ピッカー 代表確認（初期費用））",
    have: "御見積書をすでに送った後の質問か",
    notWhen: "物件の募集状況を確認する約束は返信（2段）＝この AIX は選ばない。御見積書の前の「安くなりますか」は見積書送る",
    near: "結果は 確認した→代表に確認した で送る（物件確認した ではない）",
    count: "実送信 6回（150日・全部この形）・試験の正解 1",
  },
  followup_revive: {
    kinds: [], deliver: "追客・再接触の文（お客様の発言が起点でない）",
    have: "お客様の返信が3日以上止まっているか・申込の書類が届かないまま止まったか",
    notWhen: "お客様の今の発言があればその発言への答えが先",
    near: "新着が1件出た追客は物件オススメ（新着1件）",
    count: "未計測",
  },
  property_search: {
    kinds: [], deliver: "（文は送らない）拡張ツールで物件を探す操作",
    have: "最終物件送付から7日以上・送付0件か",
    notWhen: "お客様への最初の一手は約束の返信（2段）",
    near: "お客様が今条件を尋ねた時は物件ピックアップした",
    count: "未計測（文を送らない）",
  },
};

/** 物件確認した系の画面のボタン名ごとの行（aixType は同じ property_check_result） */
export const SUB_ROWS: Readonly<Record<string, ButtonMapRow>> = {
  "物件確認した（募集状況）": {
    kinds: ["K1", "K4", "K13"], deliver: "管理会社に確認した募集状況の結果（募集中・募集終了・別の部屋・専任）・手元の室内写真・資料から計算した入居可能日・最大限割引の御見積書の同封",
    have: "確認の結果が会話・記録に届いているか／室内写真は手元に室内イメージが有るか（こちらが送った物件・既に送った物件・建築中でない）",
    notWhen: "結果がまだ無い＝「募集状況を確認させて頂きます」の約束の返信（2段）／資料に入居時期・退去予定日が書いてある＝返信で資料の文字のまま／室内写真が手元に無い（持ち込み・建築中）＝「撮影出来次第お送り」の約束の返信",
    near: "設備・入居・交渉など管理会社に確認が要る事は 確認した（条件・交渉）／物件そのものの募集状況＝物件確認した。管理会社の名前の質問は 確認した",
    count: "試験の正解 AIX:property_check_result 42・2段:check（約束の側）55・2段:photo 2",
  },
  "確認した（条件・交渉）": {
    kinds: ["K2", "K3"], deliver: "管理会社・代表・オーナーに確認した結果（設備・入居日・フリーレント・駐車場・ペット・代理契約・二人入居・初期費用や家賃の交渉の結果）",
    have: "確認の結果が届いているか。資料の該当欄に書いてあるか",
    notWhen: "資料に書いてある設備・駐車場の空き・管理会社名は返信／結果がまだ無い＝「確認させて頂きます」の約束の返信／一般的な目安（短期解約の違約金の相場等）は返信",
    near: "物件の募集状況は 物件確認した／入居日は 物件確認した→入居日確認した（退去日から計算・資料）と 確認した→入居日について（管理会社の回答）の2つ",
    count: "試験の正解 管理会社の確認・交渉系 約10・約束の側 約14",
  },
  "物件について": {
    kinds: ["K1"], deliver: "募集一覧で見た建物の募集中の号室・間取り・家賃（AI なしで一覧）",
    have: "募集一覧を見られたか（スタッフ操作）",
    notWhen: "1室の空きは 物件確認した（募集状況）",
    near: "建物の何部屋・どの号室が空いているか＝物件について／聞かれた1室の空き＝物件確認した",
    count: "未計測（2026-10-20 追加・ブレインが選ぶのは質問・物件の共有の場面だけ）",
  },
  "審査について": {
    kinds: ["K2"], deliver: "管理会社・保証会社に確認した審査の見込みと必要書類／物件ごとの保証会社名と種類",
    have: "事情（名義・保証人なし・職業・国籍）の審査の相談に確認を約束した後か",
    notWhen: "審査期間・流れ・必要書類・マイナンバーカードで申込める事は会社の事実＝返信で説明（9/30 みこと）",
    near: "保証会社そのものは 審査について→保証会社について（guarantor_info）",
    count: "未計測（既定は出さない）",
  },
};

/** どのボタンにもつながらない種類（返信だけ）と、どの種類にもつながらないボタン。kinds は「そのボタンが主に届ける種類」だけ（副次の種類は deliver の文に書く） */
export const UNCONNECTED_KINDS: readonly string[] = ["K8", "K9", "K10", "K11", "K14", "K16"];
export const UNCONNECTED_BUTTONS: readonly string[] = ["followup_revive", "property_search"];

/** 種類ごとの対応（K → ボタンの鍵）を逆引きする（つながらない種類の確認・テスト用） */
export function buttonsOfKind(k: string): string[] {
  const out: string[] = [];
  for (const [t, r] of Object.entries(BUTTON_MAP)) if (r.kinds.includes(k)) out.push(t);
  for (const [b, r] of Object.entries(SUB_ROWS)) if (r.kinds.includes(k)) out.push(`property_check_result|${b}`);
  return out;
}

const kindsText = (r: ButtonMapRow) => (r.kinds.length ? r.kinds.map((k) => `${k}${INFO_KINDS_16[k] ? "" : "?"}`).join("・") : "（種類にはつながらない）");

/** ボタンの行（aixType と画面のボタン名から表の行を引く）。無ければ null */
export function mapRowFor(aixType: string, buttonLabel?: string | null): ButtonMapRow | null {
  if (aixType === "property_check_result") {
    const b = String(buttonLabel ?? "");
    for (const key of Object.keys(SUB_ROWS)) if (b.startsWith(key)) return SUB_ROWS[key];
    return SUB_ROWS["物件確認した（募集状況）"];
  }
  return BUTTON_MAP[aixType] ?? null;
}

/** ボタンの頭の行（catalogBlockForBrain の「送る情報」「線」を表から作る形） */
export function mapHeadLine(r: ButtonMapRow): { info: string; line: string } {
  return {
    info: `${r.deliver}［情報の種類 ${kindsText(r)}］`,
    line: `手元に有るか: ${r.have}｜押さない時: ${r.notWhen}｜近いボタン: ${r.near}`,
  };
}

/** 一覧の先頭に足す「種類との対応」の1段（事実の確かめだけ） */
export function catalogMapIntro(): string {
  return [
    "【AIX のボタンと情報の種類（各ボタンは、スタッフだけが知るどの種類の情報を届けるか）】",
    "- ボタンを選ぶ前に、お客様の発言に答える情報がスタッフだけが知る種類（K1 募集状況・K2 管理会社に確認した結果・K3 交渉の結果・K4 写真・K5 見積の金額・K6 内覧日程の確定・K7 電話の内容・K13 探した結果や確認の結果）か、手元の材料（K8 会社の事実・K9 資料・K10 物件の記録・K11 会話の事実）かを確かめる。",
    "- 種類が決まれば、届けるボタンは下の各行の「情報の種類」で決まる。その情報がまだ手元に無ければボタンの前の約束の返信、手元の材料だけで答えられる種類（K8・K9・K10・K11・K14・K16 の依頼）にはボタンが無い。",
  ].join("\n");
}
