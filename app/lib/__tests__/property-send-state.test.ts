// app/lib/__tests__/property-send-state.test.ts
// 実行: npx tsx app/lib/__tests__/property-send-state.test.ts
import {
  resolvePropertySendState,
  resolveBrainPropertyState,
  readPropertyStateFromText,
  describePropertySendState,
} from "../property-send-state";
import { fixRecommendClosing, stillNotViewable } from "../recommend-closing";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
}

// 2026-09-18 12:00 JST 固定
const NOW = Date.UTC(2026, 8, 18, 3, 0, 0);

console.log("── readPropertyStateFromText");
{
  const a = readPropertyStateFromText("9月30日退去予定のため10月1日以降にご内覧可能です！！", NOW);
  t("9/30退去予定 → 10月1日解禁・まだ内覧できない", a.notViewable && a.vacancyDate === "9月30日" && a.viewableFrom === "10月1日", JSON.stringify(a));

  const b = readPropertyStateFromText("9月末退去予定です", NOW);
  t("9月末退去予定 → 10月1日解禁", b.notViewable && b.viewableFrom === "10月1日", JSON.stringify(b));

  const c = readPropertyStateFromText("9月10日退去予定でした", NOW);
  t("既に解禁済み（9/10退去→9/11）はまだ内覧できない扱いにしない", !c.notViewable, JSON.stringify(c));

  const d = readPropertyStateFromText("空室ですのでいつでもご内覧頂けます", NOW);
  t("退去予定が無ければ notViewable=false", !d.notViewable && d.vacancyDate === null);

  const e = readPropertyStateFromText("１２月３１日退去予定", Date.UTC(2026, 11, 20, 3));
  t("全角・年跨ぎ（12/31退去→1月1日）", e.notViewable && e.viewableFrom === "1月1日", JSON.stringify(e));
}

console.log("── resolveBrainPropertyState（ブレインが持つ判断）");
{
  const msgs = [
    { sender: "customer", text: "今の家は9月末退去予定です" },      // ← お客様ご自身の退去（数えない）
    { sender: "staff", text: "かしこまりました！お探しします！" },
  ];
  const s = resolveBrainPropertyState({ messages: msgs, nowMs: NOW });
  t("お客様ご自身の「9月末退去予定」は物件の話ではない", !s.notViewable && s.vacancyDate === null, JSON.stringify(s));

  const msgs2 = [
    ...msgs,
    { sender: "staff", text: "UMEDA ILAND REIDENCE 302号室\n9月30日退去予定のため10月1日以降にご内覧可能です！！" },
  ];
  const s2 = resolveBrainPropertyState({ messages: msgs2, nowMs: NOW });
  t("こちらが送った物件の退去予定は拾う", s2.notViewable && s2.viewableFrom === "10月1日", JSON.stringify(s2));

  const s3 = resolveBrainPropertyState({ messages: msgs2, viewingReleased: true, nowMs: NOW });
  t("スタッフが既に内覧を案内済みなら内覧できる扱い（隼斗事例）", !s3.notViewable, JSON.stringify(s3));
}

console.log("── resolvePropertySendState（件数の出どころ）");
{
  const brain = { action_ledger: { facts: { propertiesSentCount: 5 } }, property_state: { notViewable: true, vacancyDate: "9月30日", viewableFrom: "10月1日" } };
  const a = resolvePropertySendState({ brainMeta: brain, nowMs: NOW });
  t("ブレインの件数と内覧可否をそのまま使う", a.sentPropertyCount === 5 && a.sentSource === "brain" && a.notViewable && a.viewableSource === "brain", describePropertySendState(a));

  const b = resolvePropertySendState({ brainMeta: null, fallbackSentCount: 2, nowMs: NOW });
  t("ブレインが無ければ受け皿の件数", b.sentPropertyCount === 2 && b.sentSource === "messages");

  const c = resolvePropertySendState({
    brainMeta: null,
    recentMessages: [{ sender: "staff", text: "9月30日退去予定のため10月1日以降にご内覧可能です！！" }],
    nowMs: NOW,
  });
  t("ブレインが無ければ本文から内覧可否を読む", c.notViewable && c.viewableSource === "messages", describePropertySendState(c));

  const d = resolvePropertySendState({
    brainMeta: null,
    recentMessages: [{ sender: "customer", text: "今の家は9月末退去予定です" }],
    nowMs: NOW,
  });
  t("受け皿でもお客様ご自身の退去予定は数えない", !d.notViewable, describePropertySendState(d));

  // 2026-09-18 の実装バグ: 存在しないフィールドを読んで件数が常に 0 になっていた
  const e = resolvePropertySendState({ brainMeta: { action_ledger: { facts: { propertiesSentCount: null } } }, fallbackSentCount: 3, nowMs: NOW });
  t("ブレインの件数が null なら受け皿に落ちる（0 に倒さない）", e.sentPropertyCount === 3 && e.sentSource === "messages", describePropertySendState(e));

  const f = resolvePropertySendState({ brainMeta: { action_ledger: { facts: { propertiesSentCount: 0 } } }, fallbackSentCount: 3, nowMs: NOW });
  t("ブレインが 0 件と言っているならその 0 を使う", f.sentPropertyCount === 0 && f.sentSource === "brain");
}

console.log("── 締めの出口（ブレインの判断が届く）");
{
  const TEXT = "お送りさせて頂きましたお部屋の中でも特にUMEDA ILAND REIDENCE 302号室がオススメです！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";

  // ブレインが「まだ内覧できない」と判断していれば、本文に退去予定が書かれていなくても申込誘導になる
  const a = fixRecommendClosing(TEXT, { sentPropertyCount: 1, notViewable: true, nowMs: NOW });
  t("ブレインの notViewable=true で申込誘導に差し替わる（本文に退去予定が無くても）",
    !/ご都合よろしいお日にち/.test(a.text) && /お申込[^\n]{0,10}抑え/.test(a.text) && !/中でも/.test(a.text), a.text);

  // ブレインが「内覧できる」と判断していれば、本文に退去予定があっても内覧誘導のまま（隼斗事例）
  const withVac = "9月30日退去予定のお部屋です。\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
  const b = fixRecommendClosing(withVac, { sentPropertyCount: 3, notViewable: false, nowMs: NOW });
  t("ブレインの notViewable=false なら内覧誘導のまま", b.applied.length === 0 && /ご都合よろしいお日にち/.test(b.text), b.text);

  // 渡されなければ今まで通り本文から読む
  const c = fixRecommendClosing(withVac, { sentPropertyCount: 3, nowMs: NOW });
  t("判断が渡されなければ本文から読む（従来通り）", c.applied.includes("apply_instead_of_viewing"), c.text);

  t("stillNotViewable は property-send-state と同じ答えを返す",
    stillNotViewable("9月30日退去予定", NOW) === readPropertyStateFromText("9月30日退去予定", NOW).notViewable);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
