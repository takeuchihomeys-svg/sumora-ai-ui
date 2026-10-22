// scripts/owner-questions-seed.ts — 散らばっていた質問待ち（メモリ project_open_items_20261020.md の 1〜24・DB の OK 待ち・竹内さんに用意してもらう物）を
//   質問の台帳 owner_questions に移す。後の竹内さんの決定（設計知見 10/20〜10/22・メモの答え）で答え済みの物は answered（kb_id つき）・
//   質問でなく作業だった物や後の決定で要らなくなった物は obsolete・残りは open（推奨の答え＋短い理由）。同じ物はまとめた。
//   正解を決めてもらう番（gold）と AI の判定の比べ（judge_check）は例を2件ずつだけ入れる（中身はお客様の文を書かず、問題 id・番 id だけ）。
//   何度流しても同じ（dedupe_key で既にある行は触らない）。
//   npx tsx --env-file=.env.local scripts/owner-questions-seed.ts [--dry]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const MEM = "memory/project_open_items_20261020.md";

type Seed = {
  key: string; topic: string; question: string; status: "open" | "answered" | "obsolete";
  options?: string[]; recommended?: string; why?: string; answer?: string; kb?: string; priority?: number; ref: string;
  kind?: "question" | "gold" | "judge_check"; ref_exam_qid?: string; ref_watch_turn_id?: number; ai_verdict?: string;
};

// kb は設計知見の id の先頭8字（下で全桁に引き直す）
const SEEDS: Seed[] = [
  // ─── 答え済み（後の竹内さんの決定）───
  { key: "q01-other-company", topic: "ブレインの判断", question: "他社の場面①〜⑨（他社内覧・他社が安い・なぜ安い・審査厳しい・見積の抜け・弊社でも申込可を添えるか・他社で決定・条件外・審査相談）の返し方", status: "answered", answer: "C1〜C9（他社の見積に『弊社でも申込・内覧可』は後に状況判断へ改めた 1c4dddf7・審査相談は新ボタン【審査について】2cefbfef）", kb: "2845c395", ref: `${MEM} 質問待ち1` },
  { key: "q02-other-viewing", topic: "ブレインの判断", question: "他社内覧: 申込の意思がある時も誘うか／『気に入ればこちらで』にもご挨拶・サポートの文を入れるか", status: "answered", answer: "B7 申込の意思があっても弊社内覧へ誘う／B8 サポートの姿勢の文はブレインが判断", kb: "a8d3927e", ref: `${MEM} 質問待ち2` },
  { key: "q03-new-picker", topic: "ブレインの判断", question: "新ピッカー: 物件について→間に選ぶ画面／『確認します』も約束として拾うか／室内写真の動画／つなぎを on にする時期", status: "answered", answer: "F1 すぐ開く＋選択可／『確認させて頂きます』も約束（e2558968）／F3 動画は軽く・保管期間を決めて／on はブレイン先・試験で確かめてから（86877898）", kb: "3e91dc7a", ref: `${MEM} 質問待ち3` },
  { key: "q04-exam-gold", topic: "試験・見張り", question: "試験: 約束の後の『よろしく』の正解／手打ちの管理会社の答えは AIX が正解か／初回の約束3つの返す順番", status: "answered", answer: "A3 約束の後の『よろしく』は物件確認した（2d0f33cf）／H3 手打ちの管理会社の答えは AIX が正解／H4 初回の約束が複数の時は優先度を付け、順番は実際の LINE で調べる（10/21 答え3）", kb: "2d0f33cf", ref: `${MEM} 質問待ち4・13①` },
  { key: "q05-apply-map", topic: "ブレインの判断", question: "申込までの地図: 見積の後の費用の質問・内覧の前に見積か・審査の不安の次の一手・海外の人・音信不通は7日か", status: "answered", answer: "D1/D2 費用の問い＝食いつき・見積は反応で最優先の一手／D3 サポート＋通りやすい物件／D4 海外はオンライン内見→申込／D5 7日で AIX 追客", kb: "f7ed2a87", ref: `${MEM} 質問待ち5` },
  { key: "q06-sentence-design", topic: "ブレインの判断", question: "文の設計図: 短いお礼に誘い／約束だけの返信を正しい形と認めるか／検討中の扉の1文／約束の後の補足の答えの並び", status: "answered", answer: "E1/E2 誘導はブレインが状況と反応の予想で判断（69491851）／A4 約束だけの返信は正しい形（fca0a40e）／E3 並びは場面ごとに実際の LINE から（74618976）", kb: "69491851", ref: `${MEM} 質問待ち6` },
  { key: "q07-second-msg", topic: "ブレインの判断", question: "2通目: 物件資料の2通目の内覧の誘いを増やすか／約束の答えを AIX の補足欄から取るか", status: "answered", answer: "E4 2通目の内覧の誘いを増やす／E5 物件確認したから送る", kb: "74618976", ref: `${MEM} 質問待ち7` },
  { key: "q08-todo-list", topic: "やることリスト", question: "やることリスト: 送る時刻・送るグループ・✅の付け方・14日を過ぎた約束・（0日）の書き方", status: "answered", answer: "G1 2時間ごと・被りは置き換え／G2 売上番長グループ／G3 グループの✅も済み／G4 14日で外す／G5 （0日）は書かない", kb: "f87ccb7e", ref: `${MEM} 質問待ち8` },
  { key: "q09-property-pick", topic: "ブレインの判断", question: "物件選び: 『上過ぎる』を場所の不満にも／減点の大きさ／送った物件からの👑／ng_points の読めない9節", status: "answered", answer: "F5 上過ぎる=場所にも・大阪の地図を理解／F6〜F8 する（−15〜−25・👑表示・9節を読む）", kb: "3e91dc7a", ref: `${MEM} 質問待ち9` },
  { key: "q10-day-subject", topic: "ブレインの判断", question: "何の日か: 入居時期を聞いた時も内覧の流れなら内覧の日と読むか／受けを本題の頭へ（ACK_BLOCK_PLACE）", status: "answered", answer: "E6 内覧≠入居（基本の知識 b654a6d2）／B6 かしこまりましたを本題の頭へ OK（a8d3927e）", kb: "b654a6d2", ref: `${MEM} 質問待ち10` },
  { key: "q12-route-fix", topic: "ブレインの判断", question: "持ち込みで『見積もりお願いします』だけ→見積の約束で良いか／確認の結果の後6時間以内の追いの質問は物件確認したを直接か／不満を自動でピックアップの約束にするか", status: "answered", answer: "B3 見積だけの持ち込みは見積の約束で良い／B4 追いの質問は中身による／B5 不満→ピックアップの約束 OK＋AIX ツールの条件にもつなぐ", kb: "e2558968", ref: `${MEM} 質問待ち12` },
  { key: "q13-exam-brain", topic: "試験・見張り", question: "試験のブレイン: 前と同じなら2回目を回さないを既定に／flash の線を5問以上に／本番に入れた後の夜の自動の作り置き", status: "answered", answer: "H1 前と同じなら2回目なし OK／H2 夜の自動の作り置き OK（最善なら）／flash の線などの試験の改善は聞かずに進めてよい（08daffdd）", kb: "08daffdd", ref: `${MEM} 質問待ち13` },
  { key: "q14-staff-only", topic: "ブレインの判断", question: "管理会社に確かめて分かる問いでスタッフがすぐ返せる時は最初から AIX か／ピックアップ約束の後のお礼（決定C）のままで良いか／子供の入居可否のピッカー", status: "answered", answer: "A1 すぐ AIX（5aa28356）／A2 ピックアップ約束の後のお礼は AIX（2d0f33cf）／F4 子供は新しい項目（3e91dc7a）", kb: "5aa28356", ref: `${MEM} 質問待ち14①②④` },
  { key: "q15-writer-style", topic: "ブレインの判断", question: "書き方は従業員に合わせるか、竹内さんの書き方か（細かい手直しだけでも入れるか・平日10〜19時を従業員と推定するか）", status: "answered", answer: "書き方は竹内さん基準（絶対）→ 従業員に合わせる直しは入れない（②③は不要になった）", kb: "8e0d6f80", ref: `${MEM} 質問待ち15` },
  { key: "q16-aix-answers", topic: "ブレインの判断", question: "審査についてをブレインが選ぶのは試験の後か／C6 を物件を問わず毎回か／見積書に訂正版の選択／スモ割を追客の選択肢に", status: "answered", answer: "審査についてをブレインが選ぶのは試験後・スモ割はスモラの追客の選択肢に（3948d74c）／C6 は状況判断（1c4dddf7）／訂正版の選択＋小さい文字のアナウンス（701a5988）", kb: "3948d74c", ref: `${MEM} 質問待ち16` },
  { key: "q17-todo-notice", topic: "やることリスト", question: "やることリスト: 即時通知を残すか／朝の報告の節を外すか／夜中の連絡の期限／番号の書き方／表 staff_todo_marks", status: "answered", answer: "即時通知は止めてリストへ／朝の節はリストへ／夜中は翌営業日の当日扱い／番号は優先度順／表 OK", kb: "07df680c", ref: `${MEM} 質問待ち17` },
  { key: "q19-reapply", topic: "申込歴・2番手", question: "2番手で申込して戻した会話の扱い／印の言い方／強めた出口の網で一部 Claude に戻る費用", status: "answered", answer: "『2番手で申込中（並行で探す）』で下書き止めず（ec4d5990）／印は【申込歴あり】・伏せてから DeepSeek・伏せきれない時だけ Claude（414dc9d4）", kb: "414dc9d4", ref: `${MEM} 質問待ち19` },
  { key: "q20-hand-fulfill", topic: "やることリスト", question: "手打ちで約束を果たしている件（33件）は従業員に AIX を使うよう指示するか", status: "answered", answer: "やることリストで次の一手（どのボタン・ピッカー・入れる物）まで的確に指示する形にする（c0a91198）", kb: "c0a91198", ref: `${MEM} 質問待ち20④` },
  { key: "q21-conductor", topic: "ブレインの判断", question: "つなぎのブレインの司令塔: status と実際の段階が違う時・果たした約束の【必ず】・内覧決定後のピックアップ約束・カレンダーと記録・候補が割れた時", status: "answered", answer: "オススメで: 一次事実の段階で動く／果たした約束の開きは閉じる案に出すだけ／内覧決定後のピックアップ約束は保留／カレンダーを正・記録の直しはスタッフに確認／割れた時は点・近い時だけ flash（メモ 10/21 段3）", ref: `${MEM} 質問待ち21` },
  { key: "q22-target-overflow", topic: "やることリスト", question: "ターゲットが多い日に入りきらない行の扱い／朝の『全員に物件出して！！』を残すか", status: "answered", answer: "条件を削らず次の便へ・朝 10:30 の便の先頭に掛け声を残す", kb: "62bf3dcc", ref: `${MEM} 質問待ち22①②` },
  { key: "q-realtime-rls", topic: "その他", question: "RLS の後のチャットの即時表示: A スタッフのログイン（Supabase Auth）／B 数秒ごとの問い合わせ", status: "answered", answer: "A（Supabase Auth でスタッフがログイン）", kb: "62bf3dcc", ref: `${MEM} 10/21 reapply-followups の質問③` },
  { key: "q24-admin-tables", topic: "管理ツール連携", question: "AIXLINX DB に連携の表4つ（screening_facts・screening_links・admin_todo_mirror・admin_link_outbox）を足して良いか", status: "answered", answer: "足して良い", kb: "90e14e07", ref: `${MEM} 質問待ち24②` },
  { key: "db-backfill-rejudge", topic: "試験・見張り", question: "DB の OK 待ち: 控えの埋め戻し56行・見張りの判定のやり直し30日・止まりの警報を LINE に・YUMA の試験会話の片付け", status: "answered", answer: "I1〜I4 全部 OK（10/21 実行済み: 埋め戻し56・判定やり直し910〔変化7〕・YUMA 片付け・警報 on）", ref: `${MEM} DB の OK 待ち・10/21 答え3` },
  { key: "db-rls-127", topic: "その他", question: "サーバーだけの127表に RLS を入れる SQL を流して良いか", status: "answered", answer: "毎晩0:10 の更新が新しいコードで流れたのを確かめてから流す・戻しの SQL を用意", kb: "62bf3dcc", ref: `${MEM} 10/21 RLS 段②` },
  // ─── 不要（質問ではなく作業・後の決定で要らなくなった）───
  { key: "q11-other-room-image", topic: "ブレインの判断", question: "物件確認した→別の部屋の画像の時にご査収を外す恐れ（2通目 on の前に実データで確認）", status: "obsolete", answer: "質問ではなく作業（実データの確かめ）。作業の残りとして扱う", ref: `${MEM} 質問待ち11` },
  { key: "q18-exam-tool", topic: "試験・見張り", question: "試験の道具の直し（正解の AIX を選んだ番は下書きを数えない・main の取り置きの作り直し）を入れて良いか", status: "obsolete", answer: "試験の改善は聞かずに進める決定（08daffdd）", kb: "08daffdd", ref: `${MEM} 質問待ち18④` },
  { key: "q20-watch5-count", topic: "試験・見張り", question: "見張り⑤（新着・ピックアップの印）の数え方を send_mode を読む形で良いか", status: "obsolete", answer: "見張りの数え方は内部の作り（本番済み 10/21 link-promise-picker）", ref: `${MEM} 質問待ち20③` },
  // ─── 未回答 ───
  { key: "q14-watch-hole17", topic: "試験・見張り", question: "見張りの控えの穴（ブレインは AIX なのに返信と数えていた17件）を判断の記録から直して良いか", status: "open", options: ["直す", "そのまま"], recommended: "直す（判断の記録から決まった計算で・LLM なし）", why: "数え方の誤りで、返信の番と AIX の番の数字がずれるため", priority: 3, ref: `${MEM} 質問待ち14③` },
  { key: "q-todo-apply-done", topic: "やることリスト", question: "グループで『〇〇さんの申込完了しました』と書かれた時、そのお客様の残りの行を全部✅にして良いか", status: "open", options: ["全部✅", "申込に関わる行だけ✅", "✅にしない"], recommended: "全部✅", why: "申込になったら探す・追う行は要らなくなるため（申込歴あり・2番手並行は別に残る）", priority: 2, ref: `${MEM} 10/21 やることリスト本番の質問` },
  { key: "q18-first-greeting-a1", topic: "ブレインの判断", question: "初回の挨拶の番に物件の持ち込みがあった時も A1（すぐ AIX）にするか", status: "open", options: ["初回も A1（すぐ AIX）", "初回は2段のまま（挨拶＋確認の約束）"], recommended: "初回は2段のまま", why: "初回は挨拶と受けの返信が要り、確認の結果はその後の AIX で足りるため（今の本番の形）", priority: 2, ref: `${MEM} 質問待ち18①` },
  { key: "q18-old-material", topic: "ブレインの判断", question: "古い資料（7日以上前）の見積の依頼は、A1 の後も『先に最新の募集状況の確認』を挟むままで良いか", status: "open", options: ["挟むまま（10/16 の決まり）", "A1 で見積書送るを直接"], recommended: "挟むまま", why: "7日以上前の物件は募集が終わっている事が多く、先に確認すると誤った見積を送らないため", priority: 2, ref: `${MEM} 質問待ち18②` },
  { key: "q18-estimate-only-a1", topic: "ブレインの判断", question: "見積だけの持ち込みは、B3（見積の約束）より A1 を優先して最初から【見積書送る】を直接で良いか", status: "open", options: ["A1 優先＝見積書送るを直接", "B3 のまま（見積の約束→後で見積書送る）"], recommended: "A1 優先＝見積書送るを直接", why: "10/20 の A1 が新しい決まりで、スタッフがすぐ作れる時は約束を挟むと1往復増えるため", priority: 2, ref: `${MEM} 質問待ち18③` },
  { key: "q20-new-pickers", topic: "ブレインの判断", question: "新しいピッカーの候補『入居者の条件（お子様・年齢）』『審査の結果について』を作るか", status: "open", options: ["両方作る", "入居者の条件だけ", "作らない"], recommended: "入居者の条件は作る（F4 の新しい項目）・審査の結果は【審査について】の選択肢に入れる", why: "手打ちで果たしている約束の中に多く、ボタンが無いと従業員が手で打つため", priority: 2, ref: `${MEM} 質問待ち20①` },
  { key: "q20-after-new-arrival", topic: "ブレインの判断", question: "新着の約束の後は物件オススメを先にするか（実データはオススメ64・ピックアップ64で五分）", status: "open", options: ["オススメ先", "ピックアップ先", "ブレインが状況で選ぶ"], recommended: "ブレインが状況で選ぶ（良い1件ならオススメ・複数ならピックアップ）", why: "実データが五分で、10/13 の決定（1件ならオススメ・複数ならピックアップ）と同じ考えで決められるため", priority: 3, ref: `${MEM} 質問待ち20②` },
  { key: "q22-new-inquiry-days", topic: "やることリスト", question: "やることリストの『新規の問い合わせ』に日数の上限を付けるか（今は会話7日以内）", status: "open", options: ["7日（今のまま）", "3日", "上限なし"], recommended: "7日（今のまま）", why: "7日を過ぎた新規は追客（D5 の7日）に移るため", priority: 3, ref: `${MEM} 質問待ち22③` },
  { key: "q-reapply-pickup-cron", topic: "申込歴・2番手", question: "取りこぼし拾いの cron も『2番手で申込中（並行で探す）』の会話に広げるか", status: "open", options: ["広げる", "広げない"], recommended: "広げる", why: "2番手は並行で探す決定（ec4d5990）なので、取りこぼしも拾うのが筋。申込フォームは伏せたまま", priority: 2, ref: `${MEM} 10/21 reapply-followups の質問①` },
  { key: "q-reapply-memo-deepseek", topic: "申込歴・2番手", question: "お客様メモの DeepSeek の読み取りは、2番手で並行の会話では止めたままで良いか", status: "open", options: ["止めたまま", "伏せてから読む"], recommended: "止めたまま", why: "並行の会話は全履歴を伏せても漏れが出た（現住所・生年月日・勤め先）ため。メモは Claude 側で", priority: 2, ref: `${MEM} 10/21 reapply-followups の質問②` },
  { key: "q23-outcome-apply-hold", topic: "ブレインの判断", question: "結果から学ぶ③: 物件を送る前の『申込で抑える +25pt』の注記で、間違った時に申込を勧めさせないか（on の前）", status: "open", options: ["影の試験で確かめてから on", "今は off のまま"], recommended: "影の試験で確かめてから on", why: "申込で抑えるのは気に入った部屋がある時だけに絞ってあるが、本番で勧めすぎないかを先に測るため", priority: 2, ref: `${MEM} 質問待ち23①` },
  { key: "q23-outcome-negative-line", topic: "ブレインの判断", question: "結果から学ぶ③: 内覧の前に悪い方だけの1行（聞き返し −10pt）を出す意味があるか", status: "open", options: ["出す", "出さない"], recommended: "出さない", why: "やめる理由だけの注記はブレインの誘いを減らしやすく、良い方の一手が無い場面では効きが薄いため", priority: 3, ref: `${MEM} 質問待ち23②` },
  { key: "q24-admin-later", topic: "管理ツール連携", question: "後で管理ツールの DB に更新時刻の列・画面に番手/否決理由の欄を足し、管理ツールにも RLS を入れて良いか（/api/apply は鍵なしで案件を作れ、案件の表は公開キーで読める）", status: "open", options: ["連携の段1・2が動いてから足す", "今すぐ足す", "足さない"], recommended: "連携の段1・2が動いてから足す（RLS は P0 なので先に計画）", why: "今は管理ツールの DB を変えずに始める決定（90e14e07）。ただし鍵なしの /api/apply と anon で読める案件の表は穴なので早めに塞ぐ", priority: 1, ref: `${MEM} 質問待ち24③` },
  { key: "q-brain-fresh-cut", topic: "費用", question: "ブレインの毎回の分析（brain_fresh・月 約$110）を下げるため、材料（お客様の状態 3.4k字・その他のボタン一覧 4.6k字）を場面で削って良いか", status: "open", options: ["試験で質が落ちない分だけ削る", "削らない"], recommended: "試験で質が落ちない分だけ削る", why: "重複の止め・キャッシュはやり切り、残る大きな所が材料の量のため", priority: 2, ref: `${MEM} 10/22 brain_fresh 調べ①` },
  { key: "q-brain-fresh-model", topic: "費用", question: "ブレインの毎回の分析を安いモデルに替えるのを、影の比べで試して良いか（9/22 は不採用）", status: "open", options: ["影の比べで質が同じ場面だけ替える", "Claude のまま"], recommended: "Claude のまま（材料を削る方を先に）", why: "9/22 に検討して質が落ちたため不採用（1388764d）。削る方で十分下がる見込み", priority: 3, ref: `${MEM} 10/22 brain_fresh 調べ③` },
  // ─── 竹内さんに用意してもらう物 ───
  { key: "prep-admin-link-secret", topic: "用意してもらう物", question: "管理ツール連携の合言葉 ADMIN_LINK_SECRET を両方の Vercel（AIXLINX と管理ツール）に同じ値で入れる", status: "open", recommended: "手順の案内どおりに入れる（入れたら連携の段2を作れる）", why: "鍵付きの読み出し窓口に要る", priority: 1, ref: `${MEM} 質問待ち24①・10/22 「やりかたおしえて」` },
  { key: "prep-admin-service-key", topic: "用意してもらう物", question: "管理ツール DB 用の SCREENING_ADMIN_SUPABASE_SERVICE_ROLE_KEY を AIXLINX の Vercel に入れる", status: "open", recommended: "入れる（daily_tasks を公開キーで読み書きしている所をサーバーの鍵にするため）", why: "62bf3dcc で竹内さんが入れると決まったが、入ったかが未確認", priority: 1, ref: `${MEM} RLS 段①・62bf3dcc③` },
  { key: "prep-staff-accounts", topic: "用意してもらう物", question: "スタッフのログイン（RLS 段③）: ①スタッフの名前とメールの一覧（1人1つ）②Supabase で Email ログイン ON・新規登録 OFF・Add user ③Vercel に NEXT_PUBLIC_STAFF_AUTH と EXTENSION_API_KEY ④使う端末の一覧", status: "open", recommended: "メール＋パスワードで用意（PWA の中で終わる・約400日もつ）", why: "画面のリアルタイムを A 案（ログイン）にする決定の続き。用意が揃ったら off→login→on の順で止めずに入れる", priority: 1, ref: `${MEM} 10/22 RLS③` },
];

// gold・judge_check の例（中身の文は書かない・id だけ）
const EXAMPLES: Seed[] = [
  { key: "gold-q143", kind: "gold", topic: "正解", question: "試験 q143（交渉の約束の後の了承）の正解はどれ？ 同じ場面の q176/q178/q179 は AIX【物件確認した】が正解で食い違っている", status: "open", options: ["返信（全力サポート）", "2段:確認の約束", "AIX【物件確認した】"], recommended: "返信（全力サポート）", ref: ".claude/exam-cache/exam-brain/gold-check/2026-10-20.md 束1", ref_exam_qid: "q143" },
  { key: "gold-q158", kind: "gold", topic: "正解", question: "試験 q158（お礼・了承だけ・直前に他）の正解はどれ？ 今は『返信』と『AIX:物件』の両方が正解になっている", status: "open", options: ["返信", "AIX:物件", "両方正解のまま"], recommended: "両方正解のまま", ref: ".claude/exam-cache/exam-brain/gold-check/2026-10-20.md 束3", ref_exam_qid: "q158" },
  { key: "judge-6870", kind: "judge_check", topic: "判定の比べ", question: "見張りの番 #6870（10/21 13:26）: AI の判定は『違う』。竹内さんの判断は？（下書きとスタッフの送信を画面で見比べて）", status: "open", options: ["same 同じ", "partial 一部同じ", "different 違う"], ref: "line_watch_turns #6870", ref_watch_turn_id: 6870, ai_verdict: "different" },
  { key: "judge-6947", kind: "judge_check", topic: "判定の比べ", question: "見張りの番 #6947（10/21 17:26）: AI の判定は『一部同じ』。竹内さんの判断は？（下書きとスタッフの送信を画面で見比べて）", status: "open", options: ["same 同じ", "partial 一部同じ", "different 違う"], ref: "line_watch_turns #6947", ref_watch_turn_id: 6947, ai_verdict: "partial" },
];

async function fullKbIds(prefixes: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const { data, error } = await sb.from("system_design_thinking").select("id").order("created_at", { ascending: false }).limit(5000);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as Array<{ id: string }>) for (const p of prefixes) if (r.id.startsWith(p)) m.set(p, r.id);
  return m;
}

async function main() {
  const all = [...SEEDS, ...EXAMPLES];
  const keys = new Set<string>();
  for (const s of all) { if (keys.has(s.key)) throw new Error(`dedupe_key が重複: ${s.key}`); keys.add(s.key); }
  const kb = await fullKbIds([...new Set(all.map((s) => s.kb).filter((x): x is string => !!x))]);
  const missing = all.filter((s) => s.kb && !kb.has(s.kb)).map((s) => s.kb);
  if (missing.length) throw new Error(`設計知見が見つからない: ${missing.join(", ")}`);
  const now = new Date().toISOString();
  const rows = all.map((s) => ({
    kind: s.kind ?? "question", topic: s.topic, question: s.question, options: s.options ?? [], recommended: s.recommended ?? null, why: s.why ?? null,
    source_kind: s.kind && s.kind !== "question" ? (s.ref_exam_qid ? "exam" : "line_watch") : "memory", source_ref: s.ref, status: s.status,
    answer: s.answer ?? null, answered_at: s.status === "open" ? null : now, kb_id: s.kb ? kb.get(s.kb) : null, priority: s.priority ?? 2, dedupe_key: s.key,
    ref_exam_qid: s.ref_exam_qid ?? null, ref_watch_turn_id: s.ref_watch_turn_id ?? null, ai_verdict: s.ai_verdict ?? null,
  }));
  const tally = (st: string, k = "question") => rows.filter((r) => r.status === st && r.kind === k).length;
  console.log(`質問 ${rows.filter((r) => r.kind === "question").length}件（答え済み ${tally("answered")}・不要 ${tally("obsolete")}・未回答 ${tally("open")}）・gold ${tally("open", "gold")}・judge_check ${tally("open", "judge_check")}`);
  if (process.argv.includes("--dry")) return;
  const { data, error } = await sb.from("owner_questions").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(error.message);
  console.log(`入れた行: ${(data ?? []).length}（既にある行は触らない）`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
