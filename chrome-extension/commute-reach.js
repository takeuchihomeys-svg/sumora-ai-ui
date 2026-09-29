// chrome-extension/commute-reach.js — 自動生成（scripts/build-osaka-transit-data.ts）。手で編集しない。
// 生成: 2026-09-29
// 中身: app/lib/commute-reach-core.ts（通勤の条件 → 目的の駅に N 分以内で着く駅・路線・区間。JS に変換）。
// 使い方（拡張）: self.AxlxCommuteReach.planCommuteReach({ commute_station, commute_minutes, desired_area }, self.AxlxOsakaTransit,
//   { extLinesOf: (駅名) => STATION_LINE_MAP[駅名] || null, lineOrderOf: (路線) => LINE_STATION_ORDER[路線] || [] })
//   → { extStations（検索に入れる駅・分の短い順）, lines（リアプロ内部名）, segments（レインズの from/to）, capped, skipped }
//   ／ .reachAudit(plan)（点検の記録に載せる数だけの形）／ .reachSummary(plan)（ログの1行）。サーバーは app/lib/commute-reach.ts の同じ関数。
/* eslint-disable */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AxlxCommuteReach = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";
  var exports = {};
  // ───── app/lib/commute-reach-core.ts（変換） ─────
  "use strict";
  // app/lib/commute-reach-core.ts（純関数・import なし・DB 依存なし）
  // 通勤の条件（「梅田まで電車で30分」・commute_station＋commute_minutes の列）から「目的の駅に N 分以内で着く駅」を並べ、
  // 検索に入れる駅（拡張の辞書の言い方）・その駅が乗る路線・路線ごとの区間（レインズの駅の範囲）を決める。
  //
  // 2026-09-29 竹内「物件検索の際に梅田まで電車で30分等の時、梅田駅の沿線は選択されるが、梅田駅に30分の駅が選択される場面が抜かれてしまっている」
  //   点検の記録（search_audits 9/28）で確かめた実物:
  //     ・「難波駅・梅田駅まで電車で30分以内で行ける距離」→ 入れた駅は 難波・なんば・梅田 の3駅だけ（沿線は 36 路線）。件数 0〜2
  //       （popup の古い読み「まで電車30分」は「電車で30分」の「で」を読めず、目的の駅の沿線だけが API から足されていた）
  //     ・通勤の列（commute_station「難波駅」・commute_minutes 15）は拡張のどこも読んでいなかった（希望エリア「難波周辺」→3駅・件数 2）
  //   直し: 到達時間は transit-core（osaka-geo の路線・直通・乗り換え5分）で決定論に出す。乗り換えは1回まで。目的の駅のまとまり
  //   （梅田＝大阪・西梅田・北新地 等）の駅も入れる。サイトの表記はここで作らない（拡張の辞書の駅名に戻すだけ・3サイトの表は拡張の既存の対応表）。
  //
  // ■ サーバーと拡張で同じ関数
  //   このファイルは import を持たない。サーバー（app/lib/commute-reach.ts）は transit-route の関数を ReachTransit として渡し、
  //   拡張（chrome-extension/commute-reach.js・self.AxlxCommuteReach）は scripts/build-osaka-transit-data.ts がこのファイルを JS に変換して書き出す。
  //
  // ■ 決まり
  //   - 目的の駅と分: 希望エリアの文（「梅田まで電車で30分」「梅田から20分以内」「谷町九丁目通勤20分圏内」「A・Bまで30分」＝A と B の両方）と
  //     通勤の列（commute_station「難波駅・梅田駅」＋commute_minutes 40 →「難波駅・梅田駅まで40分」）。同じ目的なら短い方の分。
  //     分の無い言い方（「梅田まで電車1本」「天王寺へ通勤」）はここでは扱わない（電車1本は popup の resolveDirectCommute が今まで通り）。
  //   - 列だけの時（希望エリアに通勤の言い方が無い）は、希望エリアが具体的な駅・地名（「大日駅」）なら広げない（skipped=concrete_area）。
  //     「難波周辺」「大阪市内」「（空）」のように場所を決めていない時だけ広げる。希望エリアの文に通勤の言い方がある時は今まで通り広げる。
  //   - 複数の目的（「難波・梅田まで30分」）は和集合（どちらかに30分で着く駅）。積集合にはしない（読み違いで漏らすより広く）。
  //   - 駅の数の上限 maxStations（既定 240）。超える時は所要時間の短い順に切る（capped=true）。
  //   - 路線は駅から引く（deps.extLinesOf）＝乗り換え1回で着く別の沿線も入る。区間は路線の駅の並び（deps.lineOrderOf）の中の
  //     「入れる駅の一番端から端まで」（レインズの沿線×駅 from/to に使う）。
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.DEFAULT_MAX_STATIONS = exports.DEFAULT_MAX_TRANSFERS = void 0;
  exports.columnPhrase = columnPhrase;
  exports.precedingTargets = precedingTargets;
  exports.readTargets = readTargets;
  exports.concreteAreaTokens = concreteAreaTokens;
  exports.pickExtNames = pickExtNames;
  exports.planCommuteReach = planCommuteReach;
  exports.reachAudit = reachAudit;
  exports.reachSummary = reachSummary;
  exports.DEFAULT_MAX_TRANSFERS = 1;
  exports.DEFAULT_MAX_STATIONS = 240;
  /** osaka-transit の路線名 → 拡張の STATION_LINE_MAP の路線名（リアプロ内部名）。駅名の言い方を選び分けるためだけに使う（commute-candidates と同じ） */
  const LINE_TO_EXT = { "JR神戸線": ["東海道本線"], "JR宝塚線": ["福知山線"], "JRゆめ咲線": ["桜島線"] };
  const SEP_RE = /[、,，・/／\s　()（）]+/;
  /** 通勤の言い方が入っている語（この語は場所の指定ではない） */
  const PHRASE_RE = /まで|から|へ|に|分|通勤|通学|圏内|一本|1本|１本|直通|乗り?換|アクセス|行きやすい|出やすい/;
  /** 場所を決めていない言い方 */
  const GENERIC_RE = /^(?:大阪市内|市内|大阪市|大阪府|大阪|府内|どこでも|特になし|特に無し|なし|無し|未定|こだわらない|希望なし|指定なし|お任せ|おまかせ)$/;
  /** 「〜周辺」＝場所を決めていない（広げてよい） */
  const VAGUE_RE = /(?:周辺|付近|近辺|あたり|辺り|ら辺|らへん|エリア|方面|寄り|近く|界隈|近辺)$/;
  function uniq(arr) { const s = new Set(); return arr.filter((x) => (s.has(x) ? false : (s.add(x), true))); }
  function nfkc(s) { return String(s ?? "").normalize("NFKC"); }
  /** 通勤の列 → 文（「難波駅・梅田駅まで40分」）。分が無い時は ""（広げる材料が無い） */
  function columnPhrase(input) {
      const st = nfkc(input.commute_station).trim();
      const mins = Number(input.commute_minutes);
      if (!st || !(mins > 0))
          return "";
      return `${st}まで${Math.round(mins)}分`;
  }
  /** 「A・Bまで30分」「日本橋又は谷町九丁目通勤20分」の A（前に並んだ駅）を目的に足す。index は通勤の言い方の始まり */
  function precedingTargets(text, index, T) {
      const head = text.slice(0, index);
      if (!head)
          return [];
      const parts = head.split(/(?:又は|または|もしくは|or|OR)|[・、,，/／]/).map((x) => x.trim());
      if (parts.length && parts[parts.length - 1] === "")
          parts.pop(); // 「難波駅・」で終わる
      const out = [];
      for (let i = parts.length - 1; i >= 0 && out.length < 3; i--) {
          const w = parts[i].replace(/駅$/, "");
          if (!w || w.length > 12 || PHRASE_RE.test(w))
              break;
          const g = T.groupOf(w);
          if (!g)
              break;
          out.unshift(g.key);
      }
      return out;
  }
  /** 目的の駅と分（列と文から。同じ目的は短い方の分）。分の無い言い方は入れない */
  function readTargets(input, T) {
      const out = [];
      const push = (t) => {
          const prev = out.find((o) => o.target === t.target);
          if (!prev) {
              out.push(t);
              return;
          }
          if (t.minutes < prev.minutes) {
              prev.minutes = t.minutes;
              prev.word = t.word;
              prev.source = t.source;
          }
      };
      const read = (text, source) => {
          const t = nfkc(text);
          if (!t.trim())
              return;
          for (const a of T.commuteAsks(t)) {
              if (a.minutes == null || !(a.minutes > 0))
                  continue;
              push({ target: a.target, word: a.word, minutes: a.minutes, source });
              // 「日本橋又は谷町九丁目通勤20分」: 目的の語の前（同じ言い方の中も）に並んだ駅も目的
              const wordAt = Math.max(0, String(a.source ?? "").indexOf(a.word));
              for (const p of precedingTargets(t, a.index + wordAt, T))
                  push({ target: p, word: p, minutes: a.minutes, source });
          }
      };
      read(input.desired_area ?? "", "text");
      read(columnPhrase(input), "column");
      return out;
  }
  /** 希望エリアの語のうち「具体的な場所」（通勤の言い方・目的の駅・広い言い方・「〜周辺」を除いた残り） */
  function concreteAreaTokens(desiredArea, targets, T) {
      const raw = nfkc(desiredArea);
      const targetKeys = new Set(targets.map((t) => t.target));
      const out = [];
      for (const tok0 of raw.split(SEP_RE)) {
          const tok = tok0.replace(/[()（）「」]/g, "").trim();
          if (!tok || tok.length < 2)
              continue;
          if (PHRASE_RE.test(tok))
              continue;
          if (GENERIC_RE.test(tok))
              continue;
          if (VAGUE_RE.test(tok))
              continue;
          const g = T.groupOf(tok.replace(/駅$/, ""));
          if (g && targetKeys.has(g.key))
              continue;
          out.push(tok);
      }
      return uniq(out);
  }
  /** そろえた駅名 → 検索に入れる言い方（乗る路線に合う言い方を優先。辞書に無ければ []） */
  function pickExtNames(T, station, routeLines, deps) {
      const names = T.extNames(station).filter((w) => !!deps.extLinesOf(w));
      if (!names.length)
          return [];
      const want = [];
      for (const l of routeLines || [])
          for (const x of LINE_TO_EXT[l] || [l])
              if (!want.includes(x))
                  want.push(x);
      const hit = names.filter((w) => (deps.extLinesOf(w) || []).some((l) => want.includes(l)));
      return hit.length ? hit : [names[0]];
  }
  /**
   * 通勤の条件から検索に入れる駅を決める。通勤の分が読めない時は null。
   * 列だけで希望エリアが具体的な時は stations 空・skipped="concrete_area"（点検の記録に残す）。
   */
  function planCommuteReach(input, T, deps, opts = {}) {
      const targets = readTargets(input, T);
      if (!targets.length)
          return null;
      const maxTransfers = opts.maxTransfers ?? exports.DEFAULT_MAX_TRANSFERS;
      const maxStations = opts.maxStations ?? exports.DEFAULT_MAX_STATIONS;
      const concrete = concreteAreaTokens(input.desired_area, targets, T);
      const base = { targets, stations: [], extStations: [], lines: [], segments: [], total: 0, capped: false, maxTransfers, skipped: null, concrete };
      if (concrete.length && targets.every((t) => t.source === "column"))
          return { ...base, skipped: "concrete_area" };
      const map = new Map();
      const put = (station, minutes, transfers, lines, target) => {
          const ext = pickExtNames(T, station, lines, deps);
          if (!ext.length)
              return;
          const prev = map.get(station);
          if (!prev) {
              map.set(station, { station, ext, minutes, transfers, lines, targets: [target] });
              return;
          }
          if (!prev.targets.includes(target))
              prev.targets.push(target);
          if (minutes < prev.minutes || (minutes === prev.minutes && transfers < prev.transfers)) {
              prev.minutes = minutes;
              prev.transfers = transfers;
              prev.lines = lines;
              prev.ext = ext;
          }
      };
      for (const t of targets) {
          const w = T.stationsWithin(t.target, t.minutes, { maxTransfers });
          if (!w)
              continue;
          for (const m of w.target.members)
              put(m, 0, 0, T.linesOf(m), t.target); // 目的の駅そのもの（梅田＝大阪・西梅田・北新地）
          for (const s of w.stations)
              put(s.station, s.minutes, s.transfers, s.lines, t.target);
      }
      const all = [...map.values()].sort((a, b) => a.minutes - b.minutes || a.transfers - b.transfers || a.station.localeCompare(b.station, "ja"));
      const total = all.length;
      const stations = all.slice(0, maxStations);
      const extStations = uniq(stations.flatMap((s) => s.ext));
      const lineCount = new Map();
      for (const w of extStations)
          for (const l of deps.extLinesOf(w) || [])
              lineCount.set(l, (lineCount.get(l) ?? 0) + 1);
      const lines = [...lineCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja")).map(([l]) => l);
      const extSet = new Set(extStations);
      const segments = lines.map((line) => {
          const order = deps.lineOrderOf ? deps.lineOrderOf(line) : [];
          const idx = order.map((s, i) => (extSet.has(s) ? i : -1)).filter((i) => i >= 0);
          return { line, count: lineCount.get(line) ?? 0, from: idx.length ? order[idx[0]] : null, to: idx.length ? order[idx[idx.length - 1]] : null };
      });
      return { ...base, stations, extStations, lines, segments, total, capped: total > maxStations };
  }
  /** 点検の記録に載せる形 */
  function reachAudit(plan) {
      if (!plan)
          return null;
      return {
          targets: plan.targets.map((t) => ({ target: t.target, minutes: t.minutes, source: t.source })),
          stations: plan.extStations.length, total: plan.total, capped: plan.capped, lines: plan.lines.length, transfers: plan.maxTransfers, skipped: plan.skipped,
      };
  }
  /** ログ・画面用の1行（「梅田まで30分（乗り換え1回まで）→ 262駅・36路線」） */
  function reachSummary(plan) {
      if (!plan)
          return "";
      const t = plan.targets.map((x) => `${x.target}まで${x.minutes}分`).join("・");
      if (plan.skipped)
          return `${t}: 希望エリアが具体的（${plan.concrete.join("・")}）なので駅は広げない`;
      return `${t}（乗り換え${plan.maxTransfers === 0 ? "なし" : `${plan.maxTransfers}回まで`}）→ ${plan.extStations.length}駅・${plan.lines.length}路線${plan.capped ? `（${plan.total}駅を上限で切った）` : ""}`;
  }

  exports.version = "2026-09-29";
  return exports;
});
