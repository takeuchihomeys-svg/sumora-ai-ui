// scripts/test-compose-brief-uptake.ts — 指示書の欄→役目→要素の対応表と、渡した物を下書きが入れたかの確かめ（2026-11-15 作業員I・LLM/DB なし）
import assert from "node:assert/strict";
import { briefRoleTable, briefUptake, uptakeDigest, uptakeNote, briefUptakeMode, tokensOfValue } from "../app/lib/compose-brief-uptake";
import { BRIEF_SECTION_SUBS } from "../app/lib/conductor-brief";
let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const brief = (over: Record<string, unknown> = {}) => ({ main: "未", facts: "未", split: "未", missing: "未", fetch: "未", open: "未", type: "未", order: "未", alloc: "未", combine: "未", next: "未", aim: { purpose: null, purposeFrom: null, keyPoint: "未" }, decided: [], doubts: [], sure: { level: "mid", score: 0, cues: [], handoff: false }, notYet: [], ...over }) as never;
t("既定 off", () => { assert.equal(briefUptakeMode({}), "off"); assert.equal(briefUptakeMode({ COMPOSE_BRIEF_UPTAKE: "note" }), "note"); });
t("対応表: 欄は指示書の欄と同じ・main は頭・feeling は頭/つなぎ/締め/2通目", () => {
  const tb = briefRoleTable();
  assert.deepEqual(tb.map((r) => r.section), Object.keys(BRIEF_SECTION_SUBS));
  assert.deepEqual(tb.find((r) => r.section === "main")!.els, ["頭"]);
  const f = tb.find((r) => r.section === "feeling")!; for (const e of ["頭", "つなぎ", "締め", "2通目"]) assert.ok(f.els.includes(e), e);
});
t("値の語: 数は単位つき・名前は漢字カタカナの塊", () => {
  assert.deepEqual(tokensOfValue("初期費用176,180円"), ["176180円"]);
  assert.ok(tokensOfValue("現在空室で内覧可能").includes("現在空室"));
});
t("q136 の形: 管理会社の営業時間外の「明日一番に」を落とした下書きを拾う", () => {
  const b = brief({ next_concrete: { steps: [{ route: "aix", aix: "property_check_result", what: "check_result", item: "募集状況", when: { at: "next_day", word: "明日一番に", from: "mgmt_hours" } }], from: "deferred", combo: null, comboRef: null, why: "" } });
  const miss = briefUptake(b, "かしこまりました😊！！募集状況確認させて頂き、確認出来次第ご連絡させて頂きます！！");
  assert.equal(miss[0].used, false); assert.equal(uptakeDigest(miss), "next_concrete:0/1"); assert.equal(uptakeNote(miss), null, "監査で確かめた欄だけ注記"); assert.match(uptakeNote(miss, new Set(["next_concrete"])) ?? "", /明日一番に/);
  const ok = briefUptake(b, "かしこまりました😊！！本日管理会社営業時間外の為明日確認させて頂き、確認出来次第ご連絡させて頂きます！！");
  assert.equal(ok[0].used, true); assert.equal(uptakeNote(ok), null);
});
t("事実（確認が要る物は求めない）・誘い（押さない強さは求めない）", () => {
  const b = brief({ facts: [{ quote: "q", value: "初期費用176,180円", from: "資料", certainty: "assertable" }, { quote: "q", value: "駐車場の空き", from: "要確認", certainty: "needs_check" }], next: { dest: "viewing", strength: "invite", timing: "now", offer: null, plants: [], when: null, from: "type_table" } });
  const r = briefUptake(b, "初期費用176,180円となります！！よろしければご都合よろしいお日にちにお部屋ご案内させて頂きます！！");
  assert.deepEqual(r.map((x) => `${x.section}:${x.used}`), ["facts:true", "next:true"]);
  const door = briefUptake(brief({ next: { dest: "viewing", strength: "door", timing: "now", offer: null, plants: [], when: null, from: "type_table" } }), "ありがとうございます");
  assert.equal(door.length, 0);
});
console.log(`全部 ${n} 件 ok`);
