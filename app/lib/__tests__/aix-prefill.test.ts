// 実行: npx tsx app/lib/__tests__/aix-prefill.test.ts
// 2026-10-01 竹内「AIX 開いたら、確認した要件以外は全てセットされていて、スタッフは確認したことだけ入れたら良い」
import { propertyNamePrefill, propertyBaseName, customerTurnOf, sendModePrefill, pickupTypePrefill, areaFromConditions, summarizePrefillUse, sanitizePrefill, prefillNote } from "../aix-prefill";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

// ── 物件名 ──
t("建物名（号室・階・空白を外す）", propertyBaseName("プレサンス梅田北ザ・ライブ 305号室") === "プレサンス梅田北ザ・ライブ" && propertyBaseName("プルス新北野 3階") === "プルス新北野");
{
  const p = propertyNamePrefill({ pickupNames: ["都島岡本マンション 305"], staffSent: ["別の物件 101号室"] });
  t("① 売上サポが一番", p?.value === "都島岡本マンション 305" && p.source === "pickup", JSON.stringify(p));
}
{
  // 監査で外した決め方（共有文が1件・送った物件が1件だけ）では入れない
  t("お客様の共有文が1件だけでは入れない（監査 当たり2・外れ4）", propertyNamePrefill({ customerSharedThisTurn: ["プルス新北野"], staffSent: ["A棟 101号室", "B棟 202号室"] }) === null);
  t("送った物件が1件だけでも入れない（監査 当たり1・外れ13）", propertyNamePrefill({ staffSent: ["レオンコンフォート梅田北 703号室"], customerTurnText: "写真ありますか？" }) === null);
}
{
  const sent = ["レオンコンフォート梅田北 703号室", "プレサンス梅田北ザ・ライブ 305号室"];
  const p = propertyNamePrefill({ staffSent: sent, customerTurnText: "プレサンス梅田北ザ・ライブの室内写真ありますか？" });
  t("② 送った物件のうちお客様が名前を出した物", p?.value === "プレサンス梅田北ザ・ライブ 305号室" && p.source === "conversation", JSON.stringify(p));
  t("② 名前が出ない → 決めない", propertyNamePrefill({ staffSent: sent, customerTurnText: "写真ありますか？" }) === null);
}
{
  const msgs = [{ sender: "customer", text: "a" }, { sender: "staff", text: "b" }, { sender: "customer", text: "c" }, { sender: "customer", text: "d" }, { sender: "staff", text: "e" }];
  t("お客様の直近の連投（末尾のこちらの発言は飛ばす）", customerTurnOf(msgs).map((m) => m.text).join("") === "cd");
}

// ── 物件を送った種類（実測: ピックアップ 363件で 77%・オススメ 21件で 81%）──
{
  const now = Date.parse("2026-10-01T03:00:00Z");
  const old = { aix_type: "property_send", created_at: "2026-09-28T03:00:00Z" };
  const justNow = { aix_type: "property_send", created_at: "2026-10-01T02:50:00Z" };
  t("前に送った記録あり → 新着", sendModePrefill([old], now).value === "new_arrival");
  t("直前1時間の送付（同じ回）は数えない → 初回", sendModePrefill([justNow], now).value === "normal");
  t("物件オススメも同じ線", pickupTypePrefill([old], now).value === "新着1件" && pickupTypePrefill([], now).value === "新規ピックアップ");
  t("他の AIX は数えない", sendModePrefill([{ aix_type: "estimate_sheet", created_at: old.created_at }], now).value === "normal");
}

// ── エリア ──
t("条件のエリア（エリア: ／エリア：）", areaFromConditions("家賃: 7〜10万\nエリア: 都島区、北区\n間取り: 2LDK")?.value === "都島区、北区" && areaFromConditions("エリア：天王寺")?.value === "天王寺");
t("エリアが無い・未定は入れない", areaFromConditions("家賃: 7万") === null && areaFromConditions("エリア: 未定") === null);

// ── 記録 ──
{
  const pf = { value: "都島岡本マンション 305", source: "pickup" as const, reason: "" };
  const s = summarizePrefillUse([
    { field: "viewingPropertyName", prefilled: pf, final: "都島岡本マンション  305" },
    { field: "meetingPropertyName", prefilled: pf, final: "別の物件" },
    { field: "appPropertyName", prefilled: null, final: "x" },
  ]);
  t("そのまま使った（空白の違いは同じ）／直した（最後の値を残す）／入れていない欄は残さない",
    s?.viewingPropertyName?.kept === true && s?.meetingPropertyName?.kept === false && s?.meetingPropertyName?.final === "別の物件" && !s?.appPropertyName, JSON.stringify(s));
  t("整え: 知らない出所・壊れた形は落とす", JSON.stringify(sanitizePrefill({ a: { value: "x", source: "nope", kept: true }, b: { value: "y", source: "pickup", kept: false } })) === JSON.stringify({ b: { value: "y", source: "pickup", kept: false } }));
  t("欄の札", prefillNote(pf) === "（売上サポから自動・違えば直す）");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
