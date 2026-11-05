// app/lib/__tests__/takeuchi-anatomy.test.ts — 竹内さんの文の解剖（純関数・文は作り物）
import { pickBalanced, parseAnatomy, anatomyConflicts, anatomyPrompt, ANATOMY_SYSTEM, ANATOMY_SYSTEM_FOCUS, anatomyFocusOn } from "../takeuchi-anatomy";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

const rows = [
  ...Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, scene: "cost", purpose: "promise", sent_at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}` })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, scene: "ack", purpose: "ack", sent_at: `2026-10-0${i + 1}` })),
];
const p = pickBalanced(rows, 10, 5);
t("偏りなく（少ない組も入る・組の上限）", p.filter((r) => r.scene === "ack").length === 3 && p.filter((r) => r.scene === "cost").length === 5, p.map((r) => r.id));
const a = parseAnatomy('{"scene":"物件を送ってきた","purpose":"promise","main_point":"募集状況を確認する","worry_answer":null,"parts":["uke","main","close","zzz"],"why_order":"受けてから約束","omitted":[{"what":"写真","why":"AIX の番"}]}');
t("読み取り", !!a && a.parts.join() === "uke,main,close" && a.omitted.length === 1 && a.worry_answer === null, a);
t("知らない趣旨は読まない", parseAnatomy('{"purpose":"decline"}') === null);
const body = "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます！！\n何卒よろしくお願い致します！！";
t("札と合えば食い違いなし", a ? anatomyConflicts(a, body).length === 0 : false, a ? anatomyConflicts(a, body) : null);
t("趣旨の食い違いを拾う", a ? anatomyConflicts({ ...a, purpose: "appeal" }, body).some((x) => x.startsWith("趣旨")) : false);
t("指示は伏せ済みの物だけ", /伏せ済み/.test(anatomyPrompt({ maskedCustomer: "YUMAです", maskedBody: body, scene: "property_share" })));

// 2026-11-05 作業員5: 重点と背景（既定 off・元の項目は変えない）
t("重点の読み: 既定 off", !anatomyFocusOn({}) && anatomyFocusOn({ TAKEUCHI_ANATOMY_FOCUS: "on" }));
t("重点の指示は元の指示の後ろに足すだけ", ANATOMY_SYSTEM_FOCUS.startsWith(ANATOMY_SYSTEM) && /promise_keep/.test(ANATOMY_SYSTEM_FOCUS) && !/promise_keep/.test(ANATOMY_SYSTEM));
const af = parseAnatomy('{"scene":"x","purpose":"ack","main_point":"受ける","worry_answer":null,"parts":["uke"],"why_order":"a","omitted":[],"background":"送った見積書を見て安さに驚いた","focus":"promise_keep"}');
t("重点と背景を読む", af?.focus === "promise_keep" && af?.background === "送った見積書を見て安さに驚いた", af);
t("一覧に無い重点は null", parseAnatomy('{"purpose":"ack","main_point":"a","parts":[],"why_order":"","omitted":[],"focus":"創作"}')?.focus === null);
t("重点の無い答え（off の時）は focus を持たない", a ? !("focus" in a) : false);
t("状況の文 v2 があれば指示に入る", /その番の時点の状況/.test(anatomyPrompt({ maskedCustomer: "a", maskedBody: "b", scene: "ack", situation: "進み: 見積書の後" })) && !/その番の時点の状況/.test(anatomyPrompt({ maskedCustomer: "a", maskedBody: "b", scene: "ack" })));
// 2026-11-05 作業員9の案: 書かなかった型の札と継続の約束
const as = parseAnatomy('{"purpose":"ack","main_point":"a","parts":[],"why_order":"","omitted":[],"focus":"relation","skipped_types":["hours","創作","hours","keep_promise_absent"],"keep":false}');
t("書かなかった型の札は一覧の物だけ・重ねない", JSON.stringify(as?.skipped_types) === '["hours","keep_promise_absent"]' && as?.keep === false, as);
t("札と keep の指示は重点を読む時だけ", /keep_promise_absent/.test(ANATOMY_SYSTEM_FOCUS) && !/keep_promise_absent/.test(ANATOMY_SYSTEM));
// 2026-11-06 弱い所 347: 一覧の外の purpose は fallbackPurpose を渡した時だけ捨てずに残す（元の値は purpose_raw）・渡さなければ今まで通り捨てる
const odd = '{"scene":"x","purpose":"decline","main_point":"募集終了の報告","worry_answer":null,"parts":["main"],"why_order":"a","omitted":[],"focus":"answer"}';
t("一覧の外の purpose: 既定は捨てる", parseAnatomy(odd) === null);
const kept = parseAnatomy(odd, { fallbackPurpose: "inform" });
t("一覧の外の purpose: fallback で残し purpose_raw を持つ", kept?.purpose === "inform" && kept?.purpose_raw === "decline" && kept?.focus === "answer", kept);
console.log(`takeuchi-anatomy: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
