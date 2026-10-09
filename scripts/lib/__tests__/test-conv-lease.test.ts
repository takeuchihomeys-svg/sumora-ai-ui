// scripts/lib/__tests__/test-conv-lease.test.ts
// 2026-10-09 竹内さん承認（巡を速く・テスト専用の会話 YUMA2〜YUMA5 を担当ごとに並べる）:
//   ① テスト専用の会話の一覧（学習・見張りから外れる・LLM のテストは通す・スタッフ同士は通さない）
//   ② 送信の関門（TEST-NOLINE-… の宛先・会話は送らない）
//   ③ 鍵（同じ会話を2つの実行で使わない・死んだ実行の鍵は取り直せる・--conv なしは YUMA で鍵を取らない）
//   ④ 線（REPLAY_FLOOR_FILE）がテスト専用の会話でも効く
// 実行: npx tsx scripts/lib/__tests__/test-conv-lease.test.ts（全 PASS で exit 0）
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  YUMA_CONVERSATION_ID, NO_LINE_TEST_CONVERSATIONS, NO_LINE_TEST_CONVERSATION_IDS, TEST_CONVERSATION_IDS, TEST_ONLY_CONVERSATION_IDS, STAFF_INTERNAL_CONVERSATION_IDS,
  isTestConversation, isTestOnlyConversation, isNoLineTestConversation, isNoLineTestLineUserId, resolveTestOnlyConversation, TEST_CONVERSATIONS_IN,
} from "../../../app/lib/test-conversations";
import { testConversationRefusal } from "../../../app/lib/llm-test-mode";
import { checkSendTarget, lineTargetKind } from "../../../app/lib/line-target";
import { rewriteRestUrl, currentReplayFloor } from "../../../app/lib/test-replay-floor";
import { acquireTestConversation, tryLock, readLock, lockFileOf } from "../test-conv-lease";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const OTHER = "fecda03f-05f5-473d-8db0-c273740224ea"; // 本番のお客様の会話（10/01 にテストで呼んでしまった）
const STRICT = { LLM_TEST_MODE: "deepseek-all", DEEPSEEK_API_KEY: "k" };
const FINAL = { LLM_TEST_FINAL_CLAUDE: "1" };
const Y2 = NO_LINE_TEST_CONVERSATIONS[0];

console.log("── ① 一覧");
t("テスト専用の会話は4本・id は重ならない", NO_LINE_TEST_CONVERSATIONS.length === 4 && new Set([...NO_LINE_TEST_CONVERSATION_IDS, YUMA_CONVERSATION_ID]).size === 5);
t("条件の行の id も重ならない", new Set(NO_LINE_TEST_CONVERSATIONS.map((c) => c.propertyCustomerId)).size === 4);
t("学習・見張りから外す一覧（TEST_CONVERSATION_IDS）に全部入る", NO_LINE_TEST_CONVERSATION_IDS.every((id) => TEST_CONVERSATION_IDS.includes(id) && isTestConversation(id)));
t("…YUMA・スタッフ同士の会話もそのまま", isTestConversation(YUMA_CONVERSATION_ID) && STAFF_INTERNAL_CONVERSATION_IDS.every(isTestConversation));
t("Supabase の in の形にも入る", NO_LINE_TEST_CONVERSATION_IDS.every((id) => TEST_CONVERSATIONS_IN.includes(id)));
t("LLM のテストを回してよい会話＝YUMA＋テスト専用（スタッフ同士は入れない）", TEST_ONLY_CONVERSATION_IDS.length === 5 && STAFF_INTERNAL_CONVERSATION_IDS.every((id) => !isTestOnlyConversation(id)));
t("本物のお客様の会話は どれでもない", !isTestConversation(OTHER) && !isTestOnlyConversation(OTHER) && !isNoLineTestConversation(OTHER));
t("YUMA は LINE につながっている（no-line ではない）", !isNoLineTestConversation(YUMA_CONVERSATION_ID) && isTestOnlyConversation(YUMA_CONVERSATION_ID));
t("名前・小文字・id で引ける", resolveTestOnlyConversation("YUMA3")?.id === NO_LINE_TEST_CONVERSATIONS[1].id && resolveTestOnlyConversation("yuma2")?.id === Y2.id && resolveTestOnlyConversation(Y2.id)?.name === "YUMA2" && resolveTestOnlyConversation("yuma")?.id === YUMA_CONVERSATION_ID);
t("知らない名前・本物の会話は引けない", resolveTestOnlyConversation("YUMA9") === null && resolveTestOnlyConversation(OTHER) === null && resolveTestOnlyConversation("") === null);

console.log("── ① LLM のテストの歯止め（testConversationRefusal）");
t("deepseek-all: テスト専用の会話は通す", NO_LINE_TEST_CONVERSATION_IDS.every((id) => testConversationRefusal(STRICT, id) === null));
t("final-claude: テスト専用の会話は通す", testConversationRefusal(FINAL, Y2.id) === null);
t("deepseek-all: YUMA は通す（今まで通り）", testConversationRefusal(STRICT, YUMA_CONVERSATION_ID) === null);
t("deepseek-all: 本物のお客様の会話は断る（今まで通り）", (testConversationRefusal(STRICT, OTHER) ?? "").includes("YUMA"));
t("deepseek-all: スタッフ同士の会話も断る", testConversationRefusal(STRICT, STAFF_INTERNAL_CONVERSATION_IDS[0]) !== null);
t("テストでない手元は何もしない", testConversationRefusal({}, Y2.id) === null && testConversationRefusal({}, OTHER) === null);

console.log("── ② 送信の関門（checkSendTarget）");
t("宛先の印は LINE の ID の形でない", NO_LINE_TEST_CONVERSATIONS.every((c) => lineTargetKind(c.lineUserId) === null && isNoLineTestLineUserId(c.lineUserId)));
{
  const c1 = checkSendTarget(Y2.lineUserId, { line_user_id: Y2.lineUserId, send_blocked_reason: "test_no_line" });
  t("テスト専用の会話へは送らない（test_no_line）", !c1.ok && c1.reason === "test_no_line", JSON.stringify(c1));
  const c2 = checkSendTarget("U3d8d9e48f947d85f270da34a32413a67", { line_user_id: Y2.lineUserId, send_blocked_reason: null });
  t("本物の LINE の ID を渡しても、会話がテスト専用なら送らない", !c2.ok && c2.reason === "test_no_line");
  const c3 = checkSendTarget(Y2.lineUserId, null);
  t("会話が分からない呼び出しでも、宛先の印なら送らない", !c3.ok && c3.reason === "test_no_line");
  const c4 = checkSendTarget(Y2.lineUserId, { line_user_id: Y2.lineUserId, send_blocked_reason: null });
  t("送信停止の印が無くても宛先の印で止まる", !c4.ok);
  const yuma = "U3d8d9e48f947d85f270da34a32413a67";
  t("YUMA（本物の LINE）は今まで通り通る", checkSendTarget(yuma, { line_user_id: yuma, send_blocked_reason: null }).ok);
  t("send_blocked_reason=test_no_line の文が出る", !c1.ok && c1.message.includes("テスト専用"));
}

console.log("── ③ 鍵");
{
  const dir = mkdtempSync(join(tmpdir(), "tconv-"));
  try {
    const y = acquireTestConversation("", "x", { dir, exitHook: false });
    t("--conv なしは YUMA・鍵を取らない（今まで通り）", y.isYuma && y.id === YUMA_CONVERSATION_ID && y.lockFile === null && y.tag === "yuma");
    t("--conv=YUMA も YUMA", acquireTestConversation("YUMA", "x", { dir, exitHook: false }).isYuma);
    const alive = (pid: number) => pid === 111 || pid === 222;
    const a = acquireTestConversation("auto", "A", { dir, pid: 111, alive, exitHook: false });
    t("auto は YUMA2 から", a.name === "YUMA2" && a.tag === "yuma2" && !!a.lockFile && existsSync(a.lockFile!));
    const b = acquireTestConversation("auto", "B", { dir, pid: 222, alive, exitHook: false });
    t("2本目の auto は空いている次（YUMA3）", b.name === "YUMA3");
    let threw = "";
    try { acquireTestConversation("YUMA2", "C", { dir, pid: 333, alive, exitHook: false }); } catch (e) { threw = String(e); }
    t("生きている他の実行が持つ会話は取れない", threw.includes("空いていません") && threw.includes("YUMA2"));
    a.release();
    t("外したら取れる", acquireTestConversation("YUMA2", "C", { dir, pid: 333, alive: (p) => p === 333, exitHook: false }).name === "YUMA2");
    // 死んだ実行の鍵（pid 999 は生きていない扱い）は取り直せる
    writeFileSync(lockFileOf("YUMA4", dir), JSON.stringify({ pid: 999, owner: "dead", at: "x" }));
    t("死んだ実行の鍵は取り直せる", tryLock(lockFileOf("YUMA4", dir), "D", { pid: 444, alive: (p) => p === 444 }) && readLock(lockFileOf("YUMA4", dir))?.owner === "D");
    writeFileSync(lockFileOf("YUMA5", dir), "");
    t("空の鍵のファイルは取り直せる", tryLock(lockFileOf("YUMA5", dir), "E", { pid: 555, alive: () => false }));
    let all = "";
    try { acquireTestConversation("auto", "F", { dir, pid: 666, alive: () => true, exitHook: false }); } catch (e) { all = String(e); }
    t("全部使われていたら auto は止まる", all.includes("空いていません"));
    let bad = "";
    try { acquireTestConversation(OTHER, "G", { dir, exitHook: false }); } catch (e) { bad = String(e); }
    t("本物の会話の id は --conv に使えない", bad.includes("テスト用の会話ではありません"));
    b.release();
    t("自分の鍵だけ外す（他の pid の鍵は残す）", existsSync(lockFileOf("YUMA2", dir)) && !existsSync(lockFileOf("YUMA3", dir)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("── ④ 線（REPLAY_FLOOR_FILE）がテスト専用の会話でも効く");
{
  const dir = mkdtempSync(join(tmpdir(), "tfloor-"));
  try {
    const f = join(dir, "floor.json");
    writeFileSync(f, JSON.stringify({ conversationId: Y2.id, floor: "2026-10-09T01:00:00.000Z", status: "proposing", messageIdPrefix: "bexam-" }));
    const fl = currentReplayFloor({ REPLAY_FLOOR_FILE: f });
    t("テスト専用の会話の線を読む", fl?.conversationId === Y2.id);
    const u = rewriteRestUrl(`https://x.supabase.co/rest/v1/messages?select=*&conversation_id=eq.${Y2.id}`, "GET", fl);
    t("その会話の messages に線と印が付く", u.includes("created_at=gte.") && u.includes("line_message_id=like.bexam-"));
    const u2 = rewriteRestUrl(`https://x.supabase.co/rest/v1/messages?select=*&conversation_id=eq.${YUMA_CONVERSATION_ID}`, "GET", fl);
    t("別の会話（YUMA）の読み取りは変えない＝並べて回しても混ざらない", !u2.includes("gte."));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
