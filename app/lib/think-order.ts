// app/lib/think-order.ts — 竹内さんの「思考の順番・判断の順番・優先度」の型の表（純関数・DB/LLM なし・作業員16・2026-11-12）
//
// 竹内さんの決定 11/12（KB P1 d030d496・親 P0 575a7cd5）「統括のブレインは判断の順番・思考の順番・優先度を細分化して細かくする。実際の竹内のように」
//   ＋同日「こうだからこうじゃないかと仮定して想定する等で当てはめる」「状況によって思考の順番をブレインの統括が判断すれば強化される。なぜなのか理解できれば質が高くなる」。
// 材料（費用0・Claude Code の読み）: exam-cache/anatomy-roles/roles-r1.json（竹内さんの返信 198通の文ごとの役目）・anatomy-seven/seven-all198.json（7つの欄）・
//   conductor-focus/replay-scene-v3-1110.json（重点の当たり）・本番の物差し line_watch_turns 7番（作業員4）・compose-understanding/result-1112-handoff.json（作業員10）。
// 形: 1行＝1つの型。状況の手がかり(cues) → 思考の順(think) → 判断の順(decide) → 優先(priority) → なぜ(why) → 竹内さんの実例(examples・名前は伏せた要約)。
//   統括が状況を読んで型を選ぶ時に「なぜ」ごと渡せる形。手がかりが重なった時の取り方は TIE_BREAKS（理由つき）。
// 置き方の決まり（道を引っぱらない・q406・q057・q065・q022 の教訓）: この表は道（返信か AIX か）を決める欄を足さない。
//   ①思考の順の「読みの候補→直前の送信で確定」と「今の番の出力と後で果たす AIX を分ける」だけを道の前に置く（事実の確かめ）
//   ②重点・優先・目的・押すかは道を書き終えた後の欄（BRAIN_*_AFTER と同じ置き方）で使う。
// スイッチ: THINK_ORDER_TABLE（既定 off＝どこからも読まない・shadow＝記録だけ・on＝後の欄に注記）。配線は試験の後（今はこのファイルとテストだけ）。

export type ThinkStep =
  | "read_ask"        // 何を言われたか（主の問い・依頼・反応）
  | "hypothesize"     // 読みの候補を立てる（この『はい』は何への了承か 等）
  | "our_last_send"   // こちらが前に約束・送った物（直前の送信）で読みを確定
  | "staff_only"      // スタッフしか知らない事か（管理会社に確認・募集状況・写真・見積の金額）
  | "fact_answer"     // 会社・物件の資料・会話の事実で答えられるか
  | "now_vs_later"    // 今の番の出力（返信の約束・答え）と、後で果たす AIX を分ける
  | "route"           // 返信か AIX か（今の番）
  | "focus"           // 重点（答える・約束を果たす・不安を消す・決めに行く・関係を続ける）
  | "aim"             // 目的・中期・押すか待つか・仕込み
  | "roles";          // 文の役目の並び

export type Need = "keep_result" | "answer" | "confirm_promise" | "send_promise" | "worry" | "next_move" | "relation";

export type ThinkOrderType = {
  id: string;
  name: string;
  /** 状況の手がかり（統括が状況を読んで型を選ぶ時の目印・決まった計算ではなくブレインが読む言葉） */
  cues: string[];
  think: ThinkStep[];
  /** 判断の順（先に確定し、後の役は決め直さない） */
  decide: string[];
  /** 同じ番に要件が複数ある時の優先（先→後） */
  priority: Need[];
  /** 今の番の出力と、後で果たす物 */
  nowOutput: string;
  later: string | null;
  /** 竹内さんの文の役目の並び（多い順・roles-r1） */
  rolePattern: string;
  /** なぜその順番か（竹内さんの実例・決定 id・その後の進み） */
  why: string;
  kb: string[];
  /** 竹内さんの番の数（198通の中・または本番の物差し） */
  count: string;
  examples: string[];
  /** 今のブレインがこの型で外す形 */
  brainMiss: string;
};

export const THINK_ORDER_TYPES: readonly ThinkOrderType[] = [
  {
    id: "T1_conditions_first",
    name: "条件の提示・言い直し（初回〜2回目）",
    cues: ["お客様が条件（エリア・家賃・間取り・設備）を言った・言い直した", "まだその条件で物件を送っていない"],
    think: ["read_ask", "our_last_send", "now_vs_later", "route", "focus", "roles"],
    decide: ["条件の受け取り（変更か追加か・ずっとか今回だけか）", "今の番＝ピックアップの約束（返信）", "後で果たす＝物件の AIX", "締め（初回だけ全力サポート）"],
    priority: ["answer", "send_promise", "relation"],
    nowOutput: "返信（受け→条件を復唱して全域からピックアップしてお送りする約束）",
    later: "AIX【物件ピックアップした】（物件が揃ってから）",
    rolePattern: "uke>keep>trust（細部は1つずつ返さず約束にまとめる 8/22）",
    why: "初回は『分かってもらえた』が信頼の芯。条件を復唱した約束で分かっている事を見せる。物件はまだ無いので、今 AIX を押すと送る物が無い（2段の約束 10/02）。条件の細部（徒歩・築年・入居時期）に1つずつ返すと約束が埋もれるので、まとめて『全域から』と約束する。",
    kb: ["feedback_condition_change_permanent", "10/02 2段（送れる物が無い時は約束）", "q010（締めは初回 80%）"],
    count: "conditions 22通中 lead=keep 20・answer_only 2",
    examples: ["カウンターキッチン希望→『かしこまりました！！／ご条件も含めて〇〇周辺全域からピックアップしてお送り／全力でサポート』", "本番 12189: 家賃の上限を下げた依頼→竹内さんは約束の返信だけ（AIX は押していない）・ブレインは property_send"],
    brainMiss: "aix 欄が JSON の先頭にあり『ピックアップの宣言があり未送付なら property_send』の但し書きで、今の番に後の果たしの AIX を選ぶ（本番 12189・2段の 72行の形）",
  },
  {
    id: "T2_question_fact",
    name: "質問（会社・手続き・物件の資料で答えられる）",
    cues: ["お客様の問い（いつ入居・費用・分割・保証会社・設備の有無）", "答えが会社の事実・物件の資料・会話にある"],
    think: ["read_ask", "staff_only", "fact_answer", "route", "focus", "aim", "roles"],
    decide: ["答えられるか（スタッフしか知らない事でないか）", "今の番＝答えの返信", "押すか（残り1部屋×決める合図の時だけ申込へ）"],
    priority: ["answer", "worry", "next_move"],
    nowOutput: "返信（結論から答える→理由の事実→次の一手）",
    later: null,
    rolePattern: "answer>apply／uke>answer／answer>viewing（答えは次の一手より先 7/0・10/3）",
    why: "答えられる事を確認の約束で保留すると『分かっていない担当』になり信頼を落とす。竹内さんは先に結論で答え、答えの直後に次の一手を置く（答えがあるから次の一手が受け入れられる）。",
    kb: ["feedback_procedure_question_reply", "e6822636（正直→確認の約束→一つ一つに答える→即答→気持ち→次の一手）", "q065・q145（一般的な事を保留しない）"],
    count: "answer の札 44通（重点の当たり 17/44＝一番弱い）・answer→keep の順 13/0",
    examples: ["最短の入居→『室内の状況・審査次第ですがお申込日から10日程』", "分割→『カード払いなら可』だけ", "床の色→『偶数階は白・奇数階はグレー』→内覧へ"],
    brainMiss: "重点を promise_make（8〜9）・close（6〜9）・ease（2〜5）に取る＝答えを約束に下げる（q041・q057・q072 の main=promise）",
  },
  {
    id: "T3_question_staff_only",
    name: "質問（スタッフしか知らない＝管理会社に確認が要る）",
    cues: ["募集状況・畳の変更・駐車場の種類・交渉の可否", "資料にも会話にも答えが無い"],
    think: ["read_ask", "staff_only", "now_vs_later", "route", "roles"],
    decide: ["スタッフしか知らない事か", "今の番＝確認の約束（返信）", "後で果たす＝AIX【物件確認した】"],
    priority: ["confirm_promise", "send_promise", "relation"],
    nowOutput: "返信（聞かれた事そのものを確認すると約束）",
    later: "AIX【物件確認した】（結果が出てから）",
    rolePattern: "uke>promise>keep（確認の約束は送る約束より先 10/3）",
    why: "確かめる前に答えると作り話になる。結果はスタッフしか知らないので AIX で送る（P0 AIX と返信の分け方）。確認の約束を先に置くのは、お客様の今の問いへの答えの代わりだから。",
    kb: ["P0 ca55d42b（AIX と返信の分け方）", "feedback_staff_only_is_aix", "feedback_property_check_on_request"],
    count: "promise の札 47通・promise→keep 10/3",
    examples: ["畳は変えられるか→（結果が出た番）AIX『管理会社へ確認・洋室への変更は出来ない』＋全部屋洋室の物件を確認", "物件No.の詳細→まず募集状況を確認する約束"],
    brainMiss: "結果が出ている番でも確認の約束の返信にする（q088）／結果が無い番で AIX を先に選ぶ",
  },
  {
    id: "T4_property_shared",
    name: "お客様が物件を送ってきた（空いてるか・費用を知りたい）",
    cues: ["お客様の物件の画像・URL・名前", "募集状況をまだ確かめていない"],
    think: ["read_ask", "hypothesize", "our_last_send", "staff_only", "now_vs_later", "route", "roles"],
    decide: ["何のために送ったか（空き／費用／条件の参考）", "今の番＝募集確認の約束（＋見積はその後と約束）", "後で果たす＝確認の結果→見積書の AIX"],
    priority: ["confirm_promise", "send_promise", "relation"],
    nowOutput: "返信（募集状況を確認し、確認出来次第最大限割引の御見積書とあわせてご連絡）",
    later: "AIX【物件確認した】→【見積書】（順に・1通に詰めない）",
    rolePattern: "uke>promise>keep（重点 promise_make 13/22・lead keep 10・estimate 8）",
    why: "埋まっている物件の見積書は無駄で信頼を落とす。だから先に空きを確かめる約束、見積はその後（約束を1通に詰めない・優先順に）。初回の『物件だけ』でも、送った物件が条件の参考なら見積ではなくピックアップの約束（読みの候補を立てて確かめる）。",
    kb: ["feedback_promise_order_split", "feedback_estimate_needs_property", "feedback_condition_vs_property_inquiry"],
    count: "property_share 22通・本番 11447（見積の約束の返信だけ・ブレイン estimate_sheet）・11264（参考の物件→ピックアップの約束・ブレイン estimate_sheet）",
    examples: ["初回で物件を送った→『はじめまして…お送り頂きました物件の募集状況と初期費用を確認させて頂きます／確認出来次第、最大限割引の御見積書とあわせてご連絡』", "条件と一緒に物件→『お送り頂きましたお部屋のご条件参考にさせて頂き、〇〇でピックアップしてお送り』"],
    brainMiss: "物件が来た＝見積書と決め打ちして estimate_sheet を今の番に出す（読みの候補を立てない・今と後を分けない）",
  },
  {
    id: "T5_ack_hypothesis",
    name: "お礼・了承だけ（はい・ありがとうございます・お願いします）",
    cues: ["お客様の今の文がお礼・了承だけ（60字未満・問いなし）"],
    think: ["read_ask", "hypothesize", "our_last_send", "now_vs_later", "focus", "aim", "roles"],
    decide: ["何への了承か（直前のこちらの送信で決める）", "今の番＝短い受け＋その送信に合う次の扉", "押すか（1部屋のみ・見積の後に了承→申込で抑える）"],
    priority: ["keep_result", "relation", "next_move"],
    nowOutput: "返信（物件を送った後＝気になる部屋の内覧の扉／見積の後＝ご確認を／内覧確定の後＝日時と場所の再提示／約束の後＝約束を守る姿勢）",
    later: "約束を果たす AIX（約束がある時・お礼の番の後）",
    rolePattern: "uke>keep 5・uke 3・uke>viewing 3（ack 22通）",
    why: "『はい』の中身は言葉に無く、こちらの直前の送信で決まる。先に直前の送信を見ないと何への了承か決められない。約束の後のお礼は、約束を果たす AIX ではなくお礼に短く返す番（10/14）。",
    kb: ["10/14 ackAfterPromiseReply（お礼の番は返信・約束を果たす AIX はその後）", "feedback_viewing_flow_stages"],
    count: "ack・considering 44通: 物件の後 keep4/viewing2・見積の後 answer_only4/apply(押す)2・約束の後 keep5・内覧確定の後 viewing2",
    examples: ["見積の後『わかりました』→1部屋のみの募集を一番に申込で抑える方へ", "内覧確定の後のスタンプ→当日の日時を再確認", "ピックアップの約束の後『よろしくお願いします』→約束を守る姿勢＋締め"],
    brainMiss: "お礼を『反応待ちでない＝こちらのボール』と読んで property_send を今出す／直前の送信を見ずに定型の締め",
  },
  {
    id: "T6_considering",
    name: "検討します・また連絡します",
    cues: ["検討・相談・時期が決まったら連絡", "決める合図（今日中に決める）があるか"],
    think: ["read_ask", "our_last_send", "focus", "aim", "roles"],
    decide: ["決める合図があるか", "今の番＝押さずに預かる返信（合図があれば内覧の扉）"],
    priority: ["relation", "next_move"],
    nowOutput: "返信（ごゆっくりご検討を／新着を送る・相談しやすさ／合図があれば内覧の扉）",
    later: null,
    rolePattern: "uke>keep 7・uke>viewing 5（重点 relation 14/22）",
    why: "急かすと離れる。先読みは浅く扉だけ残す（f64e0f5d の先読みの深さ: 検討・離れかけ＝急がず扉だけ）。『今日中に決める』の合図がある時だけ内覧へ。",
    kb: ["f64e0f5d（目的・中期・先読みの深さ）"],
    count: "considering 22通・強く押した 1",
    examples: ["『検討します』→『ごゆっくりご検討頂けますと幸いです／来週のご連絡お待ちしております』", "『今日中に決めて折り返します』→気になる部屋を見に行く内覧へ"],
    brainMiss: "検討の番に申込・内覧を押す（重点の当たりは 22〜23/24 で強い）",
  },
  {
    id: "T7_viewing",
    name: "内覧の話（可否・日時・当日）",
    cues: ["内覧したい・何日いけるか・何時まで・内見できないのか"],
    think: ["read_ask", "our_last_send", "fact_answer", "staff_only", "route", "focus", "roles"],
    decide: ["段階（候補日→日にち決定→待ち合わせ）のどこか", "可否を先に答える", "日時の確定はスタッフの番（AIX【内覧調整】）"],
    priority: ["answer", "next_move", "worry"],
    nowOutput: "返信（可否・最終時刻に答える→日程へ）／日にち決定・待ち合わせは AIX",
    later: "AIX【内覧調整】【待ち合わせ場所】",
    rolePattern: "answer>viewing 3・uke>keep 2・uke>promise 2（lead viewing 11/22）",
    why: "可否・時刻に答えないと日程が決まらない。日にちの確定はスタッフしか知らない予定なので AIX。内見できない物件は申込で先に抑える線を答えの直後に。",
    kb: ["feedback_viewing_flow_stages", "feedback_viewing_request_aix", "feedback_no_premature_viewing_mention"],
    count: "viewing 22通（重点の当たり 8/24＝一番弱い場面）",
    examples: ["『18時が最後なんですね』→18時までと答え都合を聞く", "『内見はできない感じ？』→答え→申込で先に抑える流れ"],
    brainMiss: "答えの前に日程・約束を置く／重点を close・promise に取る",
  },
  {
    id: "T8_cost",
    name: "費用（初期費用・分割・安くなるか）",
    cues: ["初期費用・総額・分割・割引の問い"],
    think: ["read_ask", "our_last_send", "fact_answer", "staff_only", "now_vs_later", "route", "roles"],
    decide: ["物件が決まっているか（見積書は物件がある時だけ）", "答え（会社の事実）か見積書（AIX）か", "総額の不安を先回り"],
    priority: ["answer", "worry", "next_move"],
    nowOutput: "返信（会社の事実で答える）／物件があれば見積書の AIX",
    later: "AIX【見積書】（物件が届いてから）",
    rolePattern: "uke>keep・uke>estimate・answer（answer→barrier 9/2）",
    why: "潜在は『総額が見えず決められない』（15/22）。答え→障壁を下げる事実（敷金礼金なし・キャンペーン）の順で、総額を見せて次へ。物件が無いのに見積書は作れない。",
    kb: ["feedback_cost_request_estimate_or_ended", "feedback_estimate_needs_property", "feedback_installment_card_only"],
    count: "cost 22通・本番 11154（割引の問い→約束の返信・ブレイン condition_hearing）",
    examples: ["『分割できないですよね？』→カード払いなら可", "割引の問い（物件まだ）→『最大限割引させて頂きます／気になるお部屋をお送り頂き次第、募集状況確認と御見積書をあわせて』"],
    brainMiss: "問いに答える番で、後の AIX（条件ヒアリング・見積書）を先に選ぶ",
  },
  {
    id: "T9_apply_signal",
    name: "申込の合図（抑えて・審査かけて・ここにします）",
    cues: ["申込・仮押さえの依頼・物件名指しで決める", "物件の残り（1部屋のみ）"],
    think: ["read_ask", "our_last_send", "route", "focus", "aim", "roles"],
    decide: ["申込の意思か（決める合図）", "即承認", "押す強さ（残り×決める合図）"],
    priority: ["answer", "next_move", "worry"],
    nowOutput: "返信（即承認→対象物件を特定して申込へ）",
    later: "AIX【申込】の書類",
    rolePattern: "uke>apply・answer>apply（apply 22通中 押す 16・強 7）",
    why: "取られる・審査で逃す不安（8・5）が潜在。合図に即答しないと他で埋まる。強く押すのは『残り×決める合図』の時（198通で強く押した 17 のうち決める合図 16・両方 8）。",
    kb: ["f64e0f5d（先読み: 決める合図＋残り1部屋＝1〜2番先の申込だけ）", "fact_screening_first"],
    count: "apply 22通",
    examples: ["『審査掛けて貰ってもいいですか』→即承認・物件を特定して審査へ", "『明日抑えて欲しい』→空きを断言して申込へ"],
    brainMiss: "申込の合図の前に確認の約束を挟む",
  },
  {
    id: "T10_result_ready",
    name: "前の約束の結果が手元にある（確認の結果・物件・見積が揃った）",
    cues: ["前に確認・ピックアップ・見積を約束し、結果が揃った", "お客様が催促・別の事を聞いた"],
    think: ["our_last_send", "read_ask", "staff_only", "route", "focus", "roles"],
    decide: ["約束の果たし（結果の AIX）を先", "次に今の問いへの答え・代わりの物件"],
    priority: ["keep_result", "answer", "next_move"],
    nowOutput: "AIX（結果）→ 続けて代わり・答え",
    later: null,
    rolePattern: "（AIX の番）結果→代わりの物件",
    why: "約束を果たすのが一番の信頼。結果がある時に返信で別の話をすると約束が後回しに見える。空いていなかった報告の次は代わりの物件（営業の考え方）。",
    kb: ["feedback_promise_order_split", "feedback_sales_mindset_alternatives", "型1 BRAIN_RESULT_FIRST_PROMISE"],
    count: "本番 11408（竹内さん: 確認した（空いていない）→物件ピックアップの2つ・ブレイン property_send だけ）",
    examples: ["確認の結果『空いていない』を AIX で→続けて代わりのピックアップを AIX"],
    brainMiss: "果たしの結果を飛ばして次の AIX だけを選ぶ（優先の誤り）",
  },
  {
    id: "T11_first_contact_hearing",
    name: "初回の挨拶・条件ヒアリング（フォームを送る番）",
    cues: ["初回の連絡・名乗り・事情（2人・審査の不安）", "条件がまだ揃っていない"],
    think: ["read_ask", "hypothesize", "fact_answer", "now_vs_later", "route", "roles"],
    decide: ["先に受け・不安への答え（返信）", "その後にフォームの AIX（2通・この順）"],
    priority: ["answer", "worry", "send_promise", "relation"],
    nowOutput: "返信（はじめまして・担当・言われた事情への受けと答え・ピックアップの約束）→ AIX【条件ヒアリング】",
    later: null,
    rolePattern: "（2通）返信の受け→AIX のフォーム",
    why: "初回は先に言われた事（事情・不安）に答えないと信頼が作れない。フォームだけ送ると機械的。だから返信が先、フォームが後の2通。",
    kb: ["feedback_two_choice_aix（2択）", "56b662a4（2択はスタッフしか知らない事の番だけ・先の側を付ける）"],
    count: "本番 12240・12306（竹内さん: 返信→1〜2分後に AIX【条件ヒアリング】・ブレイン AIX 1つ）",
    examples: ["2人で入居・審査の不安→『審査に通りやすい独立系の保証会社のお部屋を中心にピックアップ』→フォーム", "再来の連絡→『またお声掛け頂きありがとうございます／今回も仲介手数料0円…』→フォーム"],
    brainMiss: "AIX 1つにまとめ、先の返信（答え・約束）を落とす（12306 は約束が抜けた）",
  },
];

/** 手がかりが重なった時の取り方（理由つき・竹内さんの実例の数） */
export const TIE_BREAKS: ReadonlyArray<{ when: string; take: string; why: string; evidence: string }> = [
  { when: "前の約束の結果が手元にある × 新しい問い", take: "結果（約束の果たし）を先・問いはその後", why: "約束を果たすのが一番の信頼。後に回すと約束を忘れたように見える", evidence: "本番 11408・feedback_promise_order_split" },
  { when: "答えられる問い × 後で果たす AIX（物件・見積・フォーム）", take: "答え（返信）を先・AIX は果たせる時に", why: "今の番の出力と後の果たしは別。答えずに AIX を出すと問いが置き去り", evidence: "本番 7番中6番（11154・11264・11447・12189・12240・12306）・2段の外れ 72行" },
  { when: "問い × 不安", take: "答えを先・不安への受けは答えの直後", why: "答えそのものが一番の不安の解消。先に寄り添うと答えが遅れる", evidence: "answer→worry 12/1" },
  { when: "問い × 次の一手（内覧・申込）", take: "答えを先・次の一手は答えの後", why: "答えがあるから次の一手が受け入れられる", evidence: "answer→apply 7/0・answer→viewing 10/3" },
  { when: "確認の約束 × 送る約束", take: "確認の約束を先", why: "今の問いへの答えの代わりが確認の約束。送る約束は先の話", evidence: "promise→keep 10/3" },
  { when: "複数の問い・細部", take: "主の問いに答え、細部・2つ目は約束にまとめるか後の通", why: "1通に詰めると要点がぼける・約束は優先順に1つずつ", evidence: "198通中 81通で何かを後に回した（条件の細部 8・2つ目の問い 10・日時の細部 5・他の物件 5）" },
  { when: "押す × 待つ", take: "物件の残り×決める合図の時だけ押す・他は扉だけ", why: "決めていない人を押すと離れる。残りがあると待つ間に逃す", evidence: "強く押した 17 のうち決める合図 16・残りも 8" },
  { when: "お礼だけ × こちらの約束が未果たし", take: "お礼に短く返す返信（約束を果たす AIX はその後）", why: "お礼の番は果たしの番ではない（10/14 竹内さん）", evidence: "ack 22通・約束の後 keep 5" },
];

/** 読む深さ（竹内さん 11/12「状況によって必要な場合深く読むなど実際の人間のように」・P1 077d6e18 深く読むのは複雑な番だけ）。
 *  198通の目安（7つの欄の札から: 遡る＝前の約束・送った物に触れた／事実＝理由の事実・数字・正直な弱み）: 浅 86・遡る 40・事実 62・両方 10。
 *  場面ごと: considering 浅 17/22（一番浅い）・apply 事実 12/22・question 事実 10/22・ack は浅 7 だが両方 4（お礼の番が一番深い時がある）。 */
export type ThinkDepth = { base: "shallow" | "back" | "fact" | "deep"; deepenWhen: string[]; why: string; count: string };
export const THINK_DEPTH: Readonly<Record<string, ThinkDepth>> = {
  T1_conditions_first: { base: "back", deepenWhen: ["2回目以降の言い直し（前の条件との差）", "前に送った物件を外す言い方（肥後橋は上過ぎる）"], why: "前の条件・送った物との差を見ないと『変更か追加か・ずっとか今回か』が決まらない", count: "conditions 浅 9・遡る 7・事実 5・両方 1" },
  T2_question_fact: { base: "fact", deepenWhen: ["物件ごとに答えが違う（保証会社・入居日）", "答えが申込の判断に直結する"], why: "資料・会社の事実を見て結論で答える。遡りは要らない時が多い", count: "question 事実 10/22" },
  T3_question_staff_only: { base: "fact", deepenWhen: ["資料に答えが無いと確かめてから約束にする"], why: "資料を見ずに確認の約束にすると、答えられる事を保留する（q065）", count: "promise の札 47" },
  T4_property_shared: { base: "deep", deepenWhen: ["条件と一緒に物件が来た（参考か依頼か）", "前にその物件を送っていたか", "初回か"], why: "何のために送ったかは言葉に無い。条件・前の送信・初回かを見て読みの候補から1つに決める（本番 11264 は浅く決め打ちして見積書にした）", count: "property_share 浅 10・遡る 6・事実 5・両方 1" },
  T5_ack_hypothesis: { base: "back", deepenWhen: ["約束が複数開いている時の『はい』", "見積の後の了承（1部屋のみなら抑える）", "こちらの送信と食い違う反応"], why: "了承の中身はこちらの直前の送信で決まる。約束が複数ならどれへの了承かを候補で確かめる", count: "ack 浅 7・遡る 6・事実 5・両方 4（場面で一番深い番がある）" },
  T6_considering: { base: "shallow", deepenWhen: ["今日中に決める等の決める合図", "取られる不安を口にした（埋まるかも）"], why: "急がず扉だけ。深く読むと押す材料を拾って道を引っぱる", count: "considering 浅 17/22" },
  T7_viewing: { base: "shallow", deepenWhen: ["内見できない物件（申込で先に抑える線）", "他社で内覧予定"], why: "可否・時刻への即答が中心。段階の外れの時だけ深く", count: "viewing 浅 11/22" },
  T8_cost: { base: "fact", deepenWhen: ["物件がある（見積書の材料）", "安さを不審に思う"], why: "総額の不安に事実で先回り", count: "cost 浅 12・事実 8" },
  T9_apply_signal: { base: "fact", deepenWhen: ["物件が複数で名指しが曖昧", "申込の門（書類の手前で止める）"], why: "対象物件と空きを事実で確かめて即承認", count: "apply 事実 12/22" },
  T10_result_ready: { base: "back", deepenWhen: ["約束が複数（どれの結果か）"], why: "どの約束の結果かを遡って先に果たす", count: "本番 11408" },
  T11_first_contact_hearing: { base: "fact", deepenWhen: ["事情（2人・審査の不安・再来）を言った"], why: "言われた事情に会社の事実で答えてからフォーム", count: "本番 12240・12306" },
};

export type ThinkOrderMode = "off" | "shadow" | "on";
export function thinkOrderMode(): ThinkOrderMode {
  const v = String(process.env.THINK_ORDER_TABLE ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

export function thinkOrderById(id: string): ThinkOrderType | null {
  return THINK_ORDER_TYPES.find((t) => t.id === id) ?? null;
}

/** ブレインが番の読みを書き終えた後に、型の id を読みの言葉から選ぶ目安（決まった計算は候補の網だけ・P0 9eb6aa9c）。
 *  入力はブレインが既に出した欄（決め直さない）: intent・質問の有無・お礼だけか・未果たしの約束・結果が揃ったか・お客様が物件を送ったか・初回か。 */
export type ThinkOrderCues = {
  firstContact?: boolean;
  ackOnly?: boolean;
  hasQuestion?: boolean;
  answerableByFact?: boolean | null;
  staffOnly?: boolean | null;
  pendingPromise?: boolean;
  resultReady?: boolean;
  customerSentProperty?: boolean;
  conditionStated?: boolean;
  applySignal?: boolean;
  considering?: boolean;
  topic?: "viewing" | "cost" | "other" | null;
};

/** 候補を優先の順に並べて返す（先頭が採る型・理由つき）。TIE_BREAKS の順をそのまま使う */
export function pickThinkOrder(c: ThinkOrderCues): Array<{ id: string; why: string }> {
  const out: Array<{ id: string; why: string }> = [];
  const add = (id: string, why: string) => { if (!out.some((o) => o.id === id)) out.push({ id, why }); };
  if (c.resultReady) add("T10_result_ready", "前の約束の結果が手元にある＝果たしが先");
  if (c.applySignal) add("T9_apply_signal", "決める合図＝即承認");
  if (c.firstContact && (c.conditionStated === false || !c.conditionStated) && !c.customerSentProperty) add("T11_first_contact_hearing", "初回＝先に受けと答え・フォームは後");
  if (c.customerSentProperty) add("T4_property_shared", "物件が届いた＝何のためかの読み→募集確認の約束が先");
  if (c.hasQuestion) {
    if (c.topic === "viewing") add("T7_viewing", "内覧の問い＝可否を先に答える");
    if (c.topic === "cost") add("T8_cost", "費用の問い＝会社の事実で答える");
    if (c.staffOnly) add("T3_question_staff_only", "スタッフしか知らない＝確認の約束");
    else add("T2_question_fact", "答えられる問い＝答えを先");
  }
  if (c.conditionStated) add("T1_conditions_first", "条件の提示＝約束（後で物件の AIX）");
  if (c.ackOnly) add("T5_ack_hypothesis", "お礼だけ＝直前の送信で何への了承か決める");
  if (c.considering) add("T6_considering", "検討＝押さずに扉");
  return out;
}

/** 後の欄（道を書き終えた後）に渡す注記。道を決める語（AIX を選べ等）は書かない */
export function thinkOrderNote(t: ThinkOrderType): string {
  return [
    `【この番の考える順（竹内さんの型 ${t.id}・${t.name}）】`,
    `考える順: ${t.think.join("→")}`,
    `決める順: ${t.decide.join("→")}`,
    `優先: ${t.priority.join("→")}`,
    `なぜ: ${t.why}`,
  ].join("\n");
}
