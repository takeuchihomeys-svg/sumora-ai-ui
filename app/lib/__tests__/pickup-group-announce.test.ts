// 2026-09-29 竹内「売上番長のグループにアナウンスされるのは、AIX ツールで物件の解析が終わった時にする…PDF もここに添付しなくて大丈夫（ブレインの際）。
//   ブレイン以外の状態なら今まで通りここのグループに共有する」— ★物件出し★グループへ いつ・何を送るか のテスト
// 実行: npx tsx app/lib/__tests__/pickup-group-announce.test.ts
// 物件は YUMA（テスト用）の回 cg_509cd061_716 の実物の説明文
import { readFileSync } from "fs";
import { join } from "path";
import { groupNoticePlan, announcePlan, buildAnnouncement, announceLink, announcePoints, siteLabelJa, GROUP_NOTICE_DEFERRED, type AnnounceItem } from "../pickup-group-announce";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}

console.log("\n■ いつ送るか（merge-pdfs）");
{
  const base = { sendToLine: true, brainMode: true, staffMode: false, hasCustomer: true };
  const b = groupNoticePlan(base);
  t("ブレイン（web_brain・自動便・AIX の検索）: 検索のたびは送らず解析の完了で", !b.perSearch && b.deferred && b.reason === "brain");
  const n = groupNoticePlan({ ...base, brainMode: false });
  t("ブレイン以外（通常・手動の一括）: 今まで通り検索のたびに", n.perSearch && !n.deferred && n.reason === "not_brain");
  t("brainMode が無い（古い拡張）: 今まで通り", groupNoticePlan({ ...base, brainMode: null }).perSearch);
  const s = groupNoticePlan({ ...base, staffMode: true });
  t("スタッフモード（ブレイン ON でも）: 今まで通り", s.perSearch && !s.deferred && s.reason === "staff_mode");
  const nc = groupNoticePlan({ ...base, hasCustomer: false });
  t("お客様が分からない回（自動まとめに乗らない）: 今まで通り", nc.perSearch && !nc.deferred && nc.reason === "no_customer");
  t("PICKUP_GROUP_DEFER=off: 今まで通り", groupNoticePlan({ ...base, deferEnv: "off" }).perSearch && groupNoticePlan({ ...base, deferEnv: "OFF" }).reason === "env_off");
  t("別の値の環境変数は効かない", groupNoticePlan({ ...base, deferEnv: "on" }).deferred);
  const nl = groupNoticePlan({ ...base, sendToLine: false });
  t("LINE に送らない回はどちらも無し", !nl.perSearch && !nl.deferred);
  t("印の値", GROUP_NOTICE_DEFERRED === "deferred");
}

console.log("\n■ 送るか（解析の完了・二重に送らない）");
{
  const rows = [{ id: 3, group_notice: "deferred" }, { id: 1, group_notice: "deferred" }, { id: 2, group_notice: null }];
  const p1 = announcePlan(rows, null);
  t("初回: deferred の行があれば送る", p1.send && !p1.update && JSON.stringify(p1.newIds) === "[1,3]" && JSON.stringify(p1.announcedAfter) === "[1,3]", p1);
  const p2 = announcePlan(rows, p1.announcedAfter);
  t("同じまとめをもう一度（Cron のやり直し・alarm・詳細を開いた）: 送らない", !p2.send && p2.newIds.length === 0);
  const p3 = announcePlan([...rows, { id: 9, group_notice: "deferred" }], p1.announcedAfter);
  t("遅れて届いた回が足された: 追加分として1回", p3.send && p3.update && JSON.stringify(p3.newIds) === "[9]" && JSON.stringify(p3.announcedAfter) === "[1,3,9]", p3);
  t("追加されたのがブレイン以外の行だけ: 送らない", !announcePlan([...rows, { id: 10, group_notice: null }], p1.announcedAfter).send);
  const none = announcePlan([{ id: 5, group_notice: null }, { id: 6 }], null);
  t("deferred が無いまとめ（ブレイン以外・デプロイ前の行・スタッフモード）: 送らない", !none.send && none.announcedAfter.length === 0);
  t("空のまとめ: 送らない", !announcePlan([], null).send);
}

console.log("\n■ 何を送るか（YUMA の実物）");
const ITEMS: AnnounceItem[] = [
  { id: 728, verdict: "pass", status: "pending", score: 163, reason_codes: [], image_analysis: null, summary_text: "【2🌟★】セレニテ福島プリエ 1402号室\n73,000円 7,200円\n1K 21.31㎡\n環状線「西九条」徒歩8分\nAD 2.5ヶ月" },
  { id: 745, verdict: "pass", status: "sent", score: 163, summary_text: "【1🌟★】スプランディッド中之島DUE 704号室\n79,000円 8,000円\n1K 25.5㎡\n千日前線「玉川」徒歩10分\nAD 2ヶ月" },
  { id: 722, verdict: "pass", status: "pending", score: 163, summary_text: "【6】エスリードレジデンス大阪福島サウスフラッツ 0303号室\n71,000円 10,000円\n1K 22.91㎡\n千日前線「玉川」徒歩5分\nAD 3ヶ月" },
  { id: 721, verdict: "hold", status: "pending", score: 101, summary_text: "【6🌟】S-RESIDENCE福島Alovita 407号室\n71,000円 10,000円\n1K 23.27㎡\n環状線「西九条」徒歩9分\nAD 3ヶ月" },
  { id: 700, verdict: "drop", status: "pending", score: 60, summary_text: "【9】外す物件 101号室\n90,000円" },
  { id: 701, verdict: "pass", status: "pending", score: 150, summary_text: null, property_name: "名前だけの物件", room_no: "203" },
];
{
  const text = buildAnnouncement({ customerName: "YUMAテスト（検索確認）", sites: { realpro: 5, itandi: 1 }, items: ITEMS, bestId: 728, link: "https://x.test/conditions?pickup=509&batch=a.pdf" });
  const lines = text.split("\n");
  t("1行目: 解析が終わった知らせ", lines[0] === "🧠 AIXツールの解析が終わりました", lines[0]);
  t("2行目: お客様名＋サイトの件数（今までの見出しの形）", lines[1] === "YUMAテスト（検索確認）さん 物件（リアプロ 5・itandi 1）", lines[1]);
  t("👑 一番オススメ＝まとめの best_id・点", text.includes("👑 一番オススメ（163点）\nセレニテ福島プリエ 1402号室\n73,000円 7,200円"), text);
  t("拡張の🌟の印（【2🌟★】）は出さない", !/🌟/.test(text));
  t("上位はまとめの順位の順・👑 の次から【2】", text.includes("【2】エスリードレジデンス大阪福島サウスフラッツ 0303号室（163点）"), text);
  t("保留は印を付ける", text.includes("【3】S-RESIDENCE福島Alovita 407号室（101点・保留）"));
  t("説明文が無い物件は名前＋号室", text.includes("【4】名前だけの物件 203（150点）"));
  t("送信済み・外す候補は上位に出さない", !text.includes("スプランディッド") && !text.includes("外す物件"));
  t("件数（通す／保留／外す候補）", text.includes("全6件（通す 4・保留 1・外す候補 1）"), text);
  t("PDF のリンクは無い・AIXツールのリンク", !/物件PDF|\.pdf\b(?!$)/.test(text.replace("batch=a.pdf", "")) && text.endsWith("▶ AIXツールで見る\nhttps://x.test/conditions?pickup=509&batch=a.pdf"));
  const up = buildAnnouncement({ customerName: "未桜さん", sites: { realpro: 2 }, items: ITEMS.slice(0, 1), bestId: 728, link: null, update: true });
  t("追加分の時の見出し・さんを二重にしない・リンク無し", up.startsWith("🧠 AIXツールの解析が終わりました（追加分を含めて並べ直しました）\n未桜さん 物件（リアプロ 2）") && !up.includes("AIXツールで見る"), up);
  const st = buildAnnouncement({ customerName: "未桜", sites: { realpro: 2 }, items: ITEMS.slice(0, 2), bestId: null, link: "L", stopped: true });
  t("止まった時: 件数とリンクだけ（👑・上位なし）", st.startsWith("⚠ AIXツールの解析が途中で止まりました\n未桜さん 物件") && !st.includes("👑") && st.includes("全2件（通す 2）") && st.endsWith("L"), st);
  const nob = buildAnnouncement({ customerName: null, sites: {}, items: ITEMS.slice(2, 4), bestId: null, link: null });
  t("👑 が無い時は上位を【1】から", nob.includes("\n物件\n") && nob.includes("【1】エスリードレジデンス"), nob);
  const many = buildAnnouncement({ customerName: "A", sites: { realpro: 30 }, items: Array.from({ length: 30 }, (_, k) => ({ id: k + 1, verdict: "pass", status: "pending", score: 150 - k, summary_text: `【${k + 1}】物件${k + 1} 101号室\n70,000円` })), bestId: 1, link: null });
  t("上位は👑＋5件まで", many.includes("【6】物件6 101号室") && !many.includes("物件7 "), many);
  const big = buildAnnouncement({ customerName: "A", sites: {}, items: [{ id: 1, verdict: "pass", score: 1, summary_text: "x".repeat(6000) }], bestId: 1, link: null });
  t("LINE の上限より短く切る", big.length <= 4500);
}

console.log("\n■ 点・リンク・サイト");
{
  const withImg: AnnounceItem = { id: 1, score: 163, reason_codes: [], image_analysis: { match: 80, wants: ["ウォークインクローゼット"], checks: [{ want: "ウォークインクローゼット", result: "○" }] } };
  const p = announcePoints(withImg);
  t("画像の加点がある時は合計・判定・画像（売上サポの札と同じ数）", /^合計 1\d\d点・判定 163・画像 (?:[+−]\d+|±0)$/.test(p), p);
  t("点が無い時は空", announcePoints({ id: 1, score: null }) === "");
  t("リンク＝新着物件カードと同じ形", announceLink("https://sumora-ai-ui.vercel.app/", "509cd061-60cc", "物件まとめ_1.pdf") === "https://sumora-ai-ui.vercel.app/conditions?pickup=509cd061-60cc&batch=%E7%89%A9%E4%BB%B6%E3%81%BE%E3%81%A8%E3%82%81_1.pdf");
  t("お客様が無ければリンク無し", announceLink("https://a", null, "b") === null);
  t("サイトの名前", siteLabelJa({ realpro: 3, itandi: 0, reins: 1 }) === "リアプロ 3・レインズ 1");
}

console.log("\n■ 配線（merge-pdfs・まとめの完了）");
{
  const root = join(__dirname, "..", "..", "..");
  const mp = readFileSync(join(root, "app/api/merge-pdfs/route.ts"), "utf8");
  t("merge-pdfs: 送る前に groupNoticePlan で決める", /groupNoticePlan\(\{ sendToLine: !!send_to_line, brainMode: brain_mode, staffMode: staff_mode, hasCustomer: !!resolvedCustomerId/.test(mp));
  t("merge-pdfs: 検索のたびの送信は perSearch の時だけ", /if \(notice\.perSearch\) await pushLineMessage\(groupId, lineText\)/.test(mp));
  t("merge-pdfs: 記録に印を渡す", /groupNotice: notice\.deferred \? "deferred" : null/.test(mp));
  t("merge-pdfs: 記録できなかった時は今まで通り送る", /rec\.groupNotice !== "deferred"\)\) await fallbackPush/.test(mp) && /fallbackPush\("record_throw"\)/.test(mp));
  const pc = readFileSync(join(root, "app/lib/pickup-complete-server.ts"), "utf8");
  t("まとめの完了（順位・👑 の後）でアナウンス", /best_id: ranking\.bestId[\s\S]*announceSafe\(\{ groupId: input\.groupId[\s\S]*chainAfterComplete/.test(pc));
  const pps = readFileSync(join(root, "app/lib/property-pickups-server.ts"), "utf8");
  t("記録: 列が無い時は印を外して記録し groupNotice=null を返す", /group_notice 列が無いので外して記録/.test(pps) && /out\.groupNotice = noticeStored \? "deferred" : null/.test(pps));
  const ms = readFileSync(join(root, "app/api/migrate-schema/route.ts"), "utf8");
  t("migrate-schema に列", /ADD COLUMN IF NOT EXISTS group_notice TEXT/.test(ms) && /announced_item_ids BIGINT\[\]/.test(ms) && /announced_at TIMESTAMPTZ/.test(ms) && /announce_error TEXT/.test(ms));
  const sv = readFileSync(join(root, "app/lib/pickup-group-announce-server.ts"), "utf8");
  t("送る前に条件付き UPDATE で取る（二重に送らない）", sv.indexOf('.is("announced_at", null)') > 0 && sv.indexOf('.is("announced_at", null)') < sv.indexOf("api.line.me"));
  t("送り先は★物件出し★（pickup_group_id を先に）", /m\.get\("pickup_group_id"\) \|\| m\.get\("group_id"\)/.test(sv));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
