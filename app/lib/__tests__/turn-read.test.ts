// 実行: npx tsx app/lib/__tests__/turn-read.test.ts
// 本文は竹内さんの番（scripts/audit-turn-read-1111.ts の 79f97cea・2cb0feb7・eb4e5d3b・伏せた物）から
import { turnReadMode, leadCandidatesOf, lastStaffBurst, buildPrevLeadNote, normalizeTurnRead, turnReadDigest, askAboutDigest, turnReadDigestExtra, turnReadOutputItem } from "../turn-read";
import { brainDecisionDigestExtra } from "../brain-decision-ledger";
let passed = 0, failed = 0;
function ok(cond: unknown, name: string) { if (cond) passed++; else { failed++; console.error(`✗ ${name}`); } }

// 切替
ok(turnReadMode({}) === "off", "既定 off");
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
ok(turnReadDigest(tr) === "内覧の日・場所|レオンコンフォート難波南 1301|日程の調整・連絡|内覧:応じた", "digest.tr の形");
ok(JSON.stringify(askAboutDigest({ asks: [{ about: "viewing_day", property: "レオンコンフォート難波南 1301" }, { topic: "審査の相談" }] })) === JSON.stringify(["viewing_day:レオンコンフォート難波南 1301", "t:審査の相談"]), "digest.ta の形");
ok(askAboutDigest({ asks: [] }) === null && askAboutDigest(null) === null, "asks が無ければ null");

// 記録: off は何も足さない・log は今ある読み・on は turn_read も
const meta = { turn_contract: { asks: [{ about: "viewing_day", property: "X 101" }] }, latent_intent: "内覧は楽しみだが審査が不安", turn_read: { target: { kind: "内覧の日・場所" }, intent: "日程の調整・連絡" } };
ok(Object.keys(turnReadDigestExtra(meta, {})).length === 0, "off は digest を変えない");
const lg = turnReadDigestExtra(meta, { TURN_READ: "log" });
ok(lg.ta?.[0] === "viewing_day:X 101" && lg.li === "内覧は楽しみだが審査が不安", "log は ta・li");
ok(!("tr" in brainDecisionDigestExtra(meta, {})) && !("ta" in brainDecisionDigestExtra(meta, {})), "配線: 既定 off の digest に足さない");
ok(brainDecisionDigestExtra(meta, { TURN_READ: "log" }).hasOwnProperty("ta"), "配線: log で digest.ta");

console.log(`turn-read: ${passed} 通過・${failed} 失敗`);
if (failed) process.exit(1);
