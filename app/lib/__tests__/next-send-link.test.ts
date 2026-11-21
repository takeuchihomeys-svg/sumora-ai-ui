// 統括の next_send のつながり（作業員M 2026-11-19）・要件の帳面の読む側（ASK_PROGRESS_READ）
// 実行: npx tsx app/lib/__tests__/next-send-link.test.ts
import { nextSendLinkMode, nextSendLinkOf, nextSendLinkDigest } from "../next-send-link";
import { buildAskLedger, nextAskProgress, askProgressReadOn, askProgressAixNoteOn, askProgressNote, askProgressBand, askCarryFrom } from "../ask-ledger";
let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

t("NEXT_SEND_LINK 既定 shadow（11/19）", nextSendLinkMode({}) === "shadow" && nextSendLinkMode({ NEXT_SEND_LINK: "off" }) === "off");
t("ASK_PROGRESS_READ 既定 on（記録だけ・=off で止める）・2通目の注記は ASK_PROGRESS_AIX_NOTE（既定 off）", askProgressReadOn({}) === true && askProgressReadOn({ ASK_PROGRESS_READ: "off" }) === false && askProgressAixNoteOn({}) === false && askProgressAixNoteOn({ ASK_PROGRESS_AIX_NOTE: "on" }) === true);
const sn = (o: Record<string, unknown>) => ({ v: 1, ...o });
// 約束を果たす
{
  const l = nextSendLinkOf({ action: "property_check_result", situation_now: sn({ promises_open: [{ promise_id: "sf:a|manual|check_promised", kind: "check_promised", object: null }] }) });
  t("約束あり＋結果の AIX＝約束を果たす", l?.kind === "keep_promise" && l.refs[0].promise_id === "sf:a|manual|check_promised", l);
  t("digest", nextSendLinkDigest(l) === "keep_promise:1");
}
// 誘いの返事
{
  const l = nextSendLinkOf({ action: "viewing_invite", situation_now: sn({ our_items: [{ item_id: "t1#0", kind: "invite", label: "内覧の扉", answered: true }] }) });
  t("前の誘いに返した＝誘いの返事を受ける", l?.kind === "invite_reply" && l.refs[0].item_id === "t1#0", l);
}
// 答えを受けて進める
{
  const l = nextSendLinkOf({ action: null, situation_now: sn({ our_items: [{ item_id: "t2#1", kind: "question", answered: true }] }) });
  t("問いに答えた＝答えを受けて進める", l?.kind === "answer_then_advance" && l.refs[0].item_id === "t2#1", l);
}
// 返事が無い
{
  const l = nextSendLinkOf({ action: null, situation_now: sn({ our_items: [{ item_id: "t3#0", kind: "property", answered: false }] }) });
  t("送った物件に返事が無い＝形を変える", l?.kind === "reshape_no_reply", l);
}
// 同じ物件・別の物件
{
  const same = nextSendLinkOf({ action: null, current_property: "グランドハイツ恵比寿 302", situation_now: sn({ sent: [{ sent_id: "sf:x|aix|properties_sent", kind: "properties_sent", props: ["グランドハイツ恵比寿"] }] }) });
  t("同じ物件の続き", same?.kind === "same_property" && same.refs[0].sent_id === "sf:x|aix|properties_sent", same);
  const other = nextSendLinkOf({ action: null, current_property: "ロイヤル本町", situation_now: sn({ sent: [{ sent_id: "s1", kind: "properties_sent", props: ["グランドハイツ恵比寿"] }] }) });
  t("別の物件に移る", other?.kind === "other_property", other);
}
t("材料が無ければ null", nextSendLinkOf({ action: null }) === null && nextSendLinkOf(null) === null);
t("前の通があって当たらない＝新しい話題", nextSendLinkOf({ situation_now: sn({ our_items: [{ item_id: "a", kind: "fact", answered: null }] }) })?.kind === "new_topic");

// 読む側: 書き手への1段・画面の帯・次の番へ
{
  const led = buildAskLedger({ asks: [
    { quote: "この物件まだ空いてますか", route: "promise", about: "vacancy", kind: "question" },
    { quote: "見積もりお願いします", route: "aix", aix: "estimate_sheet", about: "property_cost", kind: "request" },
  ], finalAix: "estimate_sheet", seenCustomerAt: "2026-11-19T01:00:00Z" });
  const pr = nextAskProgress(led, null, { kind: "reply" }, "2026-11-19T01:01:00Z")!;
  const note = askProgressNote(led, pr);
  t("書き手への1段: まだの要件・約束・次の通", note.includes("まだ答えていない要件: 「見積もりお願いします」") && note.includes("約束して結果がまだ") && note.includes("2通目のAIX"), note);
  const band = askProgressBand(led, pr) ?? "";
  t("画面の帯", band.startsWith("1/") && band.includes("まだ: 「見積もりお願いします」") && band.includes("次はAIX"), band);
  const carry = askCarryFrom(led, JSON.parse(JSON.stringify(pr)));
  t("次の番へ: open と promised を ask_id で", !!carry && carry.open.length === 1 && carry.promised.length === 1 && carry.items.every((x) => led.items.some((e) => e.id === x.ask_id)), carry);
  t("古い記録は読まない", askCarryFrom({ ...led, seen_customer_at: "2026-11-20T00:00:00Z" }, pr) === null);
  const l = nextSendLinkOf({ action: "property_check_result", ask_carry: carry, situation_now: sn({}) });
  t("前の番の約束して結果がまだ＋結果の AIX＝約束を果たす（ask_id）", l?.kind === "keep_promise" && l.refs.some((r) => !!r.ask_id), l);
}
console.log(`\nnext-send-link: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
