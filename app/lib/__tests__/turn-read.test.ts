// 実行: npx tsx app/lib/__tests__/turn-read.test.ts
// 本文は竹内さんの番（scripts/audit-turn-read-1111.ts の 79f97cea・2cb0feb7・eb4e5d3b・伏せた物）から
import { turnReadMode, leadCandidatesOf, lastStaffBurst, buildPrevLeadNote, normalizeTurnRead, turnReadDigest, askAboutDigest, turnReadDigestExtra, turnReadOutputItem } from "../turn-read";
import { brainDecisionDigestExtra } from "../brain-decision-ledger";
import { normalizeMoodRead, MOOD_OBJECTS, turnReadFocusOn, normalizeTurnFocus, turnFocusDigest, normalizeTurnTopics, turnTopicsDigest } from "../turn-read";
import { buildMoodFlowNote } from "../customer-mood-flow";
import { isAckOnlyTurn } from "../ack-topic-scope";
let passed = 0, failed = 0;
function ok(cond: unknown, name: string) { if (cond) passed++; else { failed++; console.error(`✗ ${name}`); } }

// 切替
ok(turnReadMode({}) === "log" && turnReadMode({ TURN_READ: "off" }) === "off", "既定 log（記録だけ）・off で止める");
ok(turnReadMode({ TURN_READ: "log" }) === "log" && turnReadMode({ TURN_READ: "ON" }) === "on", "log・on");
ok(turnReadOutputItem({}) === "" && turnReadOutputItem({ TURN_READ: "log" }) === "", "off・log はプロンプトを1字も変えない");
ok(turnReadOutputItem({ TURN_READ: "on" }).includes('"turn_read"'), "on は欄を足す");

// 直前の誘導の候補（79f97cea: 内覧調整の AIX の後に「土曜日でお願い」）
const aixViewing = "かしこまりました😊！！ レオンコンフォート難波南 1301号室ご案内させて頂きます！！ 直近ですと 10/23(金) 10:30〜11:30 10/24(土) 12:00〜13:00にてご案内可能です！！ YUMAさんご都合よろしいお日にち御座いますでしょうか😌！！";
const c1 = leadCandidatesOf(aixViewing);
ok(c1[0]?.kind === "内覧" && c1[0].strong, "内覧調整の AIX＝内覧（強い）");
// 2cb0feb7: 物件の束の後の「お手隙の際にご査収ください」＝誘導の語なし（弱い・締め）
const bundle = "YUMAさん大阪市西区(南堀江近く)周辺全域から家賃管理費込み12万円以内・1LDKで、YUMAさんにオススメ出来るお部屋ピックアップさせて頂きました😊！！ アーベル更紗北堀江（11月末退去予定） の2件は現在ご入居中の為退去予定のお部屋となります。 お手隙の際にご査収ください😌！！";
ok(!leadCandidatesOf(bundle).some((c) => c.kind === "内覧" || c.kind === "申込・抑える"), "物件の束の締め（ご査収）に内覧・申込の誘導を作らない");
// eb4e5d3b: 条件を受けた初回の送信＝全力サポート（関係をつなぐ）
const first = "ご条件お送り頂きありがとうございます！！ 兵庫駅〜春日野道駅周辺全域から家賃9万円以内・1DKまたは1LDKのお部屋をピックアップしてお送りさせて頂きます！！ YUMAさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！";
ok(leadCandidatesOf(first).some((c) => c.kind === "関係をつなぐ"), "全力サポート＝関係をつなぐ");
ok(leadCandidatesOf("").length === 0 && leadCandidatesOf(null).length === 0, "空は候補なし");

// 直前の束と注記
const msgs = [
  { sender: "staff", text: "新着で1件かなりオススメ出来るお部屋が募集にでました！！ お手隙の際にご査収ください😌！！", createdAt: "2026-10-22T09:00:00Z" },
  { sender: "customer", text: "こちら 内見出来ますか？", createdAt: "2026-10-22T10:00:00Z" },
  { sender: "staff", text: aixViewing, createdAt: "2026-10-22T10:10:00Z", isAix: true },
  { sender: "customer", text: "土曜日 で お願い出来ればと思います", createdAt: "2026-10-22T11:27:00Z" },
];
ok(lastStaffBurst(msgs).length === 1 && lastStaffBurst(msgs)[0].isAix === true, "直前の束＝今の番の前のこちらの送信だけ");
ok(lastStaffBurst(msgs.slice(0, 3)).length === 0, "最後がこちらなら今の番なし");
const note = buildPrevLeadNote(msgs);
ok(note.includes("▶内覧（強い・AIX）") && note.includes("ブレインが決める"), "注記は候補と判断はブレインの断り");
ok(buildPrevLeadNote([{ sender: "staff", text: "了解です", createdAt: "x" }, { sender: "customer", text: "はい", createdAt: "y" }]) === "", "候補が無ければ空");

// 出力の欄
const tr = normalizeTurnRead({ target: { kind: "内覧の日・場所", property: "レオンコンフォート難波南 1301", detail: "10/24(土)12:00", how: "文脈から" }, intent: "日程の調整・連絡", intent2: "手続き・審査の質問", lead: { kind: "内覧", answer: "応じた" }, feeling: "審査が通るか不安" });
ok(tr?.target.kind === "内覧の日・場所" && tr.lead?.answer === "応じた" && tr.intent2 === "手続き・審査の質問", "正しい欄は残す");
ok(normalizeTurnRead({ target: { kind: "物件" }, intent: "内覧したい" }) === null, "型の外れた種類は落とす");
ok(normalizeTurnRead({ target: { kind: "送った物件", property: "null" }, intent: "お礼・了承", lead: { kind: "内覧", answer: "たぶん" } })?.target.property === null, "property の null 文字・答えの外れ");
ok(normalizeTurnRead("x") === null && normalizeTurnRead(null) === null, "形の外れ");
ok(turnReadDigest(tr) === "内覧の日・場所|レオンコンフォート難波南 1301|日程の調整・連絡|内覧:応じた|", "digest.tr の形（mood なし）");
// 気持ちの細かい型（KB 542e92c9）
const trM = normalizeTurnRead({ target: { kind: "送った物件" }, intent: "もっと良い部屋・別の物件も見たい", mood: { base: "興味が薄い", object: "予算が合わない", degree: "強い" } });
ok(trM?.mood?.object === "予算が合わない" && trM.mood.degree === "強い", "mood は型どおり残す");
ok(turnReadDigest(trM)!.endsWith("|興味が薄い/予算が合わない/強い"), "digest.tr に mood");
ok(normalizeMoodRead({ base: "刺さっている", object: "眺望", degree: "最高" })?.object === "その他" && normalizeMoodRead({ base: "刺さっている", object: "眺望", degree: "最高" })?.degree === "中", "表に無い object・degree");
ok(normalizeMoodRead({ base: "嬉しい" }) === null, "12種に無い base は落とす");
ok(Object.keys(MOOD_OBJECTS).length === 12 && !turnReadOutputItem({ TURN_READ: "on" }).includes('"mood"'), "12種すべてに object・mood はブレインの欄に入れない（q406・記録だけの読みで付ける）");
ok(turnReadOutputItem({ TURN_READ: "on" }).includes("印刷されている") && turnReadOutputItem({ TURN_READ: "on" }).includes("⑧"), "フォームは⑧の欄の言葉だけ・印刷の定型文は拾わない");
// 持ち越しの直し: お礼・了承だけの一通は前回までの気持ちを並べない
const flowAck = buildMoodFlowNote({ changes: ["返事が早い"], signals: {}, reaction: null } as never, { prevEmotions: ["安くしたい", "刺さっている"], ackOnly: true });
ok(flowAck.includes("引き継がない") && !flowAck.includes("安くしたい→"), "ackOnly は前回の気持ちを並べない");
ok(buildMoodFlowNote({ changes: ["返事が早い"], signals: {}, reaction: null } as never, { prevEmotions: ["安くしたい"] }).includes("前回までの気持ち"), "既定は今まで通り");
ok(isAckOnlyTurn("よろしくお願いいたします") && !isAckOnlyTurn("プレサンス立売堀アーバンスタイルが場所的にちょっと高いかと"), "お礼・了承の見分け（実物）");
ok(JSON.stringify(askAboutDigest({ asks: [{ about: "viewing_day", property: "レオンコンフォート難波南 1301" }, { topic: "審査の相談" }] })) === JSON.stringify(["viewing_day:レオンコンフォート難波南 1301", "t:審査の相談"]), "digest.ta の形");
ok(askAboutDigest({ asks: [] }) === null && askAboutDigest(null) === null, "asks が無ければ null");

// 記録: off は何も足さない・log は今ある読み・on は turn_read も
const meta = { turn_contract: { asks: [{ about: "viewing_day", property: "X 101" }] }, latent_intent: "内覧は楽しみだが審査が不安", turn_read: { target: { kind: "内覧の日・場所" }, intent: "日程の調整・連絡" } };
ok(Object.keys(turnReadDigestExtra(meta, { TURN_READ: "off" })).length === 0, "off は digest を変えない");
ok(turnReadDigestExtra(meta, {}).ta?.[0] === "viewing_day:X 101" && !("tr" in turnReadDigestExtra({ ...meta, turn_read: undefined }, {})), "既定（log）は記録だけ");
const lg = turnReadDigestExtra(meta, { TURN_READ: "log" });
ok(lg.ta?.[0] === "viewing_day:X 101" && lg.li === "内覧は楽しみだが審査が不安", "log は ta・li");
ok(!("tr" in brainDecisionDigestExtra(meta, { TURN_READ: "off" })) && !("ta" in brainDecisionDigestExtra(meta, { TURN_READ: "off" })), "配線: off の digest に足さない");
ok(brainDecisionDigestExtra(meta, { TURN_READ: "log" }).hasOwnProperty("ta"), "配線: log で digest.ta");

// 組み合わせた理解（主・従・KB ee7ddf07）: q406 の実物の形
ok(!turnReadFocusOn({ TURN_READ: "on" }) && !turnReadFocusOn({ TURN_READ_FOCUS: "on" }) && turnReadFocusOn({ TURN_READ: "on", TURN_READ_FOCUS: "on" }), "主・従は TURN_READ=on と TURN_READ_FOCUS=on の両方の時だけ");
ok(!turnReadOutputItem({ TURN_READ: "on" }).includes("turn_focus") && turnReadOutputItem({ TURN_READ: "on", TURN_READ_FOCUS: "on" }).includes('"turn_focus"'), "欄は FOCUS の時だけ");
const tf = normalizeTurnFocus({ main: { about: "内覧の日・場所", intent: "日程の調整・連絡", move: "10/24 12:00 を確定" }, sub: { about: "手続き・審査", intent: "手続き・審査の質問", move: "後で答える" } });
ok(turnFocusDigest(tf) === "内覧の日・場所×日程の調整・連絡>手続き・審査×手続き・審査の質問:後で答える", "digest.tf の形");
ok(normalizeTurnFocus({ main: { about: "内覧", intent: "x" } }) === null && normalizeTurnFocus({ main: { about: "探す条件", intent: "条件を伝える・言い直す" }, sub: { about: "?" } })?.sub === null, "外れた値は落とす");
ok(normalizeTurnFocus({ main: { about: "探す条件", intent: "条件を伝える・言い直す" }, sub: { about: "手続き・審査", intent: "手続き・審査の質問", move: "あとで" } })?.sub?.move === "後で答える", "扱いの外れは既定の後で答える");
ok(turnReadDigestExtra({ turn_focus: { main: { about: "探す条件", intent: "条件を伝える・言い直す" } } }, { TURN_READ: "log" }) && (turnReadDigestExtra({ turn_focus: { main: { about: "探す条件", intent: "条件を伝える・言い直す" } } }, { TURN_READ: "log" }) as Record<string, unknown>).tf === "探す条件×条件を伝える・言い直す", "digest に tf");

// 話題ごと（弱い所 578）: 83391dda の実物の形（前の話の持ち出し）
ok(!turnReadOutputItem({ TURN_READ: "on" }).includes("turn_topics") && turnReadOutputItem({ TURN_READ: "on", TURN_READ_TOPICS: "on" }).includes('"turn_topics"'), "話題の欄は TURN_READ_TOPICS=on の時だけ");
const tt = normalizeTurnTopics([
  { n: 1, about: "新着の1件", intent: "気に入った・感想", quote: "すごくすごくいいんですが", ref: null, role: "従" },
  { n: 2, about: "新着の1件", intent: "検討する・保留・相談", quote: "少しだけ考えさせて", ref: "null", role: "従" },
  { n: 3, about: "探す条件", intent: "条件を伝える・言い直す", quote: "若江岩田・八戸の里まで広げても", ref: "数通前にお客様が言った地域の条件", role: "主" },
]);
ok(tt?.length === 3 && tt[1].ref === null && tt[2].ref !== null && turnTopicsDigest(tt) === "3|1|1", "話題の数・主・持ち出し");
ok(normalizeTurnTopics([{ about: "探す条件", intent: "条件を伝える・言い直す" }]) === null && normalizeTurnTopics(null) === null, "話題が1つ・形の外れは null");

console.log(`turn-read: ${passed} 通過・${failed} 失敗`);
if (failed) process.exit(1);
