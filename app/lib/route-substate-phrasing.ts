// app/lib/route-substate-phrasing.ts — 駅の中の状態ごとの竹内さんの言い回しの型と潜在の4つ（データ・作業員M・2026-11-21 夜・台帳 #467 の (3)）
//   作り方: scripts/route-substate-phrasing.ts --labels=exam-cache/route-substate/majority-l1.json（竹内さん本人の198通を DeepSeek で15状態に割り当て・3回の2回以上そろった物）。
//   文は写さない: 役目・答え方・信頼の出し方は名前、語は決まった語の表に当たった語、潜在は種類（何で・何の部分を・どんな気持ちで・本当はどうしたいのか＝KB d72ad06b）。数の多い順。
//   読むのは route-record.routeBriefSection（ROUTE_TO_BRIEF・既定 off）だけ。
export type SubstatePhrasing = { n: number; point_how: string[]; trust_how: string[]; words: string[]; trigger: string[]; part: string[]; feeling: string[]; want: string[]; lead: string[] };
export const SUBSTATE_PHRASING: Readonly<Record<string, SubstatePhrasing>> = {
 "hearing_many_conditions": {
  "n": 18,
  "point_how": [
   "echo_words",
   "conclusion_first",
   "accept_first"
  ],
  "trust_how": [
   "support",
   "effort",
   "preempt"
  ],
  "words": [
   "！！",
   "頂き",
   "致します",
   "ありがとうございます",
   "ご満足"
  ],
  "trigger": [
   "customer_words"
  ],
  "part": [
   "審査",
   "初期費用"
  ],
  "feeling": [
   "不安・mid"
  ],
  "want": [
   "安くしたい",
   "決めたい"
  ],
  "lead": [
   "ask_send",
   "estimate"
  ]
 },
 "brought_vacancy": {
  "n": 18,
  "point_how": [
   "conclusion_first",
   "accept_first",
   "echo_words"
  ],
  "trust_how": [
   "support",
   "effort",
   "their_side"
  ],
  "words": [
   "頂き",
   "！！",
   "確認出来次第",
   "かしこまりました",
   "最大限割引"
  ],
  "trigger": [
   "customer_words",
   "scene"
  ],
  "part": [
   "初期費用",
   "取り扱い可否"
  ],
  "feeling": [
   "不安・mid"
  ],
  "want": [
   "決めたい",
   "安くしたい"
  ],
  "lead": [
   "estimate",
   "ask_send"
  ]
 },
 "proposing_considering": {
  "n": 27,
  "point_how": [
   "accept_first",
   "echo_words",
   "conclusion_first"
  ],
  "trust_how": [
   "their_side",
   "support",
   "kept_promise"
  ],
  "words": [
   "！！",
   "お気軽に",
   "頂き",
   "致します",
   "かしこまりました"
  ],
  "trigger": [
   "customer_words",
   "scene"
  ],
  "part": [
   "内覧の日",
   "募集状況"
  ],
  "feeling": [
   "不安・weak"
  ],
  "want": [
   "決めたい",
   "見たい"
  ],
  "lead": [
   "keep",
   "viewing"
  ]
 },
 "proposing_detail_question": {
  "n": 8,
  "point_how": [
   "reason_fact",
   "conclusion_first",
   "answer_by_thing"
  ],
  "trust_how": [
   "fact",
   "their_side",
   "support"
  ],
  "words": [
   "！！",
   "頂き",
   "確認出来次第",
   "如何でしょうか",
   "承知"
  ],
  "trigger": [
   "customer_words"
  ],
  "part": [
   "入居日",
   "初期費用"
  ],
  "feeling": [
   "不安・mid"
  ],
  "want": [
   "抑えたい",
   "決めたい"
  ],
  "lead": [
   "answer_only",
   "viewing"
  ]
 },
 "proposing_mismatch": {
  "n": 15,
  "point_how": [
   "echo_words",
   "accept_first",
   "conclusion_first"
  ],
  "trust_how": [
   "support",
   "their_side",
   "kept_promise"
  ],
  "words": [
   "！！",
   "頂き",
   "かしこまりました",
   "ご満足",
   "全力"
  ],
  "trigger": [
   "customer_words"
  ],
  "part": [
   "物件探しの範囲・駅",
   "物件の選択肢"
  ],
  "feeling": [
   "不安・mid",
   "不信・weak"
  ],
  "want": [
   "知りたい",
   "決めたい"
  ],
  "lead": [
   "ask_send",
   "none"
  ]
 },
 "proposing_liked_one": {
  "n": 7,
  "point_how": [
   "accept_first",
   "conclusion_first",
   "echo_words"
  ],
  "trust_how": [
   "their_side",
   "options",
   "effort"
  ],
  "words": [
   "頂き",
   "！！",
   "かしこまりました",
   "致します",
   "如何でしょうか"
  ],
  "trigger": [
   "customer_words",
   "scene"
  ],
  "part": [
   "内覧の日",
   "17日まで待っている間の"
  ],
  "feeling": [
   "迷い・mid",
   "不安・mid"
  ],
  "want": [
   "抑えたい",
   "見たい"
  ],
  "lead": [
   "viewing",
   "apply"
  ]
 },
 "cost_over_budget": {
  "n": 13,
  "point_how": [
   "conclusion_first",
   "accept_first",
   "echo_words"
  ],
  "trust_how": [
   "preempt",
   "their_side",
   "support"
  ],
  "words": [
   "！！",
   "頂き",
   "抑え",
   "かしこまりました",
   "最大限割引"
  ],
  "trigger": [
   "customer_words",
   "prev_send"
  ],
  "part": [
   "初期費用",
   "他の物件"
  ],
  "feeling": [
   "期待・mid",
   "不安・mid"
  ],
  "want": [
   "抑えたい",
   "安くしたい"
  ],
  "lead": [
   "estimate",
   "apply"
  ]
 },
 "cost_too_cheap": {
  "n": 1,
  "point_how": [
   "conclusion_first",
   "assert",
   "reason_fact"
  ],
  "trust_how": [
   "fact",
   "preempt",
   "their_side"
  ],
  "words": [
   "ご安心",
   "！！"
  ],
  "trigger": [
   "customer_words"
  ],
  "part": [
   "初期費用"
  ],
  "feeling": [],
  "want": [
   "知りたい"
  ],
  "lead": [
   "answer_only"
  ]
 },
 "cost_installment": {
  "n": 5,
  "point_how": [
   "conclusion_first",
   "accept_first",
   "numbers"
  ],
  "trust_how": [
   "fact",
   "their_side",
   "support"
  ],
  "words": [
   "！！",
   "頂き",
   "ありがとうございます",
   "かしこまりました"
  ],
  "trigger": [
   "customer_words"
  ],
  "part": [
   "初期費用",
   "鍵交換費用なし"
  ],
  "feeling": [
   "不安・strong"
  ],
  "want": [
   "安くしたい",
   "決めたい"
  ],
  "lead": [
   "answer_only",
   "apply"
  ]
 },
 "viewing_dates": {
  "n": 26,
  "point_how": [
   "accept_first",
   "echo_words",
   "conclusion_first"
  ],
  "trust_how": [
   "support",
   "their_side",
   "kept_promise"
  ],
  "words": [
   "！！",
   "頂き",
   "致します",
   "かしこまりました",
   "如何でしょうか"
  ],
  "trigger": [
   "customer_words",
   "scene"
  ],
  "part": [
   "内覧の日",
   "内覧の日・部屋の広さ"
  ],
  "feeling": [
   "焦り・mid",
   "不安・mid"
  ],
  "want": [
   "見たい",
   "決めたい"
  ],
  "lead": [
   "viewing",
   "ask_send"
  ]
 },
 "viewing_cannot": {
  "n": 2,
  "point_how": [
   "conclusion_first",
   "accept_first",
   "reason_fact"
  ],
  "trust_how": [
   "their_side",
   "support",
   "flexible"
  ],
  "words": [
   "！！",
   "かしこまりました",
   "頂き"
  ],
  "trigger": [
   "customer_words"
  ],
  "part": [
   "内覧の日",
   "内覧の可否"
  ],
  "feeling": [],
  "want": [
   "知りたい",
   "見たい"
  ],
  "lead": [
   "viewing",
   "apply"
  ]
 },
 "viewing_no_view_doubt": {
  "n": 1,
  "point_how": [
   "accept_first",
   "reason_fact",
   "name_property"
  ],
  "trust_how": [
   "their_side",
   "options",
   "honest_weak"
  ],
  "words": [
   "かしこまりました",
   "頂き",
   "お気軽に",
   "！！",
   "抑え"
  ],
  "trigger": [
   "customer_words"
  ],
  "part": [
   "内覧の要否・申込の順序"
  ],
  "feeling": [
   "迷い・mid"
  ],
  "want": [
   "決めたい"
  ],
  "lead": [
   "apply"
  ]
 },
 "apply_screening_worry": {
  "n": 10,
  "point_how": [
   "accept_first",
   "assert",
   "conclusion_first"
  ],
  "trust_how": [
   "their_side",
   "support",
   "preempt"
  ],
  "words": [
   "！！",
   "頂き",
   "致します",
   "かしこまりました",
   "ありがとうございます"
  ],
  "trigger": [
   "customer_words"
  ],
  "part": [
   "審査",
   "契約名義・審査"
  ],
  "feeling": [
   "不安・strong",
   "不安・mid"
  ],
  "want": [
   "決めたい",
   "見たい"
  ],
  "lead": [
   "apply",
   "keep"
  ]
 },
 "apply_timing": {
  "n": 9,
  "point_how": [
   "conclusion_first",
   "numbers",
   "reason_fact"
  ],
  "trust_how": [
   "preempt",
   "their_side",
   "fact"
  ],
  "words": [
   "！！",
   "抑え",
   "頂き",
   "お気軽に",
   "1部屋のみ"
  ],
  "trigger": [
   "customer_words",
   "scene"
  ],
  "part": [
   "入居日",
   "初期費用"
  ],
  "feeling": [
   "不安・mid",
   "焦り・mid"
  ],
  "want": [
   "抑えたい",
   "決めたい"
  ],
  "lead": [
   "answer_only",
   "keep"
  ]
 },
 "apply_intent": {
  "n": 13,
  "point_how": [
   "conclusion_first",
   "name_property",
   "accept_first"
  ],
  "trust_how": [
   "their_side",
   "support",
   "preempt"
  ],
  "words": [
   "！！",
   "頂き",
   "かしこまりました",
   "抑え",
   "如何でしょうか"
  ],
  "trigger": [
   "customer_words"
  ],
  "part": [
   "審査",
   "内覧の日"
  ],
  "feeling": [
   "期待・mid"
  ],
  "want": [
   "抑えたい",
   "決めたい"
  ],
  "lead": [
   "apply",
   "viewing"
  ]
 }
};
