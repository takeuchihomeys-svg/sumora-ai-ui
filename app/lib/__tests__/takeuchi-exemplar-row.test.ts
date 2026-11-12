// npx tsx app/lib/__tests__/takeuchi-exemplar-row.test.ts — 手本の束 ⇄ 表 takeuchi_exemplars（2026-11-12 作業員23）
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildExemplarRows, toExemplarRow, rowToExemplar, scrubExemplarValue, type BankEntry } from "../takeuchi-exemplar-row";
import { exemplarNoteFor, warmExemplarTable, resetExemplarTableCache } from "../takeuchi-exemplar-server";
import { nightOnly, propertyNamesForBank } from "../../../scripts/takeuchi-exemplars-load";
import { propertyNameVariants } from "../takeuchi-exemplar-row";

let n = 0;
const t = async (name: string, f: () => void | Promise<void>) => { await f(); n++; void name; };

const STAFF1 = "カウンターキッチンのご条件も含めて、西区周辺からオススメできるお部屋を新たにピックアップしてお送りさせて頂きます";
const e1: BankEntry = {
  id: "m-1", scene: "conditions", latent: "living", lead: "keep", hand: true,
  customer: "カウンターキッチン希望です 田中様の携帯は090-1234-5678",
  sentences: [
    { text: "かしこまりました！！", role: "uke", why: "YUMAさんの希望を聞き入れた", brainField: "uke" },
    { text: STAFF1, role: "keep", why: "「オススメできるお部屋を新たにピックアップ」と約束", brainField: "lead" },
  ],
  latentFour: { trigger: "カウンターキッチン希望です", part: "キッチン", feeling: "合う部屋が無い不安（中）", want: "条件込みで探してほしい" },
  fact: "お客様が書いた『カウンターキッチン希望です』という条件・連絡先 090-1234-5678",
};
const e2: BankEntry = { ...e1, id: "m-2", hand: false };

(async () => {
  await t("本文 text とお客様の発言を入れない", () => {
    const r = toExemplarRow(e1, null);
    assert.ok("row" in r);
    const s = JSON.stringify(r.row);
    assert.ok(!/"text"/.test(s), "text の鍵が無い");
    assert.ok(!/"customer"/.test(s), "customer の鍵が無い");
    assert.ok(!s.includes(STAFF1) && !s.includes("かしこまりました"), "文の本文が無い");
    assert.ok(!s.includes("カウンターキッチン希望です"), "発言の写しが無い");
    assert.equal(r.row.latent_four?.trigger, "", "きっかけ（発言の引用）は入れない");
    assert.ok(!s.includes("090-1234-5678") && !s.includes("YUMAさん"), "名前・電話を伏せる");
    assert.equal(r.row.source_turn, "m-1");
    assert.equal(r.row.sentences.length, 2);
  });
  await t("申込の門で外れる番・門を引けない番は入れない", () => {
    const { rows, skipped } = buildExemplarRows([e1, e2], (id) => (id === "m-1" ? "申込以降（申込へ押下の後）" : null));
    assert.deepEqual(rows.map((r) => r.id), ["m-2"]);
    assert.match(skipped[0].reason, /^申込の門/);
    const b = buildExemplarRows([e1], () => undefined);
    assert.equal(b.rows.length, 0);
    assert.match(b.skipped[0].reason, /^申込の門を引けない/);
  });
  await t("形の崩れた番・同じ id は入れない", () => {
    const { rows, skipped } = buildExemplarRows([e2, e2, { ...e1, id: "m-3", lead: "xxx" as never }, { ...e1, id: "m-4", sentences: [] }], () => null);
    assert.equal(rows.length, 1);
    assert.equal(skipped.length, 3);
  });
  await t("値を伏せる", () => {
    assert.equal(scrubExemplarValue("", []), "");
    assert.ok(!scrubExemplarValue("佐藤様に〒530-0001 で送る", []).includes("佐藤"));
    assert.ok(scrubExemplarValue("新着が今は無い事実", []).includes("新着が今は無い"), "値でない言葉は残す");
    assert.ok(!scrubExemplarValue("お客様自身が書いた『カードブラック借入あり』と限度額", []).includes("カードブラック"), "引用は確かめられなくても伏せる");
    const p = scrubExemplarValue("アーバネックス堺筋本町 701号室内覧の前の印象", []);
    assert.ok(!p.includes("アーバネックス") && !p.includes("701") && p.includes("内覧の前"), "部屋番号の付いた物件名を伏せる: " + p);
    assert.equal(scrubExemplarValue("審査", []), "審査", "元から短い言葉は残す");
    const pn = propertyNameVariants(["サンメゾン", "アモーレ本町 WEST 7階", "S-RESIDENCE江坂Eminence601", "物件No.107", "1104号室", "gm KOHAMA"]);
    assert.ok(pn.includes("アモーレ本町") && pn.includes("S-RESIDENCE江坂Eminence") && !pn.some((x) => /物件|^1104/.test(x)) && !pn.includes("gm"), "言い方の候補: " + pn.join("|"));
    const q = scrubExemplarValue("サンメゾン申込・キャンセル", [], 40, pn);
    assert.ok(!q.includes("サンメゾン") && q.includes("申込"), "部屋番号の無い物件名も伏せる: " + q);
    assert.equal(scrubExemplarValue("アモーレ本町", [], 40, pn), "", "物件名だけなら空");
  });
  await t("表の行 → 手本（本文は空・注記は出る）", () => {
    const r = toExemplarRow(e1, null); assert.ok("row" in r);
    const ex = rowToExemplar(r.row);
    assert.ok(ex && ex.sentences.every((s) => s.text === "") && ex.customer === "");
    assert.equal(rowToExemplar({ id: "x" }), null);
    assert.equal(rowToExemplar({ id: "x", scene: "a", latent: "bad", lead: "keep", sentences: [{}] }), null);
  });

  // ── 表から読む道（takeuchi-exemplar-server）──
  const meta = { reply_direction: "新たにピックアップしてお送りすると約束する" };
  const sbOf = (res: () => Promise<{ data: unknown; error: { message: string } | null }>) => {
    let calls = 0;
    return { calls: () => calls, sb: { from: () => { calls++; return { select: () => ({ limit: () => res() }) }; } } };
  };
  await t("off なら表を読まず、注記も出ない", async () => {
    resetExemplarTableCache();
    const s = sbOf(async () => ({ data: [], error: null }));
    assert.equal(await warmExemplarTable(s.sb, {}), 0);
    assert.equal(s.calls(), 0);
    assert.equal(exemplarNoteFor({ scene: "conditions", customerText: "広い所", meta }, {}), null);
  });
  await t("表が空・無い・投げる・時間切れでも落ちず注記なし", async () => {
    const on = { TAKEUCHI_EXEMPLAR: "on" };
    for (const res of [
      async () => ({ data: [], error: null }),
      async () => ({ data: null, error: { message: 'relation "takeuchi_exemplars" does not exist' } }),
      async () => { throw new Error("boom"); },
      () => new Promise<never>(() => { /* 返らない */ }),
    ]) {
      resetExemplarTableCache();
      assert.equal(await warmExemplarTable(sbOf(res as never).sb, on, { timeoutMs: 30 }), 0);
      assert.equal(exemplarNoteFor({ scene: "conditions", customerText: "広い所", meta }, on), null);
    }
    resetExemplarTableCache();
    const s = { from: () => { throw new Error("no client"); } };
    assert.equal(await warmExemplarTable(s, on), 0);
  });
  await t("表に行があれば on で注記が出る（本文は出ない）・取り置きは10分", async () => {
    resetExemplarTableCache();
    const r = toExemplarRow(e1, null); assert.ok("row" in r);
    const s = sbOf(async () => ({ data: [r.row], error: null }));
    const on = { TAKEUCHI_EXEMPLAR: "on" };
    assert.equal(await warmExemplarTable(s.sb, on, { now: 1000 }), 1);
    await warmExemplarTable(s.sb, on, { now: 1000 + 60_000 });
    assert.equal(s.calls(), 1, "10分の間は読み直さない");
    const note = exemplarNoteFor({ scene: "conditions", customerText: "広い所がいいです", meta }, on);
    assert.ok(note && note.note.includes("文は写さない") && !note.note.includes(STAFF1));
    assert.ok(!/潜在: で、/.test(note.note), "きっかけが空でも「で、」を付けない");
    assert.equal(exemplarNoteFor({ scene: "conditions", customerText: "広い所がいいです", meta }, {}), null, "off なら取り置きがあっても出ない");
    resetExemplarTableCache();
  });
  await t("夜だけ動く", () => {
    assert.equal(nightOnly(new Date("2026-11-12T03:00:00Z")).ok, false); // JST 12時
    assert.equal(nightOnly(new Date("2026-11-12T13:30:00Z")).ok, true);  // JST 22時半
    assert.equal(nightOnly(new Date("2026-11-11T23:59:00Z")).ok, true);  // JST 8時59分
    assert.equal(nightOnly(new Date("2026-11-12T00:00:00Z")).ok, false); // JST 9時
  });
  // 手元に作業員5 の束があれば全部を形に通して確かめる（倉庫の外・無ければ飛ばす。DB は読まない）
  const bankPath = join(process.cwd(), "..", "..", "exam-cache", "anatomy-seven", "exemplar-bank.json");
  if (existsSync(bankPath)) {
    await t("実物の束: 本文・発言の写しが行に残らない", () => {
      const bank = JSON.parse(readFileSync(bankPath, "utf8")) as BankEntry[];
      const names = propertyNamesForBank(bankPath, bank);
      const { rows, skipped } = buildExemplarRows(bank, () => null, { propertyNames: names });
      const leaks = rows.filter((row) => {
        const e = bank.find((b) => b.id === row.id)!;
        const s = JSON.stringify(row).normalize("NFKC").replace(/\s+/g, "");
        return /"text"/.test(s) || e.sentences.some((x) => { const k = String(x.text).normalize("NFKC").replace(/\s+/g, ""); return k.length >= 15 && s.includes(k); });
      });
      assert.equal(leaks.length, 0, `本文が残った行 ${leaks.map((r) => r.id.slice(0, 8)).join(",")}`);
      // 物件名が0か（潜在の4つの part.property の名前そのもの・空白の前の頭の語で確かめる）
      const raw: string[] = [];
      for (const f of ["seven-latent4.json", "seven-latent4b.json"]) { const p = join(bankPath, "..", f); if (existsSync(p)) for (const o of JSON.parse(readFileSync(p, "utf8")) as Array<{ reads?: Array<{ part?: { property?: string | null } } | null> }>) { const v = o.reads?.[0]?.part?.property; if (v) raw.push(v); } }
      const probes = [...new Set(raw.flatMap((v) => { const x = v.normalize("NFKC"); return [x.replace(/\s+/g, ""), x.split(/\s+/)[0]]; }).filter((x) => x.length >= 3 && !/物件|URL|^[0-9]/i.test(x)))];
      const named = rows.filter((row) => { const s = JSON.stringify(row).normalize("NFKC").replace(/\s+/g, ""); return probes.some((p) => s.includes(p)); });
      assert.equal(named.length, 0, `物件名が残った行 ${named.map((r) => r.id.slice(0, 8)).join(",")}`);
      console.log(`  物件名の言い方 ${names.length}個・確かめた名前 ${probes.length}個 → 物件名が残った行 0`);
      console.log(`  実物の束 ${bank.length}通 → 形に通る ${rows.length}通・形で外れる ${skipped.length}通（門は DB を読むので夜の読みで）`);
    });
  }
  console.log(`takeuchi-exemplar-row: ${n} pass`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
