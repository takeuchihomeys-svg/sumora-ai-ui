// app/lib/recommend-fact-guard.ts
// AIX【物件オススメ】の1通目の事実（駅・管理費・㎡・帖・独立洗面台）を、資料の読みの台帳（image-read-ledger）と
// 駅の表（station_map・osaka-geo）で決まった手順で確かめる（純関数・DB 依存なし）。
//
// 2026-10-17 竹内さん「順に改善おねがい」①③（物件検索ブレインの調べの直し）
//   KAORI さん（10/12 グランノーブルⅡ・売上サポの行なし・png 1枚）: 1通目「近鉄大阪線「河内山本」駅徒歩15分・管理費7,700円」
//     資料: 交通「近鉄奈良線 瓢箪山駅 徒歩18分」・共益費 4,100円（7,700円は駐車場の欄）・所在地 東大阪市。
//     河内山本は station_map で八尾市（所在地の東大阪市と合わない）＝決まった手順で止められた。
//   未桜さん（10/09 エステムコート難波Ⅳ）: 設備欄の字は「洗面台（独立）」だが間取り図はトイレと同じ部屋（アメリカンセパレート）。
// ■ 決め（設計知見 015f2950「駅の名前は確かめた出どころだけ」）
//   駅:   ok        … 台帳の写した文字の交通の欄・売上サポの行の資料の文字にその駅がある
//         conflict  … 台帳に別の駅だけがある／駅の市区が所在地の市区と違う／書いた路線にその駅が無い（駅の表で分かる時だけ）
//         unverified… 確かめる出どころが無い（台帳の交通が読めていない・駅の表にも無い）
//   管理費: 台帳の「管理費」「共益費」の見出しの金額と違えば fix（合計の金額も直す）。見出しが無ければ unverified
//   ㎡:   台帳の「専有面積」と違えば fix。帖: 台帳の帖の数に無い数があれば conflict（どれに直すか決められないので直さない）
//   独立洗面台: 台帳の【間取り図の洗面】がトイレ・浴室と同じ部屋なら conflict、独立した洗面所なら ok、読めなければ unverified
// ■ 出口: conflict と fix は「直す／落とす」（③・AIX_FACT_EXIT・既定 on）。unverified は落とすか（①・AIX_FACT_GUARD）:
//   shadow（既定）＝ログだけ／on＝落とす／off。落とす時は箇条書きの行ごと、文の中なら語と前後の「・」「、」だけ。

export type LedgerStation = { line: string | null; station: string; walk: number | null };
export type Washbasin = "independent" | "with_toilet" | "with_bath" | "other" | "unknown";
export type LedgerFacts = {
  stations: LedgerStation[];
  adminFee: number | null;
  /** 管理費・共益費の見出しの行ごとの金額（2つ以上ある時は合計が正しいか決められない＝直さない）。旧の台帳には無い */
  adminFeeParts?: number[];
  parking: number | null;
  areaSqm: number | null;
  jo: number[];
  address: string | null;
  washbasin: Washbasin | null;
};

const nk = (s: string) => String(s ?? "").normalize("NFKC");
const yen = (s: string): number | null => {
  const t = nk(s).replace(/[,，\s]/g, "");
  const man = t.match(/^(\d+(?:\.\d+)?)万/);
  if (man) return Math.round(Number(man[1]) * 10000);
  const m = t.match(/^(\d{1,7})円?/);
  return m ? Number(m[1]) : null;
};

/** 駅の名前を比べる形に（「駅」・「」・路線の前置き・旧字を外す） */
export function stationKey(raw: string): string {
  // 「日本橋駅まで」「天王寺駅まで」の「まで」・「JR東淀川」の会社の前置きも外す（監査 70件の誤った食い違い）
  let s = nk(raw).replace(/[「」『』"'\s]/g, "").replace(/(?:駅)?まで$/, "").replace(/駅$/, "");
  const i = s.lastIndexOf("線");
  if (i >= 1 && i < s.length - 1) s = s.slice(i + 1);
  s = s.replace(/^(?:JR|ＪＲ|阪急|阪神|南海|近鉄|京阪|大阪メトロ|OsakaMetro|地下鉄|市営)(?=.{2,})/, "");
  s = s.replace(/國/g, "国").replace(/[ヶケヵ]/g, "ケ").replace(/之/g, "ノ").replace(/の(?=[^\s]*$)/, "ノ");
  // 確かめる人（2026-10-17）: 同じ駅の書き方の揺れ（資料「難波」・1通目「なんば」／阪急・阪神の旧名「梅田」と新名「大阪梅田」）で正しい駅を落としていた
  return STATION_ALIAS[s] ?? s;
}
const STATION_ALIAS: Record<string, string> = { なんば: "難波", 大阪難波: "難波", 大阪梅田: "梅田", 大阪上本町: "上本町", 大阪阿部野橋: "阿部野橋" };
/** 路線の字の無い会社の前置き（「阪神「福島」駅徒歩5分」の「阪神」）。駅を落とす時に前置きだけが残らないよう主張の字に含める */
const COMPANY_TAIL_RE = /(?:JR|ＪＲ|阪急|阪神|南海|近鉄|京阪|大阪メトロ|Osaka\s?Metro|地下鉄|北大阪急行|大阪モノレール|モノレール)\s*$/;

const STATION_RE = /(?:([^\s「」『』:：/／、,，（）()・！!。？?]{1,24}?線)\s*)?[「『]?([^\s「」『』:：/／、,，（）()\d・！!。？?]{1,12}?)[」』]?\s*駅?\s*(?:から|より)?\s*(?:徒歩|歩)\s*(?:約)?\s*(\d{1,2})\s*分/g;

/** 写した文字から交通の駅（路線・駅・徒歩）を読む */
export function stationsInText(text: string): LedgerStation[] {
  const out: LedgerStation[] = [];
  const src = nk(text);
  for (const m of src.matchAll(STATION_RE)) {
    const st = stationKey(m[2] ?? "");
    if (!st || /^(最寄り?|駅|バス停?|停|分|より|から)$/.test(st) || /バス|停$/.test(m[2] ?? "")) continue;
    if (!m[1] && /バス停?\s*$|停留所\s*$/.test(src.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0))) continue;
    // 同じ駅が別の路線で2回（環状線「弁天町」9分／中央線「弁天町」8分）は両方残す
    if (out.some((x) => x.station === st && x.walk === (m[3] ? Number(m[3]) : null))) continue;
    out.push({ line: m[1] ? nk(m[1]) : null, station: st, walk: m[3] ? Number(m[3]) : null });
  }
  return out;
}

/** 台帳の写した文字 → 確かめに使う事実（決定論） */
export function parseLedgerFacts(transcript: string): LedgerFacts {
  const t = nk(transcript ?? "");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const valueOf = (re: RegExp): string | null => {
    for (const l of lines) { const m = l.match(re); if (m) return m[1]; }
    return null;
  };
  // 管理費・共益費（両方あれば合計）。見出しと値の組の行だけ（「駐車場」の金額は入れない）
  let admin: number | null = null;
  const adminParts: number[] = [];
  for (const l of lines) {
    const m = l.match(/^(?:管理費|共益費|管理費[・/／]共益費|共益費[・/／]管理費|管理費等)\s*[:：]\s*([^\s/／]+)/);
    if (!m) continue;
    const v = /^(?:なし|無し|無|0円?|ー|-|—|一)$/.test(m[1]) ? 0 : yen(m[1]);
    if (v === null) continue;
    admin = (admin ?? 0) + v;
    adminParts.push(v);
  }
  // 見出しの行が無い時だけ、行の中の「共益費6,000円」を読む（最初の1つ。備考の「共益費9,000円増額」と足さない）
  if (admin === null) {
    for (const l of lines) {
      const m = l.match(/(?:^|[\s　])(?:管理費|共益費)\s*([\d,，]{3,7}円)(?!\s*(?:増|減|加算|追加))/);
      if (m) { admin = yen(m[1]); break; }
    }
  }
  const parkingRaw = valueOf(/^駐車場(?:料)?\s*[:：]\s*([\d,，.]+万?円)/);
  const areaRaw = valueOf(/(?:専有面積|面積)\s*[:：]\s*([\d.]+)\s*(?:㎡|m2|m²|平米)/);
  const jo = [...t.matchAll(/(\d{1,2}(?:\.\d)?)\s*(?:帖|畳|J\b)/g)].map((m) => Number(m[1])).filter((n) => n > 0 && n < 60);
  // 「洋6・洋5.3・LDK10.3」の様に帖の字が無い間取りの内訳
  for (const m of t.matchAll(/(?:洋|和|LDK|DK|LD|K)\s*(\d{1,2}(?:\.\d)?)(?![\d.]*\s*(?:㎡|m|円|分|階|年|万))/g)) {
    const n = Number(m[1]);
    if (n > 0 && n < 60 && !jo.includes(n)) jo.push(n);
  }
  const address = valueOf(/^(?:所在地|住所)\s*[:：]\s*(.+)$/);
  const wbRaw = valueOf(/【?間取り図の洗面】?\s*[:：]?\s*(.+)$/);
  const washbasin: Washbasin | null = !wbRaw ? null
    : /独立/.test(wbRaw) ? "independent"
    : /トイレ/.test(wbRaw) ? "with_toilet"
    : /浴室|風呂/.test(wbRaw) ? "with_bath"
    : /廊下|キッチン/.test(wbRaw) ? "other"
    : "unknown";
  return {
    stations: stationsInText(lines.filter((l) => !/^【間取り図の洗面】/.test(l)).join("\n")),
    adminFee: admin,
    adminFeeParts: adminParts,
    parking: parkingRaw ? yen(parkingRaw) : null,
    areaSqm: areaRaw ? Number(areaRaw) : null,
    jo: [...new Set(jo)],
    address,
    washbasin,
  };
}

// ── 1通目の主張 ───────────────────────────────────────────────────────
export type Claim =
  | { kind: "station"; text: string; line: string | null; station: string; walk: number | null }
  | { kind: "admin_fee"; text: string; value: number }
  | { kind: "area"; text: string; value: number }
  | { kind: "jo"; text: string; value: number }
  | { kind: "washbasin"; text: string };

export function claimsInFirstMessage(message: string): Claim[] {
  const t = String(message ?? "");
  const out: Claim[] = [];
  for (const m of t.matchAll(STATION_RE)) {
    const st = stationKey(m[2] ?? "");
    if (!st || /^(最寄り?|駅)$/.test(st)) continue;
    const pre = !m[1] ? (t.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0).match(COMPANY_TAIL_RE)?.[0] ?? "") : "";
    out.push({ kind: "station", text: pre + m[0], line: m[1] ? nk(m[1]) : null, station: st, walk: m[3] ? Number(m[3]) : null });
  }
  for (const m of t.matchAll(/(?:管理費|共益費)(?:[・/／](?:管理費|共益費))?\s*[:：]?\s*([\d,，]{3,7})\s*円/g)) {
    const v = yen(m[1]); if (v !== null) out.push({ kind: "admin_fee", text: m[0], value: v });
  }
  // 全角の数字・小数点（「８．４帖」）も読む（監査で「84帖」と読んでいた）
  for (const m of t.matchAll(/(?<![\d０-９.．])([\d０-９]{1,3}(?:[.．][\d０-９]{1,2})?)\s*(?:㎡|m²|m2|平米)/g)) out.push({ kind: "area", text: m[0], value: Number(nk(m[1])) });
  for (const m of t.matchAll(/(?<![\d０-９.．])([\d０-９]{1,2}(?:[.．][\d０-９])?)\s*(?:帖|畳)/g)) out.push({ kind: "jo", text: m[0], value: Number(nk(m[1])) });
  for (const m of t.matchAll(/独立洗面(?:台|所)?|洗面所独立|洗面台[（(]独立[)）]/g)) out.push({ kind: "washbasin", text: m[0] });
  return out;
}

// ── 確かめ ─────────────────────────────────────────────────────────
export type StationGeo = { ward: string | null; lines: string[] };
export type Verdict = "ok" | "fix" | "conflict" | "unverified";
export type Decision = { kind: Claim["kind"]; claim: string; verdict: Verdict; why: string; to?: string };

export type GuardInput = {
  message: string;
  ledger: LedgerFacts | null;
  /** 売上サポの行の資料の文字（物件名・pdf_text）。ここに駅があれば確か */
  materialText?: string | null;
  /** 主張の駅 → 駅の表（station_map・osaka-geo）の市区・路線 */
  geo?: Record<string, StationGeo>;
  /** 所在地の市区（wardOfAddress・台帳の所在地から） */
  addressWard?: string | null;
};

const lineCore = (s: string) => nk(s).replace(/^(?:近畿日本鉄道|近鉄日本鉄道|近鉄|JR西日本|JR|ＪＲ|大阪メトロ|Osaka\s*Metro|大阪市営地下鉄|大阪市高速軌道|地下鉄|阪急電鉄|阪急|阪神電鉄|阪神電気鉄道|阪神|京阪電気鉄道|京阪電鉄|京阪|南海電鉄|南海電気鉄道|南海|北大阪急行|大阪モノレール|能勢電鉄|阪堺電気軌道|阪堺)/, "")
  .replace(/[（(].*?[)）]/g, "").replace(/線$/, "").replace(/^本$/, "本線");
function lineMatches(claimed: string, known: string[]): boolean {
  const c = lineCore(claimed);
  if (!c) return true;
  return known.some((k) => { const kc = lineCore(k); return !!kc && (kc.includes(c) || c.includes(kc) || kc.split(/[・/／]/).some((p) => p && (c === p || c.endsWith(p)))); });
}
const wardKey = (w: string | null | undefined) => nk(w ?? "").replace(/^大阪府/, "").replace(/^大阪市/, "").trim();

export function checkFirstMessageFacts(input: GuardInput): Decision[] {
  const out: Decision[] = [];
  const claims = claimsInFirstMessage(input.message);
  const L = input.ledger;
  const material = nk(input.materialText ?? "");
  const ledgerStations = L?.stations ?? [];
  for (const c of claims) {
    if (c.kind === "station") {
      const same = ledgerStations.filter((s) => s.station === c.station);
      const inMaterial = material && new RegExp(`${c.station.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(material.replace(/\s/g, ""));
      if (same.length > 0 || inMaterial) {
        const walks = same.map((s) => s.walk).filter((w): w is number => w != null);
        if (walks.length > 0 && c.walk != null && !walks.includes(c.walk) && !inMaterial) {
          out.push({ kind: "station", claim: c.text, verdict: "fix", why: `徒歩の分が資料（${walks[0]}分）と違う`, to: c.text.replace(new RegExp(`${c.walk}(\\s*分)$`), `${walks[0]}$1`) });
        } else out.push({ kind: "station", claim: c.text, verdict: "ok", why: same.length ? "台帳の交通にある" : "売上サポの資料にある" });
        continue;
      }
      const g = input.geo?.[c.station];
      const aw = wardKey(input.addressWard);
      const wardWhy = g?.ward && aw && wardKey(g.ward) && wardKey(g.ward) !== aw ? `駅の市区（${g.ward}）が所在地（${input.addressWard}）と違う` : "";
      const lineWhy = c.line && g && g.lines.length > 0 && !lineMatches(c.line, g.lines) ? `${c.line}に${c.station}が無い（駅の表: ${g.lines.slice(0, 3).join("・")}）` : "";
      // ③ 台帳の交通に別の駅だけがある＝資料と違う（出口で落とす）
      if (ledgerStations.length > 0) {
        out.push({ kind: "station", claim: c.text, verdict: "conflict", why: [`台帳の交通は ${[...new Set(ledgerStations.map((s) => s.station))].join("・")}`, wardWhy].filter(Boolean).join("／") });
        continue;
      }
      // ① 駅の表だけで分かる食い違い（市区・路線）は確かめる出どころが無い扱い（境の駅・路線の呼び名の違いがある＝影の運用で数える）
      out.push({ kind: "station", claim: c.text, verdict: "unverified", why: wardWhy || lineWhy || "確かめる出どころが無い（台帳の交通が読めていない）" });
    } else if (c.kind === "admin_fee") {
      if (L?.adminFee == null) { out.push({ kind: "admin_fee", claim: c.text, verdict: "unverified", why: "台帳に管理費・共益費の見出しが無い" }); continue; }
      if (L.adminFee === c.value) { out.push({ kind: "admin_fee", claim: c.text, verdict: "ok", why: "台帳と同じ" }); continue; }
      // 2026-10-17 確かめる人: 見出しが2つ以上（「管理費: 10,000円」と崩れた写しの「共益費: 38,500円」＝実の台帳）だと合計 48,500円に
      //   正しい1通目を書き換えていた。見出しの1つと同じなら ok・0 でない見出しが2つ以上なら決められない（直さない）
      const parts = (L.adminFeeParts ?? []).filter((n) => n > 0);
      if (parts.includes(c.value)) { out.push({ kind: "admin_fee", claim: c.text, verdict: "ok", why: "台帳の見出しの1つと同じ" }); continue; }
      if (parts.length >= 2) { out.push({ kind: "admin_fee", claim: c.text, verdict: "unverified", why: `台帳に管理費・共益費の見出しが2つ以上（${parts.join("・")}円）＝どれか決められない` }); continue; }
      const why = L.parking != null && L.parking === c.value ? `駐車場の金額（${c.value}円）を管理費にした` : `台帳は ${L.adminFee}円`;
      out.push({ kind: "admin_fee", claim: c.text, verdict: "fix", why, to: c.text.replace(/([\d,，]{3,7})(\s*円)$/, `${L.adminFee.toLocaleString("ja-JP")}$2`) });
    } else if (c.kind === "area") {
      if (L?.areaSqm == null) { out.push({ kind: "area", claim: c.text, verdict: "unverified", why: "台帳に専有面積が無い" }); continue; }
      if (Math.abs(L.areaSqm - c.value) < 0.011) { out.push({ kind: "area", claim: c.text, verdict: "ok", why: "台帳と同じ" }); continue; }
      // 2026-10-17 監査: 間取り図の「洋室 25.25㎡」（部屋の広さ）と専有面積 25.28㎡ が両方ある資料で直すと誤り（30件中1件・スタッフは 25.25 のまま送った）→ 直さずログだけ
      out.push({ kind: "area", claim: c.text, verdict: "conflict", why: `台帳の専有面積は ${L.areaSqm}㎡（部屋の広さの数の事もある＝直さない）` });
    } else if (c.kind === "jo") {
      if (!L || L.jo.length === 0) { out.push({ kind: "jo", claim: c.text, verdict: "unverified", why: "台帳に帖の数が無い" }); continue; }
      out.push(L.jo.some((n) => Math.abs(n - c.value) < 0.05)
        ? { kind: "jo", claim: c.text, verdict: "ok", why: "台帳にある" }
        : { kind: "jo", claim: c.text, verdict: "conflict", why: `台帳の帖は ${L.jo.join("・")}` });
    } else if (c.kind === "washbasin") {
      const w = L?.washbasin ?? null;
      if (w === "independent") out.push({ kind: "washbasin", claim: c.text, verdict: "ok", why: "間取り図で独立した洗面所" });
      else if (w === "with_toilet" || w === "with_bath") out.push({ kind: "washbasin", claim: c.text, verdict: "conflict", why: `間取り図は${w === "with_toilet" ? "トイレ" : "浴室"}と同じ部屋` });
      else out.push({ kind: "washbasin", claim: c.text, verdict: "unverified", why: "間取り図の洗面が読めていない" });
    }
  }
  // 合計（家賃＋管理費）を直した管理費に合わせる
  return out;
}

export type GuardMode = "off" | "shadow" | "on";
const modeOf = (v: string | undefined, d: GuardMode): GuardMode => { const s = (v ?? d).trim().toLowerCase(); return s === "on" ? "on" : s === "off" ? "off" : s === "shadow" ? "shadow" : d; };
/**
 * ①の既定（2026-10-17 影の運用の物差し＝竹内さん・スタッフの実送信 70件）:
 *   確かめられない駅（台帳の交通が読めない・駅の表だけの食い違い）2件 → スタッフも2件とも消した（誤り 0）→ 既定 on（AIX_FACT_GUARD_STATION）
 *   間取り図と合わない独立洗面台 4件 → スタッフは4件ともそのまま送った（未桜さんの資料も間取り図の読みは「独立」＝読めていない）→ 影の運用のまま（AIX_FACT_GUARD_WASHBASIN）
 *   AIX_FACT_GUARD=on/off/shadow は両方をまとめて上書きする
 */
export function factGuardMode(env: Record<string, string | undefined> = process.env): GuardMode {
  const m = factGuardModes(env);
  return m.station === "on" || m.washbasin === "on" ? "on" : m.station === "off" && m.washbasin === "off" ? "off" : "shadow";
}
export function factGuardModes(env: Record<string, string | undefined> = process.env): { station: GuardMode; washbasin: GuardMode } {
  if (env.AIX_FACT_GUARD) { const all = modeOf(env.AIX_FACT_GUARD, "shadow"); return { station: all, washbasin: all }; }
  return { station: modeOf(env.AIX_FACT_GUARD_STATION, "on"), washbasin: modeOf(env.AIX_FACT_GUARD_WASHBASIN, "shadow") };
}
export function factExitEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AIX_FACT_EXIT ?? "on").trim().toLowerCase() !== "off";
}

/** 語を本文から落とす（箇条書きの行ならその行ごと・文の中なら語と前後の区切りだけ） */
export function dropPhrase(text: string, phrase: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const at = l.indexOf(phrase);
    if (at < 0) continue;
    const rest = (l.slice(0, at) + l.slice(at + phrase.length)).replace(/^[\s・●◎○■□\-]+|[\s、,・。！!]+$/g, "");
    if (/^[・●◎○■□\-]/.test(l.trim()) && rest.replace(/[・、,\s]/g, "").length <= 1) { lines.splice(i, 1); return lines.join("\n"); }
    const head = l.slice(0, at);
    let tail = l.slice(at + phrase.length);
    if (!head.trim()) tail = tail.replace(/^[・、,]\s*/, "");
    // 確かめる人（2026-10-17・実送信 70件で1件）: 文の中の駅を抜くと「で、家賃管理費込…」「1K で、の立地となります」「最寄りは、専有面積…」と
    //   文が壊れていた。文の頭なら続く助詞を外す・助詞や「、」の後に「の」「、」が続く形はその文（「！！」「。」まで）ごと落とす
    const atSentenceHead = !head.trim() || /[！!。]\s*$/.test(head);
    if (atSentenceHead) tail = tail.replace(/^(?:で|と|から|より|に|が|は|も)?[、,]?\s*/, "");
    let h2 = head;
    if (!atSentenceHead && /[・]\s*$/.test(head) && /^の/.test(tail)) h2 = head.replace(/[・]\s*$/, "");   // 「63,000円・十三駅徒歩6分の1LDK」→「63,000円の1LDK」
    else if ((atSentenceHead && /^の/.test(tail)) || (!atSentenceHead && /[、,]\s*$/.test(head) && /^の/.test(tail))
      || (!atSentenceHead && /[はがも]\s*$/.test(head) && /^\s*(?:[、,]|の)/.test(tail))
      || (!atSentenceHead && /^\s*の(?:立地|場所|距離)/.test(tail))) {
      const sHead = head.search(/[^！!。]*$/);
      const endM = tail.match(/[！!。]+/);
      const sTail = endM && endM.index !== undefined ? tail.slice(endM.index + endM[0].length) : "";
      const merged = (head.slice(0, sHead) + sTail.replace(/^\s+/, "")).trim();
      if (!merged) { lines.splice(i, 1); return lines.join("\n"); }
      lines[i] = merged;
      return lines.join("\n");
    }
    let nl = h2 + tail;
    nl = nl.replace(/([・、,])\s*[・、,]/g, "$1").replace(/[・、,]\s*([！!。]|$)/, "$1");
    lines[i] = nl;
    return lines.join("\n");
  }
  return text;
}

/**
 * 出口: conflict・fix を直す（③）／unverified は mode=on の時だけ落とす（①）。
 * 管理費を直した時は同じ行の「合計 N円」を家賃＋管理費に直す（家賃が同じ行に書いてある時だけ）
 */
export function applyFactDecisions(message: string, decisions: Decision[], opts: { exit: boolean; mode: GuardMode; washbasinMode?: GuardMode }): { text: string; applied: Decision[] } {
  let text = message;
  const applied: Decision[] = [];
  for (const d of decisions) {
    // ③ 出口（台帳と違う駅・管理費・㎡）／① 確かめられない駅・間取り図と合わない独立洗面台（影の運用で数を測ってから）
    const doExit = opts.exit && d.kind !== "washbasin" && (d.verdict === "fix" || d.verdict === "conflict");
    const washMode = opts.washbasinMode ?? opts.mode;
    const doGuard = (opts.mode === "on" && d.verdict === "unverified" && d.kind === "station") || (washMode === "on" && d.kind === "washbasin" && d.verdict === "conflict");
    if (!doExit && !doGuard) continue;
    if (d.verdict === "fix" && d.to) {
      if (!text.includes(d.claim)) continue;
      text = text.replace(d.claim, d.to);
      if (d.kind === "admin_fee") {
        text = text.split("\n").map((l) => {
          if (!l.includes(d.to!)) return l;
          const rent = l.match(/家賃\s*[:：]?\s*([\d,，]{4,7})\s*円/);
          const admin = d.to!.match(/([\d,，]{3,7})\s*円/);
          if (!rent || !admin) return l;
          const sum = (yen(rent[1]) ?? 0) + (yen(admin[1]) ?? 0);
          return l.replace(/(合計|込み?)\s*[:：]?\s*([\d,，]{4,7})\s*円/, (_m, w) => `${w}${sum.toLocaleString("ja-JP")}円`);
        }).join("\n");
      }
      applied.push(d);
      continue;
    }
    if (d.kind === "jo" || d.kind === "area") continue;   // どの帖に直すか決められない＝落とさない（ログだけ）
    const before = text;
    text = dropPhrase(text, d.claim);
    if (text !== before) applied.push(d);
  }
  return { text, applied };
}

/** 2通目・記録に渡す「家賃管理費込」の合計も同じ管理費で（1通目の合計の文字を直した後の値） */
export function totalInFirst(message: string): number | null {
  const m = String(message ?? "").match(/(?:合計|込み?)\s*[:：]?\s*([\d,，]{4,7})\s*円/);
  return m ? yen(m[1]) : null;
}

/**
 * 書き写しの繰り返し（同じ語の並びが何度も続く＝上限まで出し続ける崩れ）を切る（純関数）。
 * 「/」「・」「、」区切りの同じ項目が3回目に出たら、その行はそこで切る。同じ行の3回目からは落とす
 */
export function trimTranscriptRepetition(text: string): { text: string; trimmed: boolean } {
  let trimmed = false;
  const seenLines = new Map<string, number>();
  const out: string[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const key = line.trim();
    if (key) {
      const n = (seenLines.get(key) ?? 0) + 1;
      seenLines.set(key, n);
      if (n >= 3) { trimmed = true; continue; }
    }
    const parts = line.split(/(\s*[／/・、]\s*)/);
    if (parts.length > 6) {
      const seen = new Map<string, number>();
      const keep: string[] = [];
      let cut = false;
      for (let i = 0; i < parts.length; i += 2) {
        const tok = parts[i].trim();
        const c = (seen.get(tok) ?? 0) + 1;
        seen.set(tok, c);
        if (tok && c >= 3) { cut = true; break; }
        keep.push(parts[i]);
        if (i + 1 < parts.length) keep.push(parts[i + 1]);
      }
      if (cut) { trimmed = true; out.push(keep.join("").replace(/\s*[／/・、]\s*$/, "")); continue; }
    }
    out.push(line);
  }
  // 同じ行の並び（4行以上）が前と同じ順で繰り返し始めたら、そこから後ろを切る（一覧を2周写す崩れ）
  for (let i = 1; i < out.length; i++) {
    const k = out[i].trim();
    if (!k) continue;
    for (let j = 0; j < i; j++) {
      if (out[j].trim() !== k) continue;
      let n = 0;
      while (i + n < out.length && j + n < i && out[i + n].trim() === out[j + n].trim()) n++;
      if (n >= 4) return { text: out.slice(0, i).join("\n"), trimmed: true };
    }
  }
  return { text: out.join("\n"), trimmed };
}

