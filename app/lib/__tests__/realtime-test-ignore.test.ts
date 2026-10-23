// app/lib/__tests__/realtime-test-ignore.test.ts — テスト専用の会話の Realtime を選んでいない時だけ読み飛ばす
//   実行: npx tsx app/lib/__tests__/realtime-test-ignore.test.ts
import { rtIgnoreTestEnabled, shouldIgnoreTestRealtime, shouldIgnoreTestRealtimeForConvs } from "../realtime-test-ignore";
import { YUMA_CONVERSATION_ID, NO_LINE_TEST_CONVERSATIONS, STAFF_INTERNAL_CONVERSATION_IDS } from "../test-conversations";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

const YUMA2 = NO_LINE_TEST_CONVERSATIONS[0].id;
const REAL = "11111111-2222-3333-4444-555555555555";

t("既定は on", rtIgnoreTestEnabled(undefined) && rtIgnoreTestEnabled("") && rtIgnoreTestEnabled("on"));
t("off で切れる", !rtIgnoreTestEnabled("off") && !rtIgnoreTestEnabled(" OFF "));
t("YUMA・選んでいない → 読み飛ばす", shouldIgnoreTestRealtime(YUMA_CONVERSATION_ID, REAL, true));
t("YUMA2・何も選んでいない → 読み飛ばす", shouldIgnoreTestRealtime(YUMA2, null, true));
t("YUMA を選んでいる → 当てる", !shouldIgnoreTestRealtime(YUMA_CONVERSATION_ID, YUMA_CONVERSATION_ID, true));
t("本物の会話 → 当てる", !shouldIgnoreTestRealtime(REAL, null, true));
t("スタッフ同士の会話 → 当てる（本物のやり取り）", !shouldIgnoreTestRealtime(STAFF_INTERNAL_CONVERSATION_IDS[0], null, true));
t("off → 当てる", !shouldIgnoreTestRealtime(YUMA_CONVERSATION_ID, null, false));
t("id が無い → 当てる", !shouldIgnoreTestRealtime(null, null, true) && !shouldIgnoreTestRealtime("", null, true));
t("物件顧客: 全部テストで未選択 → 読み飛ばす", shouldIgnoreTestRealtimeForConvs([YUMA_CONVERSATION_ID, YUMA2], REAL, true));
t("物件顧客: 1つ選んでいる → 当てる", !shouldIgnoreTestRealtimeForConvs([YUMA_CONVERSATION_ID, YUMA2], YUMA2, true));
t("物件顧客: 本物が混ざる → 当てる", !shouldIgnoreTestRealtimeForConvs([YUMA_CONVERSATION_ID, REAL], null, true));
t("物件顧客: 空 → 当てる", !shouldIgnoreTestRealtimeForConvs([], null, true));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
