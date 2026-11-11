// app/lib/__tests__/takeuchi-exemplar.test.ts — 手本を引く鍵・引き方・注記（npx tsx で回す）。言葉は竹内さんの番の実物（伏せ済み）
import { latentKeyOf, leadKeyOf, pickExemplar, exemplarNote, exemplarOn, roleSeqSimilarity, brainFieldOf, type Exemplar } from "../takeuchi-exemplar";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

t("潜在: 埋まる", latentKeyOf("内覧したいんですが都合つくのが9月13日以降の予定なんですが、今見てる物件埋まる可能性高いですかね") === "taken");
t("潜在: 審査", latentKeyOf("現状夜職1本なんですが親保証人つけてシーズンフラッツ審査通せそうですか？") === "screening");
t("潜在: 費用（総額）と追加", latentKeyOf("初期費用全部おしえてほしいです！") === "cost_total" && latentKeyOf("猫がいるのでプラス67000になりますか？") === "cost_extra");
t("潜在: 他社・掲載", latentKeyOf("他のとこは掲載してるけど募集無しですか？") === "trust_other");
t("潜在: 住み心地・入居日・内覧の日", latentKeyOf("2階だと虫とかって入ってきますかね？") === "living" && latentKeyOf("最短でも入居可能日は11月中旬でしょうか？") === "move_in" && latentKeyOf("ちなみに日曜日とかは案内可能ですですか？") === "viewing_slot");
t("潜在: 無し", latentKeyOf("") === "none" && latentKeyOf("ご丁寧に有難うございます") === "none");

t("誘導先: 答える", leadKeyOf({ dir: "2階は上階に比べ虫が入りやすいと正直に答え、7階以上が虫対策に良い旨を伝えて不安を解消する" }) === "answer_only");
t("誘導先: ピックアップの約束・待つ", leadKeyOf({ dir: "新しいご条件でお部屋をピックアップしてお送りすると約束する返信にする" }) === "keep" && leadKeyOf({ dir: "見送りの意向を受け止め、待ちの姿勢で締める" }) === "keep");
t("誘導先: 抑える・見積・内覧・聞く", leadKeyOf({ dir: "募集中の気になる物件はお申込みで抑える提案を添える" }) === "apply" && leadKeyOf({ action: "estimate_sheet" }) === "estimate" && leadKeyOf({ action: "viewing_invite" }) === "viewing" && leadKeyOf({ dir: "一人暮らしになる場合のご希望条件を伺いながら" }) === "ask_send");

t("近さ: 挨拶・締め・続く同じは数えない", roleSeqSimilarity(["greet", "uke", "keep", "keep", "trust", "close"], ["uke", "keep", "trust"]) === 1 && roleSeqSimilarity(["answer", "viewing"], ["viewing", "answer"]) === 0.5);
t("ブレインの欄", brainFieldOf("answer") === "main" && brainFieldOf("worry") === "latent" && brainFieldOf("barrier") === "fact" && brainFieldOf("apply") === "lead" && brainFieldOf("promise") === "sub_promise");

const ex = (id: string, scene: string, latent: Exemplar["latent"], lead: Exemplar["lead"], roles: string[], hand = false) => ({ id, scene, latent, lead, hand, customer: "", sentences: roles.map((r) => ({ text: "x", role: r as never, why: `${r}の理由`, brainField: brainFieldOf(r as never) })) });
const bank = [
  ex("a", "viewing", "taken", "apply", ["uke", "answer", "apply"]),
  ex("b", "viewing", "taken", "apply", ["uke", "answer", "barrier", "apply"]),
  ex("c", "viewing", "taken", "apply", ["greet", "uke", "barrier", "apply"]),
  ex("d", "cost", "cost_total", "estimate", ["uke", "estimate"]),
];
const h = pickExemplar(bank, { scene: "viewing", latent: "taken", lead: "apply" });
t("引く: 同じ鍵の中で代表の並び（medoid）", h?.level === 0 && h.ex.id === "b", h);
t("引く: 自分は外す・広げる段", pickExemplar(bank, { scene: "question", latent: "cost_total", lead: "estimate" })?.level === 2 && pickExemplar(bank, { scene: "x", latent: "none", lead: "keep" }) === null && pickExemplar(bank, { scene: "cost", latent: "cost_total", lead: "estimate" }, "d") === null);
t("注記: 既定 off", !exemplarOn({}) && exemplarNote(h, {}) === null);
const note = exemplarNote(h, { TAKEUCHI_EXEMPLAR: "on" }) ?? "";
t("注記: 並びとブレインの欄（文は写さない）", note.includes("並び: uke > answer > barrier > apply") && note.includes("3. barrier（事実（先回りの裏付け））") && !note.includes("x\n"), note);

console.log(`takeuchi-exemplar: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
