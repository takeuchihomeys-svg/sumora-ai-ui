// scripts/test-next-move-types.ts — 次の一手の1つの表（app/lib/next-move-types.ts）と型の表の次の一手（check-order.NEXT_MOVE_OF_TYPE）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-next-move-types.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NEXT_DEST, NEXT_STRENGTH, toNextDest, strengthFromSeven, timingOf, strengthCeiling, strengthOverCeiling, PRIORITY_OF_DEST } from "../app/lib/next-move-types";
import { COMPOSE_NEXT } from "../app/lib/compose-blueprint";
import { LEAD_TOS } from "../app/lib/compose-sentence-plan";
import { LEAD_TO } from "../app/lib/takeuchi-anatomy-roles";
import { LEAD_KINDS } from "../app/lib/turn-read";
import { PRIORITY_KINDS } from "../app/lib/judge-basis-types";
import { CHECK_ORDER_TYPES, NEXT_MOVE_OF_TYPE, PRIORITY_OF_NEED, CHECK_DEPTH } from "../app/lib/check-order";
import { DEPTH_KINDS } from "../app/lib/judge-basis-types";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("古い4つの語彙の値は全部1つの表に読み替えられる（取りこぼし0）", () => {
  for (const v of COMPOSE_NEXT) assert.ok(toNextDest(v, "compose_next"), `compose_next ${v}`);
  for (const v of LEAD_TOS) assert.ok(toNextDest(v, "lead_to"), `lead_tos ${v}`);
  for (const v of LEAD_TO) assert.ok(toNextDest(v, "lead_to"), `lead_to ${v}`);
  for (const v of LEAD_KINDS) assert.ok(toNextDest(v, "lead_kind"), `lead_kinds ${v}`);
  assert.equal(toNextDest("x", "lead_to"), null);
});

t("割れていた意味を分ける: send_property（送ってもらう）と keep（こちらが送る約束）は別の行き先", () => {
  assert.equal(toNextDest("send_property", "compose_next"), "ask_send");
  assert.equal(toNextDest("keep", "lead_to"), "keep_send");
  assert.equal(toNextDest("新着の約束", "lead_kind"), "keep_send");
  assert.equal(toNextDest("関係をつなぐ", "lead_kind"), "door");
  assert.equal(toNextDest("確認の約束", "lead_kind"), "wait_check");
});

t("優先の名前は judge-basis-types と同じ", () => {
  for (const d of NEXT_DEST) assert.ok((PRIORITY_KINDS as readonly string[]).includes(PRIORITY_OF_DEST[d]), d);
  for (const p of Object.values(PRIORITY_OF_NEED)) assert.ok((PRIORITY_KINDS as readonly string[]).includes(p));
  for (const d of Object.values(CHECK_DEPTH)) assert.ok((DEPTH_KINDS as readonly string[]).includes(d.base));
});

t("強さ: 7つの欄の push から・併せて・扉", () => {
  assert.equal(strengthFromSeven({ push: true, strength: "strong" }), "strong");
  assert.equal(strengthFromSeven({ push: true, strength: "mid" }), "invite");
  assert.equal(strengthFromSeven({ push: false, strength: null }, "お気に召されましたらご都合よろしいお日にちに"), "door");
  assert.equal(strengthFromSeven({ push: true, strength: "mid" }, "こちらのお部屋も併せて日曜日ご案内させて頂きます"), "together");
  assert.equal(strengthFromSeven(null), "none");
});

t("時機: 申込でない番に置いた『1部屋のみ・キャンセル料・独立系』は仕込み", () => {
  assert.equal(timingOf("keep_send", "保証会社も独立系の為審査基準緩く"), "plant");
  assert.equal(timingOf("apply", "1部屋のみの募集となりますので"), "now");
  assert.equal(timingOf("viewing", "ご都合よろしいお日にちに"), "now");
});

t("強さの上限: 検討＝扉・埋まる不安＝抑える線まで・残り×合図＝強く", () => {
  const base = { remaining: false, decideSignal: false, considering: false, firstContact: false, notHooked: false };
  assert.equal(strengthCeiling({ ...base, considering: true }).max, "door");
  assert.equal(strengthCeiling({ ...base, considering: true, takenWorry: true }).max, "strong");
  assert.equal(strengthCeiling({ ...base, remaining: true }).max, "strong");
  assert.equal(strengthCeiling({ ...base }).max, "invite");
  assert.equal(strengthCeiling({ ...base, notHooked: true, remaining: true }).max, "door");
  assert.ok(strengthOverCeiling("strong", { ...base, considering: true }));
  assert.ok(!strengthOverCeiling("door", { ...base, considering: true }));
});

t("型の表の全部の型に次の一手があり、名前は1つの表の物", () => {
  for (const x of CHECK_ORDER_TYPES) {
    const m = NEXT_MOVE_OF_TYPE[x.id];
    assert.ok(m, x.id);
    for (const mv of [m.usual, ...m.alt]) {
      assert.ok((NEXT_DEST as readonly string[]).includes(mv.dest), `${x.id} ${mv.dest}`);
      assert.ok((NEXT_STRENGTH as readonly string[]).includes(mv.strength), `${x.id} ${mv.strength}`);
    }
  }
  // 検討の型の既定は扉だけ・初回は押さない
  assert.equal(NEXT_MOVE_OF_TYPE.T6_considering.usual.strength, "door");
  assert.equal(NEXT_MOVE_OF_TYPE.T11_first_contact_hearing.usual.strength, "none");
});

t("竹内さんの198通で、強さが上限を超えた番は 5% 未満（上限の線が竹内さんと合う）", () => {
  const cache = join(__dirname, "..", "..", "..", "exam-cache");
  const sf = join(cache, "anatomy-seven", "seven-all198.json"), rf = join(cache, "anatomy-roles", "roles-r1.json");
  if (!existsSync(sf) || !existsSync(rf)) { console.log("   （198通の材料が無い＝飛ばす）"); return; }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { takeuchiMove } = require("./next-move-score") as typeof import("./next-move-score");
  const S = JSON.parse(readFileSync(sf, "utf8")) as Parameters<typeof takeuchiMove>[0][];
  const R = new Map((JSON.parse(readFileSync(rf, "utf8")) as Array<{ id: string }>).map((r) => [r.id, r]));
  let over = 0, all = 0;
  for (const s of S) { const r = R.get(s.id); if (!r) continue; all++; const m = takeuchiMove(s, r as Parameters<typeof takeuchiMove>[1]); if (strengthOverCeiling(m.strength, m.cues)) over++; }
  assert.ok(all >= 190, `通数 ${all}`);
  assert.ok(over / all < 0.05, `上限を超えた ${over}/${all}`);
  console.log(`   （上限を超えた ${over}/${all}）`);
});

console.log(`全部 ${n} 件 ok`);

// 2026-11-12: 返信の文からの網（台帳用）の当たりを 198通の7つの欄の lead と比べる（線の確かめ・判断には使わない）
{
  const cache = join(__dirname, "..", "..", "..", "exam-cache");
  const sf = join(cache, "anatomy-seven", "seven-all198.json"), rf = join(cache, "anatomy-roles", "roles-r1.json");
  if (existsSync(sf) && existsSync(rf)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { nextMoveFromText, toNextDest: tnd } = require("../app/lib/next-move-types") as typeof import("../app/lib/next-move-types");
    const S = JSON.parse(readFileSync(sf, "utf8")) as Array<{ id: string; reads: Array<{ lead: string | null }> }>;
    const R = new Map((JSON.parse(readFileSync(rf, "utf8")) as Array<{ id: string; sentences?: string[] }>).map((r) => [r.id, r]));
    let hit = 0, all = 0; const miss = new Map<string, number>();
    for (const s of S) { const r = R.get(s.id); if (!r) continue; all++; const g = tnd(s.reads[0]?.lead ?? null, "lead_to") ?? "none"; const m = nextMoveFromText((r.sentences ?? []).join("\n")).dest; const same = g === m || (g === "keep_send" && (m === "door" || m === "wait_check")) || (g === "answer_only" && m === "door"); if (same) hit++; else { const k = `${g}→${m}`; miss.set(k, (miss.get(k) ?? 0) + 1); } }
    console.log(`   返信の文からの行き先の網: ${hit}/${all}（扉と約束・答えの境・確認の約束と送る約束＝7つの欄では同じ keep は同じに数えた）・外れ上位 ${[...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join("・")}`);
    assert.ok(hit / all >= 0.6, `網の当たりが低い ${hit}/${all}`);
  }
}
