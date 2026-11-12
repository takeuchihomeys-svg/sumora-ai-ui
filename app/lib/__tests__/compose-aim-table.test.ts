// npx tsx app/lib/__tests__/compose-aim-table.test.ts
import assert from "node:assert/strict";
import { COMPOSE_AIM_TABLE, aimOf, PURPOSE_TO_ROLE, FOCUS_TO_ROLE, NIGHT_FOCUS_TO_ROLE, messageFocusOfFocus } from "../compose-vocab";
import { FOCUS_KINDS } from "../conductor-focus";
import { COMPOSE_PURPOSES } from "../compose-blueprint";
import { SENTENCE_ROLES } from "../takeuchi-anatomy-roles";
import { NEXT_DEST } from "../next-move-types";
import { readSevenFields, leadFromBrainNext, composeDestFromBrainOn } from "../compose-sentence-plan";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const MF = ["answer", "promise", "ease", "close", "propose", "relation_ack", "relation_keep"] as const;

t("4語彙の全部の値が表のどこかの行にある（新しい値を足したら表に足さないと落ちる）", () => {
  for (const f of FOCUS_KINDS) assert.ok(COMPOSE_AIM_TABLE.some((r) => r.focus === f), `focus ${f}`);
  for (const k of MF) assert.ok(COMPOSE_AIM_TABLE.some((r) => r.messageFocus === k), `messageFocus ${k}`);
  for (const p of COMPOSE_PURPOSES) assert.ok(COMPOSE_AIM_TABLE.some((r) => r.purpose === p), `purpose ${p}`);
  for (const r of COMPOSE_AIM_TABLE) { for (const x of r.roles) assert.ok((SENTENCE_ROLES as readonly string[]).includes(x)); for (const d of r.dest) assert.ok((NEXT_DEST as readonly string[]).includes(d)); }
});

t("派生は表から引くだけ（前の手書きの対応と同じ値）", () => {
  assert.deepEqual(PURPOSE_TO_ROLE, { appeal: "viewing", support: "trust", promise: "promise", inform: "answer", ask: "ask_send", ack: "uke" });
  assert.deepEqual(FOCUS_TO_ROLE, { answer: "answer", promise: "promise", ease: "worry", close: "viewing", propose: "keep", relation_ack: "uke", relation_keep: "keep" });
  assert.equal(NIGHT_FOCUS_TO_ROLE.promise_keep, "answer");
});

t("一意に決まらない所は誘導先（NEXT_DEST）で選ぶ", () => {
  assert.equal(aimOf({ purpose: "ask" }, "ask_condition")?.id, "hearing");
  assert.equal(aimOf({ purpose: "ask" }, "ask_send")?.id, "ask_send");
  assert.equal(aimOf({ focus: "close" }, "apply")?.id, "close_apply");
  assert.equal(aimOf({ focus: "close" }, "viewing")?.id, "close_viewing");
  assert.equal(aimOf({ purpose: "support" }, "door")?.id, "support");
  assert.equal(aimOf({ focus: "propose" }, "estimate")?.roles[0], "estimate");
  assert.equal(messageFocusOfFocus("promise_keep"), "answer");
  assert.equal(messageFocusOfFocus("relation", "keep_send"), "relation_keep");
});

t("誘導先をブレインの出力値から（COMPOSE_DEST_FROM_BRAIN・既定 off は今のまま自由文から）", () => {
  assert.equal(composeDestFromBrainOn({}), false);
  const meta = { reply_direction: "ピックアップしてお送りする返信にする" };
  assert.equal(readSevenFields(meta).leadTo, "keep");
  assert.equal(readSevenFields(meta, { env: { COMPOSE_DEST_FROM_BRAIN: "on" } }).leadTo, null);
  assert.equal(readSevenFields(meta, { nextIntent: "viewing", env: { COMPOSE_DEST_FROM_BRAIN: "on" } }).leadTo, "viewing");
  assert.equal(leadFromBrainNext("send_property"), "ask_send");
  assert.equal(leadFromBrainNext("wait_check"), "none");
  assert.equal(leadFromBrainNext(null), null);
});

console.log(`compose-aim-table: ${n} pass`);
