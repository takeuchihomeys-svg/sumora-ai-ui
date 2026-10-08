// 2026-10-08 未桜事例: 下書きは作られていたのに、別の端末・読み込み直しで入力欄が空だった（表示済みの印で本文が消える）
// 実行: npx tsx app/lib/__tests__/shown-draft-restore.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { decideShownDraftRestore, shownDraftUpdate, shownDraftRestoreEnabled } from "../shown-draft-restore";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

// 本番の実物（未桜 22b2511e・10/08）: お客様 05:15:09Z「ここはもう埋まっちゃてますか？」→ 下書き 05:15:52Z
const MIO_DRAFT = "未桜さんお世話になっております！！\nお送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😊！！";
const base = { aiDraft: "__SHOWN__", shownDraft: MIO_DRAFT, shownAt: "2026-10-08T05:15:53.000Z", latestCustomerAt: "2026-10-08T05:15:09.578Z", lastSender: "customer" };

it("未桜: 表示済みで控えが今の番 → 戻す", () => {
  const r = decideShownDraftRestore(base);
  eq(r.reason, "restore"); eq(r.text, MIO_DRAFT);
});
it("スタッフが送った後は戻さない", () => eq(decideShownDraftRestore({ ...base, lastSender: "staff" }).reason, "not_customer_turn"));
it("ai_draft が本文（まだ表示されていない）なら戻さない（通常の表示に任せる）", () => eq(decideShownDraftRestore({ ...base, aiDraft: MIO_DRAFT }).reason, "not_shown"));
it("ai_draft が null（新着で webhook が空に戻した）なら戻さない", () => eq(decideShownDraftRestore({ ...base, aiDraft: null }).reason, "not_shown"));
it("[AIX誘導中] の時は戻さない（ブレインが AIX の番）", () => eq(decideShownDraftRestore({ ...base, aiDraft: "[AIX誘導中]" }).reason, "not_shown"));
it("控えが無い（旧の表示・generate-reply の前と同じ文の __SHOWN__）→ 戻さない", () => eq(decideShownDraftRestore({ ...base, shownDraft: null }).reason, "no_copy"));
it("前の番の控え（お客様の新しい発言より前に表示）→ 戻さない", () => {
  eq(decideShownDraftRestore({ ...base, shownAt: "2026-10-07T03:51:10.000Z" }).reason, "older_turn");
});
it("控えが印だけ → 戻さない", () => eq(decideShownDraftRestore({ ...base, shownDraft: "[返信不要]" }).reason, "copy_is_sentinel"));
it("時刻が読めない → 戻さない", () => eq(decideShownDraftRestore({ ...base, latestCustomerAt: null }).reason, "no_time"));
it("前後の空白は落として返す", () => eq(decideShownDraftRestore({ ...base, shownDraft: `  ${MIO_DRAFT}\n` }).text, MIO_DRAFT));

it("shownDraftUpdate: 旗 on は本文と時刻を控える", () => {
  const u = shownDraftUpdate(MIO_DRAFT, true, new Date("2026-10-08T05:16:00.000Z"));
  eq(u, { ai_draft: "__SHOWN__", suggested_aix_meta: null, ai_draft_shown: MIO_DRAFT, ai_draft_shown_at: "2026-10-08T05:16:00.000Z" });
});
it("shownDraftUpdate: 旗 off は旧の中身のまま", () => eq(shownDraftUpdate(MIO_DRAFT, false), { ai_draft: "__SHOWN__", suggested_aix_meta: null }));
it("shownDraftUpdate: 印・空は控えない", () => {
  eq(shownDraftUpdate("[AIX誘導中]", true), { ai_draft: "__SHOWN__", suggested_aix_meta: null });
  eq(shownDraftUpdate("", true), { ai_draft: "__SHOWN__", suggested_aix_meta: null });
});
it("旗: 既定 on・off だけ止める", () => {
  eq(shownDraftRestoreEnabled(undefined), true); eq(shownDraftRestoreEnabled("on"), true); eq(shownDraftRestoreEnabled("OFF"), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
