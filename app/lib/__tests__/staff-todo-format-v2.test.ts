// 【やることリスト】の新しい形（app/lib/staff-todo-format-v2.ts）
// 実行: npx tsx app/lib/__tests__/staff-todo-format-v2.test.ts（全 PASS で exit 0）
import { staffTodoFormatV2On, v2TaskLine, v2Header, v2DueSuffix, v2Measure, conductorViewOf, conductorSituationLine, conductorNextLine, nextStepAixOf, todoVsConductor, nextStepShort } from "../staff-todo-format-v2";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const names = { node: (id: string) => ({ interested: "気に入った物件あり" } as Record<string, string>)[id] ?? null, branch: (id: string) => ({ negotiation: "交渉" } as Record<string, string>)[id] ?? null };
const AT = Date.parse("2026-11-24T01:30:00Z");

ok("既定は off", !staffTodoFormatV2On({}) && staffTodoFormatV2On({ STAFF_TODO_FORMAT_V2: "on" }));
ok("確認の行は動詞から（管理会社に〇〇を確認→ボタンで入力）", v2TaskLine({ action: "property_check_result", checkPattern: "mgmt_pet", source: "promise", task: "x", kindLabel: "AIX【物件確認した】" }) === "管理会社にペット可否と条件を確認→AIX【物件確認した】で入力");
ok("物件を送る行は条件で探す→ボタンで送る", v2TaskLine({ action: "property_send", checkPattern: null, source: "promise", task: "x", kindLabel: "AIX【物件ピックアップした】", conditions: "生野区・〜18万・3LDK" }) === "生野区・〜18万・3LDKで探す→AIX【物件ピックアップした】で送る");
ok("新着確認は（無ければ☑）", v2TaskLine({ action: null, checkPattern: null, source: "target_new_arrival", task: "新着", kindLabel: "x", everSent: true }).endsWith("（無ければ☑）"));
const h = v2Header("🌟aさん（スモラ）【申込歴あり】", { maxOverdueDays: 8, why: "期限8日過ぎ・申込歴あり", hasOpen: true });
ok("見出し: 期限は1か所・申込歴ありは2回書かない", h === "🌟aさん（スモラ）【申込歴あり】 ▶期限8日過ぎ" && v2Measure(h).dup === 0, h);
ok("行の期限は時刻がある物だけ", v2DueSuffix({ dueHasTime: true, dueAt: "2026-11-24T04:00:00Z", done: false }) === "（13:00まで）" && v2DueSuffix({ dueHasTime: false, dueAt: "2026-11-24T04:00:00Z", done: false }) === "");
const meta = { apply_route: { node: "interested", branch: "negotiation" }, next_steps: ["Step1（今すぐ）: 管理会社に募集状況を確認する", "Step2: x"], situation_now: { promises_open: [{ kind: "check", object: null, at: "2026-11-16T03:00:00Z", due_h: 24 }] }, analyzed_msg_ts: "2026-11-23T03:00:00Z" };
const v = conductorViewOf(meta, "2026-11-23T02:00:00Z");
ok("統括の状況: 駅・分かれ道・開いている約束（一番古い日と日数）", conductorSituationLine(v, AT, names) === "今: 気に入った物件あり・分かれ道: 交渉・開いている約束 1（一番古い 11/16・8日）", conductorSituationLine(v, AT, names));
ok("統括の次の手: Step1 の頭を落とす", conductorNextLine(v) === "統括の次の手: 管理会社に募集状況を確認する");
const stale = conductorViewOf(meta, "2026-11-23T05:00:00Z");
ok("最後の判断の後にお客様の通があれば古い＝推さない（次の手を出さない）", !!stale?.stale && conductorNextLine(stale) === null && conductorSituationLine(stale, AT, names).includes("未判断"));
ok("統括の判断が無ければその印", conductorSituationLine(null, AT, names) === "今: 統括の判断なし");
ok("次の手の種類", nextStepAixOf("新3物件の募集状況を管理会社に確認し") === "property_check_result" && nextStepAixOf("条件で検索する") === "property_send" && nextStepAixOf("あいさつ") === null);
ok("食い違いの見張り", todoVsConductor(["property_check_result"], v) === "match" && todoVsConductor(["property_send"], v) === "mismatch" && todoVsConductor(["property_send"], stale) === "stale" && todoVsConductor(["x"], null) === "no_conductor");

// 2026-11-24 統括役の直し①: 次の手は切らずに短い1文（動詞で終わる）
const ex = [
  "Step1（今すぐ）: 福万寺戸建てについて、1番手が審査落ちとなった場合の繰上げ・2番手申込の可否を管理会社に確認し、結果をお伝えする",
  "Step1（今すぐ）: 顧客が画像で送ってきたGrandPaseo south 12階（107,000円・1LDK・41㎡）の募集状況を管理会社に確認する",
  "Step1（今すぐ）: 1DK・1LDK、阪急京都線付近、家賃管理費込5〜6万、徒歩15分以内、バス・トイレ別・室内洗濯機置場の条件で物件を検索する",
  "Step1（今すぐ）: ラシーヌ日本橋501号室の申込・審査の進捗を管理会社に確認する",
].map(nextStepShort);
console.log(ex.join("\n"));
ok("次の手の短い1文: 動詞で終わる・36字以内・…で切らない", ex.every((x) => !!x && Array.from(x).length <= 36 && !x.includes("…") && /(する|す|る|える)$/.test(x)), ex);
ok("福万寺戸建ての例は何を→どうする", ex[0] === "福万寺戸建ての2番手申込の可否を管理会社に確認する", ex[0]);

ok("#676: 11/21 より前の判断で駅が無い時はその印", conductorSituationLine(conductorViewOf({ next_steps: ["x"], analyzed_msg_ts: "2026-11-10T03:00:00Z" }, null), AT, names).includes("駅なし（統括の判断は 11/10"));
console.log(`staff-todo-format-v2: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
