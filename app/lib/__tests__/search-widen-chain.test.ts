// 2026-09-27 竹内「まずピンポイント検索して、なければ広げて検索する形（おススメの物件や新着物件がなければ）」のテスト。
// 実行: npx tsx app/lib/__tests__/search-widen-chain.test.ts
// お客様の個人情報は無い（id・時刻は作った物）
import {
  decideWiden, classifyKind, pinpointSession, widenChainNotes, roundSearchModeLine, sessionRpUpdateDays, commandSiteOf, pickupSiteOf,
  NEW_CUSTOMER_MIN_PASS, ADDITIONAL_MIN_PASS, ROWS_WAIT_MS, BOTH_PASS_WAIT_MS,
  type AuditLite, type PickupLite, type ChainCommandLite,
} from "../search-widen-chain";
import { PICKUP_AIX_MAX } from "../pickup-aix-handoff";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}
const NOW = Date.parse("2026-09-27T05:00:00Z");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const NEW_SNAP = { desired_area: "梅田", rent_max: 80000 };
const OLD_SNAP = { desired_area: "梅田", rent_max: 80000, last_property_sent_at: "2026-09-20T01:00:00Z" };
function audit(p: Partial<AuditLite> & { min: number }): AuditLite {
  return {
    run_id: p.run_id ?? `sa_${p.min}`, created_at: iso(p.min), finished_at: p.finished_at ?? iso(p.min - 3), status: p.status ?? "finished",
    site: p.site ?? "realpro", mode: p.mode ?? "brain_normal", trigger: p.trigger ?? "web_brain", is_wide: p.is_wide === undefined ? false : p.is_wide,
    pass: p.pass ?? null, result: p.result === undefined ? { sent_count: 3, read_rows: 3 } : p.result, customer_snapshot: p.customer_snapshot === undefined ? NEW_SNAP : p.customer_snapshot,
    intended: p.intended ?? { rp_update_days: null }, ext_version: p.ext_version ?? "2.5.28",
  };
}
function rows(n: number, pass: number, o: Partial<PickupLite> & { min: number }): PickupLite[] {
  return Array.from({ length: n }, (_, i) => ({ id: 1000 + i + o.min * 100, created_at: iso(o.min), site: o.site ?? "realpro", verdict: i < pass ? "pass" : "hold", search_mode: o.search_mode === undefined ? "pinpoint" : o.search_mode, complete_group_id: o.complete_group_id === undefined ? "g1" : o.complete_group_id }));
}
const D = (x: Partial<Parameters<typeof decideWiden>[0]>) => decideWiden({ site: "realpro", audits: [], rows: [], commands: [], nowMs: NOW, ...x });

console.log("■ 数の決まり");
t("新規は上位10件（ピックアップに選ぶ数）・新着／追加は1件", NEW_CUSTOMER_MIN_PASS === 10 && NEW_CUSTOMER_MIN_PASS === PICKUP_AIX_MAX && ADDITIONAL_MIN_PASS === 1);
t("新規＝検索を始めた時の写しに送った日・確認した日が無い", classifyKind(NEW_SNAP, null) === "new" && classifyKind(OLD_SNAP, null) === "additional" && classifyKind({ property_viewed_at: "2026-09-01T00:00:00Z" }, null) === "additional");
t("写しが無い時は前の送付の件数（0なら新規・分からなければ追加）", classifyKind(null, 0) === "new" && classifyKind(null, 3) === "additional" && classifyKind(null, null) === "additional");
t("サイトの呼び名", commandSiteOf("realpro") === "realnetpro" && commandSiteOf("itandi") === "itandi" && commandSiteOf("reins") === null && pickupSiteOf("realnetpro") === "realpro");

console.log("■ 新規: 10件未満なら広げる");
{
  const a = [audit({ min: 20 })];
  const d = D({ audits: a, rows: rows(6, 4, { min: 15 }) });
  t("通す 4件（6件中）→ 広げる", d.action === "widen" && d.chain.kind === "new" && d.chain.pass_count === 4 && d.chain.threshold === 10, d);
  t("積む印に元の回と更新日（新規は絞らない）", d.action === "widen" && d.chain.pinpoint_run_ids[0] === "sa_20" && d.chain.rp_update_days === null && d.chain.site === "realpro", d);
  const e = D({ audits: a, rows: rows(12, 10, { min: 15 }) });
  t("通す 10件 → 足りている（広げない）", e.action === "enough" && e.passCount === 10, e);
  const h = D({ audits: a, rows: rows(15, 9, { min: 15 }) });
  t("15件届いても通すが 9件なら広げる（保留・外す候補は数えない）", h.action === "widen" && h.chain.pass_count === 9, h);
}

console.log("■ 新着・追加: 0件なら広げる");
{
  const a = [audit({ min: 20, customer_snapshot: OLD_SNAP, intended: { rp_update_days: 7 } })];
  const d = D({ audits: a, rows: rows(3, 0, { min: 15 }) });
  t("通す 0件（保留3件）→ 広げる・更新日はピンポイントの回と同じ 7日", d.action === "widen" && d.chain.kind === "additional" && d.chain.threshold === 1 && d.chain.rp_update_days === 7, d);
  const e = D({ audits: a, rows: rows(3, 1, { min: 15 }) });
  t("通す 1件 → 足りている", e.action === "enough" && e.kind === "additional", e);
  const z = D({ audits: [audit({ min: 12, customer_snapshot: OLD_SNAP, result: { sent_count: 0, read_rows: 0 } })], rows: [] });
  t("検索が0件（行が届かない）→ すぐ広げる", z.action === "widen" && z.chain.pass_count === 0, z);
  const zf = D({ audits: [audit({ min: 4, finished_at: iso(0), customer_snapshot: OLD_SNAP, result: { sent_count: 0, read_rows: 0 } })], rows: [], fromAuditFinish: true });
  t("検索の点検の finished から: 送れる物件0件 → その場で広げる", zf.action === "widen", zf);
}

console.log("■ 待つ（まだ決めない）");
{
  t("検索中（started）", D({ audits: [audit({ min: 3, status: "started", finished_at: null })] }).action === "wait");
  const fin = D({ audits: [audit({ min: 4, finished_at: iso(0) })], fromAuditFinish: true });
  t("finished から: 送れる物件があった回はまとめの時に決める", fin.action === "wait" && fin.reason === "rows_coming", fin);
  const unk = D({ audits: [audit({ min: 4, finished_at: iso(0), result: null })], fromAuditFinish: true });
  t("finished から: 結果が分からない回も待つ", unk.action === "wait", unk);
  const coming = D({ audits: [audit({ min: 6, finished_at: iso(2) })], rows: [] });
  t("送れる物件があったのに行がまだ無い（8分以内）→ 待つ", coming.action === "wait" && coming.reason === "rows_coming", coming);
  const late = D({ audits: [audit({ min: 20, finished_at: iso((ROWS_WAIT_MS / 60_000) + 1) })], rows: [] });
  t("8分を過ぎても行が無い（全部送付済みで作られなかった）→ 0件で決める", late.action === "widen" && late.chain.pass_count === 0, late);
  const nc = D({ audits: [audit({ min: 20 })], rows: rows(3, 1, { min: 15, complete_group_id: null }) });
  t("行がまだまとめられていない（判定・画像の読み取りの途中）→ 待つ", nc.action === "wait" && nc.reason === "not_complete", nc);
  const ward = D({ audits: [audit({ min: 5, pass: "ward", finished_at: iso(1), result: { sent_count: 0 } })] });
  t("地域→駅の2パスの1つ目が終わったところ → 2つ目を待つ", ward.action === "wait" && ward.reason === "both_pass", ward);
  const ward2 = D({ audits: [audit({ min: 20, pass: "ward", finished_at: iso((BOTH_PASS_WAIT_MS / 60_000) + 1), result: { sent_count: 0 } })] });
  t("1つ目の後 5分たっても2つ目が始まらない → 決める", ward2.action === "widen", ward2);
}

console.log("■ 2パス（地域→駅）は1つの回として数える");
{
  const a = [audit({ min: 30, pass: "ward", run_id: "w" }), audit({ min: 22, pass: "station", run_id: "s" })];
  const s = pinpointSession(a, "realpro", NOW);
  t("同じ回（2つ）・始まりは1つ目", !!s && s.runs.length === 2 && s.startMs === Date.parse(iso(30)), s);
  const d = D({ audits: a, rows: [...rows(4, 4, { min: 26 }), ...rows(3, 3, { min: 18 })] });
  t("通すは2パスの合計（7件）", d.action === "widen" && d.chain.pass_count === 7 && d.chain.pinpoint_run_ids.length === 2, d);
}

console.log("■ 広げない（止める）");
{
  t("広げての回の後", D({ audits: [audit({ min: 20, is_wide: true })], rows: rows(2, 0, { min: 15, search_mode: "widen" }) }).action === "skip");
  t("ブレイン×スタッフ（人が選んで送る）", D({ audits: [audit({ min: 20, mode: "brain_staff" })], rows: rows(2, 0, { min: 15 }) }).action === "skip");
  t("メモの上書きの回（人が範囲を決めた）", D({ audits: [audit({ min: 20, customer_snapshot: { ...NEW_SNAP, _search_override: { location: "大正駅" } } })], rows: rows(2, 0, { min: 15 }) }).action === "skip");
  t("レインズ（物件が届かない）", D({ site: "reins", audits: [audit({ min: 20, site: "reins" })] }).action === "skip");
  t("個別の検索は 2.5.28 より前の拡張では広げない（広げての個別の検索が is_wide=false で記録されていた）", D({ audits: [audit({ min: 20, trigger: "single", ext_version: "2.5.27" })], rows: rows(2, 0, { min: 15 }) }).reason === "old_ext_single");
  t("個別の検索も 2.5.28 からは広げる", D({ audits: [audit({ min: 20, trigger: "single", ext_version: "2.5.28" })], rows: rows(2, 0, { min: 15 }) }).action === "widen");
  t("比較の検索（scrape_compare）", D({ audits: [audit({ min: 20, trigger: "scrape_compare" })], rows: rows(2, 0, { min: 15 }) }).action === "skip");
  t("検索の点検が無い（分からない時は検索しない）", D({ rows: rows(2, 0, { min: 15 }) }).action === "skip");
  t("広げてかどうか分からない回（is_wide が null）", D({ audits: [audit({ min: 20, is_wide: null })], rows: rows(2, 0, { min: 15 }) }).action === "skip");
  const chained: ChainCommandLite = { id: "c1", created_at: iso(10), status: "done", sites: ["realnetpro"], customer_ids: ["p1"], payload: { source: "web_brain", is_wide: true, chain: { from: "pinpoint", kind: "new", pass_count: 4, threshold: 10, pinpoint_run_ids: ["sa_20"], pinpoint_started_at: iso(20), site: "realpro", rp_update_days: null } } };
  const once = D({ audits: [audit({ min: 20 })], rows: rows(2, 0, { min: 15 }), commands: [chained] });
  t("1回だけ: この回の後に自動の広げてを積んだ（広げても足りなくても、もう積まない）", once.action === "skip" && once.reason === "already_chained", once);
  const other: ChainCommandLite = { ...chained, id: "c2", sites: ["itandi"], payload: { ...chained.payload, chain: { ...chained.payload!.chain!, site: "itandi" } } };
  t("別のサイト（itandi）の広げては数えない", D({ audits: [audit({ min: 20 })], rows: rows(2, 0, { min: 15 }), commands: [other] }).action === "widen");
  const queued: ChainCommandLite = { id: "c3", created_at: iso(1), status: "pending", sites: ["realnetpro"], customer_ids: ["p1"], payload: { source: "web_brain", is_wide: false } };
  t("同じお客様×サイトの一括検索が待ち・実行中なら積まない", D({ audits: [audit({ min: 20 })], rows: rows(2, 0, { min: 15 }), commands: [queued] }).reason === "queued");
  const oldChain = { ...chained, created_at: iso(170) };
  t("前の回（もっと前）の自動の広げては今回を止めない", D({ audits: [audit({ min: 20 })], rows: rows(2, 0, { min: 15 }), commands: [oldChain] }).action === "widen");
  t("3時間より前の検索では広げない", D({ audits: [audit({ min: 200 })], rows: rows(2, 0, { min: 190 }) }).action === "skip");
  const widenRows = D({ audits: [audit({ min: 20 })], rows: [...rows(5, 5, { min: 15 }), ...rows(8, 8, { min: 14, search_mode: "widen" })] });
  t("広げての行はピンポイントの数に入れない", widenRows.action === "widen" && widenRows.chain.pass_count === 5, widenRows);
  const olderRows = D({ audits: [audit({ min: 20 })], rows: [...rows(2, 2, { min: 15 }), ...rows(9, 9, { min: 60 })] });
  t("前の回の行は数えない", olderRows.action === "widen" && olderRows.chain.pass_count === 2, olderRows);
}

console.log("■ 更新日（広げての回もピンポイントと同じ新着の幅）");
{
  t("入れようとした値", sessionRpUpdateDays([audit({ min: 10, intended: { rp_update_days: 3 } })], NOW) === 3);
  t("入れようとした値が空＝絞らない", sessionRpUpdateDays([audit({ min: 10, intended: { rp_update_days: null } })], NOW) === null);
  t("無ければ写しから（前回 7日前 → 7）", sessionRpUpdateDays([{ ...audit({ min: 10, customer_snapshot: { last_property_sent_at: new Date(NOW - 6.5 * 86400_000).toISOString() } }), intended: null }], NOW) === 7);
}

console.log("■ 画面の1行");
{
  const base: ChainCommandLite = { id: "c1", created_at: iso(10), status: "pending", sites: ["realnetpro"], customer_ids: ["p1"], payload: { source: "web_brain", is_wide: true, chain: { from: "pinpoint", kind: "new", pass_count: 4, threshold: 10, pinpoint_run_ids: ["sa_20"], pinpoint_started_at: iso(20), site: "realpro", rp_update_days: null } } };
  const n1 = widenChainNotes([base], [], NOW);
  t("積んだ（待ち）", n1.length === 1 && /ピンポイントで通す物件が 4件/.test(n1[0].line) && /積みました/.test(n1[0].line) && n1[0].tone === "info", n1);
  const done = { ...base, status: "done" };
  const n2 = widenChainNotes([done], rows(3, 2, { min: 5, search_mode: "widen" }), NOW);
  t("広げても足りない → ここで止めます", n2[0].tone === "stop" && /広げて通す物件 2件・合わせて 6件/.test(n2[0].line) && /ここで止めます/.test(n2[0].line), n2);
  const n3 = widenChainNotes([done], rows(8, 7, { min: 5, search_mode: "widen" }), NOW);
  t("広げて足りた", n3[0].tone === "info" && !/止めます/.test(n3[0].line), n3);
  const n4 = widenChainNotes([{ ...base, status: "error" }], [], NOW);
  t("動かなかった（ブレインの PC が無い等）", n4[0].tone === "warn", n4);
  t("chain の無いコマンドは出さない", widenChainNotes([{ ...base, payload: { source: "web_brain" } }], [], NOW).length === 0);
  const r = roundSearchModeLine([{ search_mode: "pinpoint" }, { search_mode: "pinpoint" }, { search_mode: "widen" }, { search_mode: null }]);
  t("回の1行: 両方ある時は件数を並べる", !!r && r.mixed && r.line === "🎯 ピンポイント 2件・🔎 広げて 1件・検索の種類が分からない 1件", r);
  t("回の1行: どちらも分からない回は出さない", roundSearchModeLine([{ search_mode: null }, {}]) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
