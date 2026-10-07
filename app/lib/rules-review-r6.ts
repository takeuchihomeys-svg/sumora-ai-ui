// app/lib/rules-review-r6.ts — 学習ルール（ai_prompt_rules の generate_reply＋global）の6巡目の見直し（純関数・依存なし）
//
// 2026-10-07 竹内さん「２最善のみなおしをする」（5巡目の6本の無効化＋b2d7bf7f の一文の削除に加えて、無効化で新しく届く4本と上限200の構造まで）。
//   1本ずつの材料は scripts/audit-prompt-rules-review.ts（届くか・「」の言い回しがスタッフの手打ち 365日 6,262通に何通あるか・冒頭の呼び名と挨拶の割合）。
//   決め方: ①スタッフの実送信と逆を言う（使うなと言う言い回しを人が多く使う／必ず添えろと言う言い回しを人がほぼ使わない＝創作を誘う）
//           ②永久ルール・会社の事実・竹内さんの決め（memory の feedback_*）・場面の整理（reply-scene・2段の約束・viewing-flow・appeal-timing）と食い違う
//           ③返信の指示ではない（ルールの登録・ナレッジの管理のメモ）・1件の事例に合わせすぎ（その場面以外にも効いてしまう）
//           → 無効（is_active=false）か、食い違う所だけ直す（rule_text の書き換え）。それ以外は残す。
//   本番の SQL は竹内さんが流す（scripts/rules-review-r6-sql.ts が控えと戻し方つきで出す）。ここは generate-reply の testFlags.rules_r6=on（テストの会話だけ）で
//   DB を変えずに「見直しの後」を作るための一覧（exclude.keys と textOverrides）。SQL を流した後はこの試しは何もしない（該当の行が無い・同じ文）。

export type RuleDecision = {
  id: string;
  key: string;
  verdict: "retire" | "edit";
  /** 一言の根拠（報告の表と SQL のコメントに出す） */
  why: string;
  /** edit の時の新しい rule_text */
  newText?: string;
};

export const RULES_REVIEW_R6: ReadonlyArray<RuleDecision> = [
  // ── 5巡目で決めた6本（竹内さん「大丈夫」）──
  { id: "f6e3cd53-64a8-4827-8b9a-738d7e421eab", key: "WEEKLY-hearing-1788750051770-4", verdict: "retire", why: "「周辺全域」を足すなと言うがスタッフの手打ち230通が使う・10/01『全域にする』" },
  { id: "ac177394-52b5-4dc0-9631-995e55324fa2", key: "FEEDBACK-0d9ce6d5-4818-43fb-a24f-5e308611618e-1", verdict: "retire", why: "「全力でサポート」を不安の場面以外で禁止→手打ち315通が使う（最終チェックの誤発火の出所）" },
  { id: "744f95e0-260a-4cc0-8cd7-214b17bc5fec", key: "DIFF-POLICY-FULL-a907bf03-9731-4cdc-b78c-ba7edb9999dc", verdict: "retire", why: "初回の割引の一文を一律禁止→永久ルール 12924481（限度額の条件で使う）と食い違う" },
  { id: "f4410208-35ba-4e87-8a64-f0708f6f443f", key: "WEEKLY-hearing-1784516504548-6", verdict: "retire", why: "同上（12924481 と食い違う）" },
  { id: "886ac923-3e6e-44ae-9a29-c8fa2eafc7ac", key: "FEEDBACK-1feeef80-a1ba-4d67-80d4-deabc813a3b6-1", verdict: "retire", why: "同上（12924481 と食い違う・手打ち「費用を出来る限り抑えさせて頂きます」78通）" },
  { id: "3f36ddb5-128d-4a9f-ad77-2f31cc9014d7", key: "FEEDBACK-532ed681-c549-431a-94c2-63739bf72be4-1", verdict: "retire", why: "同上（物件指定の時だけ→12924481 の条件と食い違う）" },
  // ── 永久ルール（generate_reply・8/26 作成）: 事実でない希少性・競合・入居可否を毎回足させる ──
  { id: "2ea9850b-b2be-4ac2-89bd-3bc037a7fb78", key: "HESITATION-THINK-MORE-001", verdict: "retire", why: "検討中に「1部屋のみの募集…審査前であれば無料でキャンセル」を必ず足す→手打ち0通・希少性は事実でない時がある・検討中の決まり（reply-scene CONSIDERING・催促と残りわずかは禁止）と食い違う" },
  { id: "a705f736-ea81-4856-90ef-2398f029e300", key: "HESITATION-COMPARE-OTHER-001", verdict: "retire", why: "同上（1部屋のみの希少性を必ず添える・CONSIDERING と食い違う）" },
  { id: "0c4c807f-1fba-42d7-a025-9b4f9e6e8e40", key: "SIGNAL-EQUIPMENT-QUESTION-001", verdict: "retire", why: "設備の答えに「現在1部屋のみの募集」を必ず添える→手打ち「1部屋のみ」は全体で33通（0.5%）・設備の答えは equipment-answer（資料から読んだ事実）が担う" },
  { id: "232ea380-937f-430b-97b5-b1801d0ab431", key: "ESCALATION-MULTI-QUESTION-001", verdict: "retire", why: "「さきほど〇〇のご確認も…」の創作の文（手打ち0通）＋1部屋のみの希少性を必ず" },
  { id: "31804633-365e-45f6-828e-5271f7dc8178", key: "SIGNAL-COMPETITION-INQUIRY-001", verdict: "retire", why: "競合状況（1番手か）を即答させる＝AI は知らない（作り事）・結果の初報は AIX（BOUNDARY 185b9adf）・言い回し手打ち0通" },
  { id: "5e46483f-e46b-4dac-8c28-251f801ca71e", key: "PERM-CLOSING-MOVEIN-DATE-001", verdict: "retire", why: "入居日の可否を即肯定（「○/○ご入居間に合います」）＝BOUNDARY 3b182aa2・f327204a と逆・「抑えられるのが1ヶ月間（最大40日）」は手打ち0通" },
  { id: "3ee99e94-712a-432a-853c-07651e2d5144", key: "FEEDBACK-ad83d843-7846-473f-b407-0b0fe9bebaf4-2", verdict: "retire", why: "「ご案内可能です」を避けよ→手打ち115通・AIX【内覧調整】の文そのもの（「にてご案内可能です」）と食い違う（永久ルール）" },
  // ── 人の決め（FEEDBACK）: 1回のゴミの直し・返信の指示でないメモ・人の実送信と逆 ──
  { id: "f83a154f-37f0-4125-89ad-81e7d60009fa", key: "FEEDBACK-aba931b1-c693-456c-ad94-5a2903bf7be5-2", verdict: "retire", why: "8月のテンプレートのゴミ（通過後にオーナーさん）の1回の直し・「お客様名からの書き出し」を毎回強いる（同じ日の続きは呼ばない＝0a9f96f0 の直しと食い違う）" },
  { id: "88f6ceaa-3a14-4706-b704-dad63e1b23bc", key: "FEEDBACK-aba931b1-c693-456c-ad94-5a2903bf7be5-1", verdict: "retire", why: "同上・「〇〇様から書き始める」は呼び名（さん）と逆" },
  { id: "5d8e87d0-e401-443b-8def-5972a7a02f20", key: "FEEDBACK-a0c501b0-1781-49bd-b5da-ae386e8676ce-1", verdict: "retire", why: "「オーナーさん」を一律禁止→大家の意味で手打ち11通が使う（ゴミの直しが正しい語まで消す）" },
  { id: "78e74678-fa66-4c14-81a3-65d3030db0f2", key: "FEEDBACK-af6d3da9-1f63-468a-bc88-7424205a4022-1", verdict: "retire", why: "同上＋決まった内見案内の文を毎回強いる（物件を送った後だけの c2fce531 が正）" },
  { id: "50953e9c-9fde-40b0-956d-7921476dfa28", key: "FEEDBACK-0e7fd083-62dd-484e-a468-d6d15116a814-3", verdict: "retire", why: "ルール DB の管理のメモ（返信の指示ではない）" },
  { id: "eebe22af-cd7e-49cc-a861-1391a6692358", key: "FEEDBACK-e88b744b-81ff-456d-9ff6-000bf95419c2-1", verdict: "retire", why: "ルール登録の匿名化のメモ（返信に渡すと名前・物件名を「顧客名」「家賃」に抽象化させかねない）" },
  { id: "80e864b5-373c-42e6-b588-d9103996b089", key: "FEEDBACK-4e48dafa-2e3a-4284-b728-6963fc15f99b-1", verdict: "retire", why: "ナレッジの文字化けの扱いのメモ（返信の指示ではない）" },
  { id: "bc5e25e8-6f39-4149-8150-2e5d3b7ec74f", key: "FEEDBACK-9a939ff2-9e48-4938-b7a4-2a1e4b1f5d26-2", verdict: "retire", why: "「お手隙の際にご査収ください」を使うな→手打ち775通（12%）・物件オススメの締めの決め（feedback_recommend_cta_by_appeal）で使う" },
  { id: "80084994-4339-4617-801e-c682af6c1163", key: "FEEDBACK-1db7b0be-fce5-493a-97cc-abc6db57ff43-1", verdict: "retire", why: "「😊！！」を避けよ→手打ち3,139通（50%）が使う定型" },
  // ── 自動の学習（DIFF-POLICY・WEEKLY）: 1件の事例に合わせすぎて場面の決まりと逆を言う ──
  { id: "e6d3b7d1-4a85-47af-9239-bd8e243f7f61", key: "DIFF-POLICY-FULL-235353cf-0382-4dbc-aec9-b8a89892d882", verdict: "retire", why: "スタンプだけに「お世話になっております」＋当日の内覧日時を必ず＝内覧当日の1件の事例（挨拶はその日最初だけ・内覧前の挨拶は viewing-greeting-text の決定論）" },
  { id: "51a03395-8a21-4295-9f97-c98408c18393", key: "DIFF-POLICY-FULL-acf70e25-5840-44ca-a7c1-ddc6d2733011", verdict: "retire", why: "了承の返事に「審査側の不足情報の提出依頼」を足す＝申込以降の1件・短いお礼は一言で返す（665a329a・2段の約束の後のお礼）と逆" },
  { id: "4bcae877-723d-469c-8c6a-6545dc5802cb", key: "DIFF-POLICY-FULL-52ebcc2e-964e-4bbd-83d6-41f18dc99827", verdict: "retire", why: "物件を受けた時に確認の結果（募集終了等）を返信で先に書け＝結果の初報は AIX（BOUNDARY 185b9adf）・持ち込みは確認＋御見積書の約束（10/07）" },
  { id: "fc72bd0d-93f5-4ad5-bc82-c8511d2e0ac3", key: "DIFF-POLICY-FULL-fa9e6954-5961-4558-9375-c9143fb4a192", verdict: "retire", why: "内見希望の返信で「案内日程の提示」＝候補日は AIX【内覧調整】（BOUNDARY 39aba364・viewing-flow）" },
  { id: "330fef80-78bd-48bc-9b7d-7e66244ce7a5", key: "DIFF-POLICY-FULL-0aac01ca-e5e4-4544-b608-8c8eff3a249c", verdict: "retire", why: "「2人入居可能か」に断定的見解を出せ＝資料に無い事を言い切らせる（dcd0f531・f327204a と逆）" },
  { id: "b8d2012a-9705-46fc-940e-474198c02394", key: "DIFF-POLICY-FULL-e8618911-c75f-4600-a106-caabcb9d0548", verdict: "retire", why: "返信で具体的な代替日時を提案せよ＝日時は AIX【内覧調整】（viewing-flow）" },
  { id: "3245de25-7227-4c12-a9a0-8f0565445708", key: "DIFF-POLICY-FULL-25d412ec-f8ce-43b9-9c28-13df350227ad", verdict: "retire", why: "「一度失礼します」等の会話終了の合図を足せ→手打ち7通（0.1%）＝創作を誘う" },
  { id: "1815de59-6f01-4ef9-b9f9-53844bb61d25", key: "DIFF-POLICY-FULL-05584ba2-6399-4c4c-9585-919135828dbf", verdict: "retire", why: "同上（『一度失礼致します』を必ず）" },
  { id: "22a20da9-95b4-455d-ad24-d7d6a06269b8", key: "DIFF-POLICY-FULL-82e2d5cf-97ae-46cf-add4-051a8d9cde1b", verdict: "retire", why: "返信で指定日の空き時間を答えよ＝空きは予定表でしか分からない（viewing-flow の台帳の注記・AIX【内覧調整】）" },
  { id: "648ca984-90aa-46b7-8726-7a7361fad985", key: "DIFF-POLICY-FULL-9cb6165d-24b9-4d74-a187-a211f79c0edf", verdict: "retire", why: "興味の返事に必ず内覧日程の打診＝内覧の訴求の要否は appeal-timing の決定論・日程は AIX" },
  { id: "ae5c9216-5efc-44c0-a60b-219e4cccd07c", key: "DIFF-POLICY-FULL-346b0c66-a23c-4c14-b200-9752259a6475", verdict: "retire", why: "見積書の後に申込の記入項目を必ず＝見積書の後は内覧が中心（feedback_estimate_not_apply）・申込の手続きは AIX（cc05b836）" },
  { id: "e8ad0189-116e-42a9-99b1-bf9740fe98d7", key: "DIFF-POLICY-FULL-9c31ed51-d8b2-4537-9644-79a3f494df14", verdict: "retire", why: "「代表許可・特別割引」の演出＋割引後の見積の提示＝金額・特典を作らせる（1de91f4a・aab282dc と逆）" },
  { id: "9aac8814-6a34-468d-bc12-f02e9f28f489", key: "DIFF-POLICY-FULL-34bfbe78-022f-4298-b83c-4702f7cc5b9b", verdict: "retire", why: "電話の1件の事例・[謝罪]を構成に入れる（謝罪しない決まりと逆）" },
  { id: "98f57d1a-4c9a-4518-a521-7ffd97a8b846", key: "DIFF-POLICY-FULL-a3abca10-cd2f-46ed-82d8-3ad6c453ec73", verdict: "retire", why: "お礼に在庫の希少性＋申込誘導＋キャンセル料を必ず＝希少性の作り事・短いお礼の扱いと逆" },
  { id: "2307eb27-a93a-4731-a368-78220fb343ab", key: "DIFF-POLICY-FULL-ad53e3b4-75ee-42e5-9e3a-458e74dc87a9", verdict: "retire", why: "感謝に「友人へのLINE追加依頼等」を必ず＝紹介の1件の事例" },
  { id: "71797dae-f214-4149-aa25-e0803673985d", key: "DIFF-POLICY-FULL-88959730-39ae-4012-9e7d-1c97d16755d1", verdict: "retire", why: "遅れを詫びる人に申込・お部屋を抑える行動喚起を必ず＝申込/内覧の訴求は部屋の状況で決める（appeal-timing）" },
  { id: "deffda02-a785-4bf0-91e2-989e411d3ae3", key: "DIFF-POLICY-FULL-95c0a9cd-fa71-460e-8d96-32f6672d35e9", verdict: "retire", why: "募集開始の時期を「一般的な目安（退去申請から1週間程）」で答えよ＝作り事（b578affd・f327204a と逆）" },
  { id: "5e822ed9-4039-4d46-9039-984fb6d67047", key: "WEEKLY-hearing-1789354882298-8", verdict: "retire", why: "f6e3cd53 と同じ（範囲の言い方を足すな）＝「周辺全域」と食い違う。別の駅を足さないのは b2d7bf7f（直した後）が持つ" },
  { id: "bb189cb1-4fb8-4a77-b2fe-3576e186ca70", key: "DIFF-POLICY-FULL-dfbe8cff-6b7e-4f6f-911e-46b413ab62fe", verdict: "retire", why: "金額の質問に必ず具体的な数字＝物件の金額を作らせる（1de91f4a・00e72bbb と逆）。決まっている仲介手数料 2,980円は永久ルール 4f2474ee が持つ" },
  { id: "e206603e-5bff-46f8-bbec-a5e2d406e652", key: "DIFF-POLICY-FULL-2446e92e-37ec-4361-a1fe-8fbd055dcc2b", verdict: "retire", why: "初回の割引の一文を一律に次のフェーズへ＝永久ルール 12924481（限度額の条件で使う）と食い違う" },
  { id: "212cafe4-70db-45c3-8b2a-bef59db221d7", key: "WEEKLY-hearing-1785726157131-6", verdict: "retire", why: "永久ルール 12924481 の古い写し（条件が少し違う・p6 で今は届かない）" },
  { id: "2977cc22-6a3a-4b2b-befd-6cf47a306b20", key: "WEEKLY-proposing-1784516468520-3", verdict: "retire", why: "呼び名を独立した行に（手打ち 12%）＝0a9f96f0 の直し（その日最初は呼び名＋挨拶）と食い違う（p6 で今は届かない）" },
  // ── 直す（食い違う所だけ書き換える）──
  {
    id: "0a9f96f0-4a01-4cdd-88c0-e90717a175a1", key: "FEEDBACK-bb58c6ee-57ab-4ead-bbfb-0fbcbcb398a3-1", verdict: "edit",
    why: "「必ず文頭で顧客名」→手打ちの返事の最初の1通で冒頭の呼び名は その日最初 60%・同じ日の続き 16%（挨拶 53%／2%）＝挨拶はその日最初だけ（fact_screening_first）にそろえる。上限で今は届かず、無効化で枠が空くと入る行",
    newText: "その日最初の返事は「〇〇さん」の呼びかけから始め、「お世話になっております！！」の挨拶と一緒にする（スタッフの実送信: その日最初の返事の冒頭の呼び名 60%・挨拶 53%）。同じ日に続いている会話の返事では、冒頭の呼びかけ・挨拶を入れずに本題から書く（同じ日の続き: 呼び名 16%・挨拶 2%）。呼び名が分からない時は呼ばない（「お客様」と呼ばない）。",
  },
  {
    id: "b2d7bf7f-bec3-4a8f-9205-e9817898a21c", key: "FEEDBACK-92c5b253-2f5b-4731-8a63-3613da211255-1", verdict: "edit",
    why: "5巡目どおり「『〇〇周辺全域から』といった自作のエリア表現も使わない」の一文だけ外す（10/01『全域にする』・手打ち 225通）",
    newText: "顧客が希望エリアを明示している場合は、そのエリアのみで物件を探し提案する。AIが会話履歴から勤務地や生活動線を推測して独自にエリアを絞り込んだり、広げたりしてはならない。",
  },
  {
    id: "05155f37-4e19-4111-ba34-5b142ab2d3c7", key: "FEEDBACK-65c11a3a-39fd-41b9-8509-9be14fc4d0b6-1", verdict: "edit",
    why: "「確認させていただきます」「お調べします」の禁止だけ外す（手打ち 282通・2段の確認の約束の文そのもの）。入居日を作らない所は残す",
    newText: "入居可能日について、AIが推測や生成で日程を作り出すことは絶対禁止。確認済みの「最短2週間」以外の入居日・審査期間を数字で書かない。分からない時は確認の約束（「確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」）にする。",
  },
  {
    id: "042748d3-347d-4941-b61a-0a70a6e426a5", key: "FEEDBACK-d0310626-2da4-4d5e-b401-94d6380d7cea-1", verdict: "edit",
    why: "「確認いたしますので少々お待ちください」が永久ルール c81a55f2（少々お待ちくださいは使わない）と逆→約束の形に",
    newText: "フリーレント（入居月＋翌月分の家賃負担など）の具体的条件は、管理会社への確認が取れた情報のみ提示する。通常のLINE返信AIが「入居月と翌月分の最大2ヶ月間フリーレントで管理会社側にご負担いただけます」といった具体的な優遇条件を独自に生成・断定することは禁止。未確認の段階では「確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」の約束にとどめる。",
  },
  {
    id: "751ed8b0-9bc3-4e2f-ad03-0b670cf7ed34", key: "FEEDBACK-f27b94a0-8875-4f16-91d6-06e1c56f959f-1", verdict: "edit",
    why: "条件だけの初回に「割引初期費用見積提示」へ移れ＝永久ルール 7eb0ff87（物件が無い時は見積書の語を使わない）と逆→物件の有無で分ける",
    newText: "初回ヒアリング段階で、顧客の全ニーズを反復確認して理解を示すような冗長なヒアリングは行わない。条件が具体的に提示されている場合は追加ヒアリングをせず即行動に移る（条件だけなら「ご希望のご条件に合ったお部屋ピックアップしお送りさせて頂きます」の約束・物件の指定があれば募集状況の確認と最大限割引した初期費用の御見積書の作成の約束）。「全ニーズを反復確認しながら期待値を引き上げる」対応は採用しない。",
  },
  {
    id: "1b2eaca7-7174-4475-86e3-95b42d34465e", key: "PROP-URL-REPLY-001", verdict: "edit",
    why: "「募集状況確認と他の物件を探すの2点のみ」→10/07 竹内さん「基本的には募集状況と最大限割引した初期費用の御見積書を両方」（2段 brought_both・120日 326番で『両方』が最多）",
    newText: "お客様が物件URL・物件の画面を送ってきた際の返信は「お送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第、最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！」のように、募集状況の確認と最大限割引した初期費用の御見積書の両方を約束する（件数が2件以上なら「お送り頂きました2件の」）。絶対禁止：「目のつけどころが良いですね」等の褒め言葉・社交辞令。入居時期のヒアリング・内覧案内を同じメッセージに混ぜない。",
  },
  {
    id: "3b182aa2-35c3-4049-9ef1-9b23693e4bd0", key: "BOUNDARY-b235ab62-a449-462a-8f29-d6c794a79aed-1-gr", verdict: "edit",
    why: "「入居可能日に答える＝全て AIX」→9/30 竹内さん（みこと）「審査・入居までの期間と流れは返信で説明・資料に記載あれば資料」（procedure-question）と食い違う所を足す",
    newText: "# 📋 入居時期まわりの線引き\n## ✅ 通常返信AI で OK：\n- 「ご入居希望時期はいつですか？」と顧客に聞く\n- 審査・入居までの期間と流れ（会社の事実）の説明\n- 送った資料に書いてある入居可能時期をそのまま伝える\n## ❌ 通常返信AI では NG：\n- 資料に無い入居可能日・退去日を告げる・推測する\n- 資料に無い「〇月〇日に入居できますか？」に答える\n**→ 資料に無い物は確認の約束にし、確認の結果は AIX【確認した】／【物件確認した】で送る**",
  },
];

/** 無効にする rule_key（fetchPromptRules の exclude.keys に渡すと、DB を変えずに無効にした後と同じになる） */
export const R6_RETIRE_KEYS: readonly string[] = RULES_REVIEW_R6.filter((d) => d.verdict === "retire").map((d) => d.key);
/** 書き換える rule_key → 新しい文 */
export const R6_TEXT_OVERRIDES: Readonly<Record<string, string>> = Object.fromEntries(RULES_REVIEW_R6.filter((d) => d.verdict === "edit" && d.newText).map((d) => [d.key, d.newText!]));

/**
 * AIX（property_send）の DIFF-POLICY-AIX ebad7f1c も同じ理由で無効にする（返信生成ではないので上の一覧とは別・SQL だけ）:
 *   「周辺全域から」NG → 物件ピックアップの送付文の 120日で 手打ち 214通・AIX 169通が「周辺全域から」・「隣接する駅のエリアから」は 8通
 */
export const R6_AIX_RETIRE: ReadonlyArray<RuleDecision> = [
  { id: "ebad7f1c-b627-4d24-bcaa-e183e885d245", key: "DIFF-POLICY-AIX-b3b552c8-15e2-41de-8b2f-2000af51358d", verdict: "retire", why: "物件ピックアップの送付文で「周辺全域から」NG→120日の実送信で 383通（手打ち214・AIX169）が使い「隣接する駅のエリアから」は8通・10/01『全域にする』" },
];
