// 画像の種類ごとの欄の埋まり（2026-11-21 作業員G・#505 の子）
// 実行: npx tsx app/lib/__tests__/image-field-fill.test.ts
import { customerFillMetrics, sentFillMetrics, sentChannelOf, counterKitchenAgreement } from "../image-field-fill";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

const scr = (name: string | null, station: string | null) => ({ kind: "property_screen", property_name: name, station });
const cust = [scr("A", "梅田"), scr("B", null), scr(null, null), scr("", "難波"), scr("C", "本町"), { kind: "document", property_name: null }];
const cm = customerFillMetrics(cust);
const nm = cm.find((m) => m.metric === "image_fill:customer:property_screen:property_name");
ok("ポータルの画面の名前 3/5（空文字は空）", nm?.value === 0.6 && nm.n === 5);
ok("書類は数えない", !cm.some((m) => m.metric.includes("document")));
ok("5枚未満の種類は書かない", customerFillMetrics(cust.slice(0, 4)).length === 0);

const s = (ch: string | null, src: string, name: string | null, facts: Record<string, unknown> | null) => ({ channel: ch, source: src, property_name: name, room_no: null, facts });
const sent = [s("pickup", "aix:property_send", "A", { rent: 1, station: "x" }), s("pickup", "aix:property_send", "B", { rent: 1 }), s("pickup", "aix:property_send", null, null),
  s("pickup", "aix:property_send", "C", {}), s("pickup", "aix:property_send", "D", { rent: 2 }), s(null, "vision", "E", null)];
const sm = sentFillMetrics(sent);
ok("送った経路ごと（pickup の家賃 3/5）", sm.find((m) => m.metric === "image_fill:sent:pickup:rent")?.value === 0.6);
ok("経路が無い vision は vision に分ける", sentChannelOf(sent[5]) === "vision");
ok("1枚だけの経路は書かない", !sm.some((m) => m.metric.includes(":vision:")));

// カウンターキッチンの文字の札と画像の読みの食い違い（#587）
{
  const a = counterKitchenAgreement([
    { id: 1, text: "ok", image: true }, { id: 2, text: "ok", image: false }, { id: 3, text: null, image: true },
    { id: 4, text: null, image: false }, { id: 5, text: "ng", image: true }, { id: 6, text: "ok", image: null },
  ]);
  const v = (k: string) => a.metrics.find((m) => m.metric === `image_mismatch:counter_kitchen:${k}`)?.value;
  ok("同じ 1・文字有る画像無い 1・文字無い画像有る 1", v("agree") === 1 && v("text_ok_image_ng") === 1 && v("text_ng_image_ok") === 1);
  ok("図だけで読んだ例（文字に無い）", v("image_only_ok") === 1 && v("image_only_ng") === 1 && a.imageOnlyIds.join() === "3");
  ok("画像で読んでいない行は数えない（n=5）", a.metrics[0].n === 5);
  ok("食い違いの id を出す", a.mismatchIds.join() === "2,5");
}

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
