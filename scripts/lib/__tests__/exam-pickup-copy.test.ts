// 試験の写しの property_pickups（scripts/lib/exam-pickup-copy.ts・弱い所 303）
// 実行: npx tsx scripts/lib/__tests__/exam-pickup-copy.test.ts（自己完結。全 PASS で exit 0）
import { splitPickupNames, pickupTriggerStillSkips, examPickupNameLateOn } from "../exam-pickup-copy";
let fail = 0, pass = 0;
function eq(name: string, a: unknown, b: unknown) { const ok = JSON.stringify(a) === JSON.stringify(b); if (ok) pass++; else { fail++; console.error(`✗ ${name}\n   得: ${JSON.stringify(a)}\n   期: ${JSON.stringify(b)}`); } }

const rows = [{ property_name: "セレニテ天満橋アリア", room_no: "1104", status: "sent" }, { property_name: null, room_no: "1" }, { property_name: "", room_no: "2" }];
const s = splitPickupNames(rows);
eq("insert の名前は全部空", s.insertRows.map((r) => r.property_name), ["", "", ""]);
eq("ほかの列はそのまま", s.insertRows.map((r) => r.room_no), ["1104", "1", "2"]);
eq("あとで入れる名前（空・null は null）", s.names, ["セレニテ天満橋アリア", null, null]);
eq("元の行は書き換えない", rows[0].property_name, "セレニテ天満橋アリア");

// 11/05 の本番の定義（pg_get_triggerdef・関数の先頭）
const trg = "CREATE TRIGGER rent_observe_pickup_trg AFTER INSERT OR UPDATE OF equipment, terms, status, sent_at, recommended, location ON public.property_pickups FOR EACH ROW EXECUTE FUNCTION rent_observe_pickup()";
const fn = "BEGIN\n  k := rent_unit_key(p.property_name, p.room_no);\n  IF coalesce(p.property_name, '') = '' THEN RETURN; END IF;\n";
eq("今の定義は止まる", pickupTriggerStillSkips(trg, fn).ok, true);
eq("UPDATE OF に名前が入ったら印", pickupTriggerStillSkips(trg.replace("location ON", "location, property_name ON"), fn).why, ["UPDATE OF に property_name がある"]);
eq("全部の UPDATE で発火したら印", pickupTriggerStillSkips("CREATE TRIGGER x AFTER INSERT OR UPDATE ON public.property_pickups FOR EACH ROW EXECUTE FUNCTION f()", fn).why, ["UPDATE OF の列が無い（全部の UPDATE で発火する）"]);
eq("名前が空の RETURN が消えたら印", pickupTriggerStillSkips(trg, "BEGIN\n  k := 1;\n").why, ["名前が空なら RETURN が無い"]);
eq("既定 on", examPickupNameLateOn({}), true);
eq("off で止める", examPickupNameLateOn({ EXAM_PICKUP_NAME_LATE: "off" }), false);
console.log(`${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 0);
