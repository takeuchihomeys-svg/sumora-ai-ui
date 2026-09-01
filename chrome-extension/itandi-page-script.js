(function () {
  "use strict";

  function setReactVal(el, val) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function tick(el) {
    if (el && !el.checked) el.click();
  }

  function norm(s) {
    return String(s)
      .replace(/（/g, "(").replace(/）/g, ")")
      .replace(/〜/g, "~").replace(/～/g, "~")
      .replace(/　/g, " ")
      .trim();
  }

  // itandi BB での駅名表記ゆれ対応（漢字↔ひらがな・別称）
  var ITANDI_STATION_ALIAS_MAP = {
    "難波":       ["難波", "なんば"],
    "なんば":     ["なんば", "難波"],
    "大阪難波":   ["大阪難波", "難波", "なんば"],
    "天王寺":     ["天王寺", "大阪阿部野橋"],
    "大阪阿部野橋": ["大阪阿部野橋", "天王寺"],
    "北浜":       ["北浜", "大阪北浜"],
    "大阪北浜":   ["大阪北浜", "北浜"],
  };
  function getStationAliases(name) {
    return ITANDI_STATION_ALIAS_MAP[name] || [name];
  }

  function isTargetStation(lblText, stNames) {
    var t = lblText.replace(/駅$/, "").trim();
    return stNames.some(function(sn) {
      return getStationAliases(sn).some(function(alias) {
        return norm(alias) === norm(t);
      });
    });
  }

  function isVis(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function textMatch(elText, search) {
    var t = norm(elText);
    var n = norm(search);
    return t === n || t.includes(n);
  }

  // label内のcheckboxを優先（React対応）
  // container: 検索スコープ（省略時はdocument全体。ダイアログ内操作時は必ず渡す）
  function clickLabel(text, container) {
    var root = container || document;
    var lbl = [].slice.call(root.querySelectorAll("label")).find(function (l) {
      return textMatch(l.textContent, text) && isVis(l);
    });
    if (!lbl) return false;
    var inp = lbl.querySelector("input[type='checkbox']");
    if (!inp && lbl.htmlFor) inp = document.getElementById(lbl.htmlFor);
    if (inp) {
      if (!inp.checked) inp.click();
    } else {
      lbl.click();
    }
    return true;
  }

  // buttonのみ。完全一致 → 部分一致フォールバック
  function clickBtn(text) {
    var n = norm(text);
    var btns = [].slice.call(document.querySelectorAll("button")).filter(isVis);
    // 完全一致
    var found = btns.find(function (b) { return norm(b.textContent) === n; });
    if (found) { found.click(); return true; }
    // 部分一致フォールバック（ボタンテキストに検索語が含まれる）
    found = btns.find(function (b) { return norm(b.textContent).includes(n); });
    if (found) {
      console.log("[AXLX] clickBtn partial match: '" + text + "' → '" + found.textContent.trim() + "'");
      found.click(); return true;
    }
    // デバッグ: 表示中の全ボタンテキストを出力
    console.log("[AXLX] clickBtn not found: '" + text + "'. Visible buttons:", btns.map(function(b){ return "'" + b.textContent.trim().slice(0,40) + "'"; }).join(", "));
    return false;
  }

  // ナビタブ（li/button/a/span/label）。完全一致 → 部分一致フォールバック
  // itandiの地域・都道府県タブはLABELタグ（診断で確認済み）
  function clickNav(text) {
    var n = norm(text);
    var els = [].slice.call(document.querySelectorAll("li, button, a, span, label, div[role='button']")).filter(isVis);
    // 完全一致
    var found = els.find(function (el) { return norm(el.textContent) === n; });
    if (found) { found.click(); return true; }
    // 部分一致フォールバック
    found = els.find(function (el) { return norm(el.textContent).includes(n); });
    if (found) {
      console.log("[AXLX] clickNav partial match: '" + text + "' → '" + found.textContent.trim() + "'");
      found.click(); return true;
    }
    return false;
  }

  // ── 所在地モーダル ───────────────────────────────────────────────────────
  // itandi診断済みDOM: LABEL.itandi-bb-ui__InputRadio + input[type=radio]
  //   近畿: name=regionName / 大阪府: name=prefectureId / 区市: name=''
  // 戻り値: boolean（モーダルを開けたか）
  // 市区町村ラジオはname=""の同一グループ → 1区1モーダルで順番に開いてチップを積み上げる方式
  // wardTownMap: { "大阪市城東区": ["稲田本町","稲田新町"], "東大阪市": ["川保本町"] } または null
  // 確定クリック → 1500ms後もモーダルが残っていたら閉じるボタンをクリック
  // ⚠️ Escapeキーは絶対に使わない: itandiのグローバルkeydownがReact状態を壊すため
  function safeConfirm(afterClose) {
    clickBtn("確定");
    setTimeout(function () {
      // dialog内にregionNameが残っている = モーダルが本当に閉じていない
      var dialog = document.querySelector('[role="dialog"]');
      var stuck  = dialog && dialog.querySelector('input[name="regionName"]');
      if (stuck) {
        console.log("[AX] safeConfirm: モーダルが閉じていない → 閉じるボタンをクリック");
        var closeBtn = (dialog.querySelector('button[aria-label="閉じる"]'))
                    || (dialog.querySelector('button[aria-label="close"]'))
                    || (dialog.querySelector('button[aria-label="Close"]'))
                    || document.querySelector('button[aria-label="閉じる"]');
        if (closeBtn) {
          closeBtn.click();
          console.log("[AX] safeConfirm: 閉じるボタンをクリック");
        } else {
          console.warn("[AX] safeConfirm: 閉じるボタン未発見 → 確定を再試行");
          clickBtn("確定");
        }
      }
      // モーダル消失を最大3秒ポーリング（固定1000ms待機の競合を回避）
      var _m12elapsed = 0;
      var _m12poll = setInterval(function() {
        _m12elapsed += 100;
        var dlg = document.querySelector('[role="dialog"]');
        if (!dlg || !dlg.offsetParent) {
          clearInterval(_m12poll);
          afterClose();
        } else if (_m12elapsed >= 3000) {
          clearInterval(_m12poll);
          afterClose(); // タイムアウトでも進める
        }
      }, 100);
    }, 1500);
  }

  function selectItandiArea(wardNamesInput, wardTownMap, townAreaFallback, onDone) {
    var wardNames = Array.isArray(wardNamesInput) ? wardNamesInput : (wardNamesInput ? [wardNamesInput] : []);
    if (!wardNames.length) return false;

    // 同一市の全区が対象かつ町域指定なし → 1回のモーダルで全区を一括チェック
    function getCityPrefix(w) {
      var m = w.match(/^([^\s　]+?[市])/);
      return m ? m[1] : null;
    }
    var batchCity = (function() {
      // ★ 修正(Bug1): batchモードは「明示的な市全域指定（1件）」のみで発火させる。
      // 旧実装は「同一市の区が2件以上・町域なし」でも市全域バッチを発火させており、
      // 例: ["大阪市西区","大阪市西淀川区","大阪市淀川区"] → batchCity="大阪市" となり
      // openBatchCityModal が「大阪市」で始まる全24区を無差別クリックして
      // 指定外の区まで選択されるバグがあった。複数区は1区ずつモード（openNextWardModal）で処理する。
      if (wardNames.length === 1) {
        var single = wardNames[0];
        // 「〇〇市内」パターン（popup.jsが展開できなかった市全域指定）
        var mInner = single.match(/^([^\s　]+?[市])(内)$/);
        if (mInner) return mInner[1];
        // 「〇〇市」（区・町・村を含まない純粋な市名）
        if (/^[^\s　]+[市]$/.test(single) && !/[区町村]/.test(single)) return single;
      }
      return null;
    })();

    // 市全域バッチ選択: 1回のモーダルで全区チェックボックスをまとめて選択
    function openBatchCityModal() {
      var opened = clickBtn("所在地で絞り込む") || clickBtn("所在地を絞り込む")
                || clickBtn("所在地で絞り込み") || clickBtn("エリアで絞り込む")
                || clickBtn("エリアを絞り込む") || clickBtn("エリアで絞り込み")
                || clickBtn("地域で絞り込む") || clickBtn("地域を絞り込む")
                || clickBtn("地域で絞り込み");
      if (!opened) {
        console.log("[AX] batchCity: modal button not found, fallback to one-by-one");
        openNextWardModal(); return;
      }
      setTimeout(function() {
        clickItandiRadio("近畿");
        setTimeout(function() {
          clickItandiRadio("大阪府") || clickItandiRadio("大阪");
          // 大阪府クリック後、区リストのレンダリングをポーリングで待つ
          var npfx = norm(batchCity);
          var pollTries = 0;
          function pollForWardLabels() {

            // 標準label検索（name=""の区radioも含む）
            var labels = [].slice.call(document.querySelectorAll("label")).filter(function(l) {
              var inp = l.querySelector("input[type='radio'], input[type='checkbox']");
              if (!inp) return false;
              var ltxt = norm(l.textContent.trim());
              return ltxt.startsWith(npfx) && !ltxt.startsWith(norm("大阪府")) && !ltxt.startsWith(norm("近畿"));
            });
            // フォールバック: input[name=""]（ITANDI区radio固有構造）で再検索
            if (labels.length === 0) {
              [].slice.call(document.querySelectorAll('input[type="radio"][name=""]')).forEach(function(inp) {
                var pl = inp.closest ? inp.closest("label") : inp.parentElement;
                if (pl && norm(pl.textContent.trim()).startsWith(npfx)) {
                  if (labels.indexOf(pl) === -1) labels.push(pl);
                }
              });
            }
            console.log("[AX] batchCity poll" + (pollTries + 1) + ": " + batchCity + " → " + labels.length + "件");
            if (labels.length > 0) {
              // 各区を500-900ms間隔（ランダム）でクリック（ITANDIのJS処理を待つため）
              var clickIdx = 0;
              function clickNextWardLabel() {
                if (clickIdx >= labels.length) {
                  console.log("[AX] batchCity: 全" + labels.length + "区クリック完了 → 確定");
                  setTimeout(function() {
                    safeConfirm(function() { onDone(); });
                  }, 700 + Math.floor(Math.random() * 400));
                  return;
                }
                var l = labels[clickIdx++];
                l.click();
                console.log("[AX] batchCity: クリック " + clickIdx + "/" + labels.length + ": " + l.textContent.trim());
                // 8%の確率で追加ポーズ（800-1500ms）、それ以外は500-900ms
                var _wardDelay = (Math.random() < 0.08)
                  ? (800 + Math.floor(Math.random() * 700))
                  : (500 + Math.floor(Math.random() * 400));
                setTimeout(clickNextWardLabel, _wardDelay);
              }
              clickNextWardLabel();
            } else if (pollTries++ < 15) {
              setTimeout(pollForWardLabels, 400); // 400ms×15回=最大6秒待機
            } else {
              console.warn("[AX] batchCity: 6秒タイムアウト → 1件ずつに切り替え");
              safeConfirm(function() { openNextWardModal(); });
            }
          }
          setTimeout(pollForWardLabels, 500);
        }, 700 + Math.floor(Math.random() * 400)); // 近畿クリック後 700-1100ms
      }, 1800 + Math.floor(Math.random() * 600)); // モーダル展開後 1800-2400ms
    }

    function clickItandiRadio(text) {
      var n = norm(text);
      var labels = [].slice.call(document.querySelectorAll("label"));
      var found = null;
      for (var i = 0; i < labels.length; i++) {
        if (norm(labels[i].textContent) === n && isVis(labels[i])) { found = labels[i]; break; }
      }
      // ★ 修正(Bug1): 括弧書き（件数等の付加テキスト）を除去して完全一致を再試行
      if (!found) {
        for (var i = 0; i < labels.length; i++) {
          var lt = norm(labels[i].textContent).replace(/[（(].*$/, "");
          if (lt === n && isVis(labels[i])) { found = labels[i]; break; }
        }
      }
      if (!found) {
        // ★ 修正(Bug1): includes判定だと「淀川区」が「西淀川区」「東淀川区」に誤マッチするため、
        // 区町村名で終わる検索語は前方一致（startsWith）のみ許可する
        var isWardTerm = /[区町村]$/.test(n);
        for (var i = 0; i < labels.length; i++) {
          var lt2 = norm(labels[i].textContent);
          var hit = isWardTerm ? lt2.startsWith(n) : lt2.includes(n);
          if (hit && isVis(labels[i])) { found = labels[i]; break; }
        }
      }
      if (!found) return false;
      var inp = found.querySelector("input[type='radio']");
      if (inp && inp.checked) return true;
      found.click();
      return true;
    }

    function getShortName(wName) {
      var s = wName.replace(/^.+?([^\s　市区郡]+[区町村])$/, "$1");
      return s === wName ? null : s;
    }

    var wardIdx = 0;

    // 1区ずつモーダルを開いて確定 → チップが積み上がる方式（ラジオname=""制約の回避）
    function openNextWardModal() {
      if (wardIdx >= wardNames.length) {
        onDone();
        return;
      }
      var wName = wardNames[wardIdx];
      var isLast = wardIdx === wardNames.length - 1;
      // ward_town_map優先。なければtownAreaFallback（後方互換）を最後の区のみ適用
      var townsForWard = null;
      if (wardTownMap && wardTownMap[wName] && wardTownMap[wName].length) {
        townsForWard = wardTownMap[wName];
      } else if (isLast && townAreaFallback) {
        townsForWard = [townAreaFallback];
      }
      wardIdx++;

      var opened = clickBtn("所在地で絞り込む") || clickBtn("所在地を絞り込む")
                || clickBtn("所在地で絞り込み") || clickBtn("エリアで絞り込む")
                || clickBtn("エリアを絞り込む") || clickBtn("エリアで絞り込み")
                || clickBtn("地域で絞り込む") || clickBtn("地域を絞り込む")
                || clickBtn("地域で絞り込み");
      if (!opened) {
        console.log("[AX] selectItandiArea: modal button not found for " + wName);
        setTimeout(openNextWardModal, 800 + Math.floor(Math.random() * 400));
        return;
      }

      setTimeout(function () {
        var regionInp = document.querySelector("input[type='radio'][name='regionName']");
        if (!regionInp || !regionInp.checked) clickItandiRadio("近畿");

        setTimeout(function () {
          var prefInp = document.querySelector("input[type='radio'][name='prefectureId']");
          if (!prefInp || !prefInp.checked) clickItandiRadio("大阪府") || clickItandiRadio("大阪");

          setTimeout(function () {
            var shortName = getShortName(wName);
            var clicked = clickItandiRadio(wName) || (shortName ? clickItandiRadio(shortName) : false);

            function afterWardSelected() {
              if (townsForWard && townsForWard.length) {
                // 全域チェックを外してから個別町域を選択（全域時は個別選択が無効になる）
                setTimeout(function () {
                  var zenLbl = [].slice.call(document.querySelectorAll("label")).find(function (l) {
                    return l.textContent.trim() === "全域" && l.querySelector("input[type='checkbox']") && isVis(l);
                  });
                  var zenInp = zenLbl && zenLbl.querySelector("input");
                  if (zenInp && zenInp.checked) {
                    zenLbl.click();
                    console.log("[AX] 全域チェックを解除");
                  }
                  setTimeout(function () {
                    // 町域checkboxラベルを全取得（スクロール外含む・visibilityチェックなし）
                    var allCbLabels = [].slice.call(document.querySelectorAll("label")).filter(function (l) {
                      return l.querySelector("input[type='checkbox']");
                    });
                    var totalSelected = 0;
                    townsForWard.forEach(function (town) {
                      var tn = norm(town);
                      // スマートマッチ: 完全一致 → 前方一致（〇〇1丁目等）→ 部分一致
                      var matches = allCbLabels.filter(function (l) { return norm(l.textContent.trim()) === tn; });
                      if (!matches.length) {
                        matches = allCbLabels.filter(function (l) { return norm(l.textContent.trim()).startsWith(tn); });
                      }
                      if (!matches.length) {
                        matches = allCbLabels.filter(function (l) { return norm(l.textContent.trim()).includes(tn); });
                      }
                      matches.forEach(function (l) {
                        var inp = l.querySelector("input");
                        if (!inp || !inp.checked) { l.click(); totalSelected++; }
                      });
                      console.log("[AX] 町域選択: " + town + " → " + matches.length + "件");
                    });
                    console.log("[AX] 町域合計: " + totalSelected + "件選択");
                    setTimeout(function () {
                      safeConfirm(function () { setTimeout(openNextWardModal, 700 + Math.floor(Math.random() * 400)); });
                    }, 800 + Math.floor(Math.random() * 400));
                  }, 700 + Math.floor(Math.random() * 400)); // 全域解除後 → 町域チェック開始まで
                }, 700 + Math.floor(Math.random() * 400)); // 区ラジオ選択後 → 全域チェック解除まで
              } else {
                setTimeout(function () {
                  safeConfirm(function () { setTimeout(openNextWardModal, 700 + Math.floor(Math.random() * 400)); });
                }, 700 + Math.floor(Math.random() * 400));
              }
            }

            if (!clicked) {
              console.log("[AX] selectItandiArea: ward not found, retry: " + wName);
              setTimeout(function () {
                var retryResult = clickItandiRadio(wName) || (shortName ? clickItandiRadio(shortName) : false);
                if (!retryResult) {
                  console.warn('[itandi] openNextWardModal: retry failed, aborting');
                  return;
                }
                setTimeout(afterWardSelected, 400 + Math.floor(Math.random() * 300));
              }, 800 + Math.floor(Math.random() * 400));
            } else {
              setTimeout(afterWardSelected, 400 + Math.floor(Math.random() * 300));
            }
          }, 800 + Math.floor(Math.random() * 400)); // 大阪府クリック後 → 区ラジオ選択まで
        }, 700 + Math.floor(Math.random() * 400)); // 近畿クリック後 → 大阪府クリックまで
      }, 1800 + Math.floor(Math.random() * 600)); // モーダル展開後 1800-2400ms
    }

    if (batchCity) {
      openBatchCityModal();
    } else {
      openNextWardModal();
    }
    return true;
  }

  // ── 路線・駅モーダル ─────────────────────────────────────────────────────
  // 戻り値: boolean（モーダルを開けたか）
  // onError: 路線選択失敗時のコールバック（省略時はonDoneにフォールバック）
  function selectItandiLines(lineNames, stationNames, onDone, onError) {
    if (!lineNames || !lineNames.length) return false;
    var opened = clickBtn("路線・駅で絞り込む") || clickBtn("路線・駅を絞り込む")
              || clickBtn("路線・駅で絞り込み") || clickBtn("路線で絞り込む")
              || clickBtn("路線で絞り込み") || clickBtn("沿線・駅で絞り込む")
              || clickBtn("沿線・駅で絞り込み") || clickBtn("沿線・駅を絞り込む");
    if (!opened) return false;

    var stNames = (stationNames || []).map(function (s) { return s.replace(/駅$/, "").trim(); }).filter(Boolean);
    var _abort = typeof onError === "function" ? onError : onDone;

    // ── ポーリングで近畿→大阪府→路線リスト描画を待つ（固定遅延→ポーリングに置換）──
    var _kinkiPolls = 0;
    function pollKinki() {
      if (clickNav("近畿")) { setTimeout(pollOsaka, 100); return; }
      if (++_kinkiPolls >= 25) {
        console.warn("[AX] selectItandiLines: 近畿タブ5s未発見 → 中断");
        _abort(); return;
      }
      setTimeout(pollKinki, 200);
    }
    function pollOsaka() {
      var _p = 0;
      function _poll() {
        if (clickNav("大阪府")) { setTimeout(pollLineList, 100); return; }
        if (++_p >= 25) {
          console.warn("[AX] selectItandiLines: 大阪府タブ5s未発見 → 中断");
          _abort(); return;
        }
        setTimeout(_poll, 200);
      }
      _poll();
    }
    function pollLineList() {
      var _p = 0;
      function _poll() {
        // ダイアログ内のチェックボックスのみ対象（メインフォームの間取り等に誤反応しないため）
        var _dlg = document.querySelector('[role="dialog"]')
                || document.querySelector('[class*="Modal"]')
                || document.querySelector('[class*="modal"]');
        var root = _dlg || document;
        var hasLineLabels = [].slice.call(root.querySelectorAll("label")).some(function(l) {
          return l.querySelector("input[type='checkbox']") && isVis(l);
        });
        if (hasLineLabels && _dlg) { startClickLines(_dlg); return; }
        if (hasLineLabels && !_dlg) {
          console.warn('[itandi] pollLineList: dialog not found, aborting');
          _abort(); return;
        }
        if (++_p >= 25) {
          console.warn("[AX] selectItandiLines: 路線リスト5s未描画 → 中断");
          _abort(); return;
        }
        setTimeout(_poll, 200);
      }
      _poll();
    }
    // 駅ラベル検索（路線名への誤ヒット防止のため完全一致優先）
    // エイリアス全候補を試す（難波↔なんば 等の表記ゆれ対応）
    function tryClickStation(name) {
      var aliases = getStationAliases(name);
      for (var ai = 0; ai < aliases.length; ai++) {
        var n = norm(aliases[ai]);
        var lbl = [].slice.call(document.querySelectorAll("label")).find(function (l) {
          return norm(l.textContent.trim()) === n;
        });
        if (!lbl) {
          lbl = [].slice.call(document.querySelectorAll("label")).find(function (l) {
            var inp = l.querySelector("input[type='checkbox']");
            var txt = l.textContent.trim();
            var nt = norm(txt), nn = norm(n);
            return inp && nt.length <= 8 && nt.includes(nn) && (nt.length - nn.length) <= 1;
          });
        }
        if (lbl) {
          try { lbl.scrollIntoView({ behavior: "instant", block: "nearest" }); } catch (e) {}
          var inp = lbl.querySelector("input[type='checkbox']");
          if (!inp && lbl.htmlFor) inp = document.getElementById(lbl.htmlFor);
          if (inp) { if (!inp.checked) inp.click(); } else { lbl.click(); }
          console.log("[AX] 駅クリック: " + name + (aliases[ai] !== name ? " (alias→" + aliases[ai] + ")" : ""));
          return true;
        }
      }
      return false;
    }

    function startClickLines(dlg) {
      var lineIdx = 0;
      var anyLineClicked = false;
      // ★ 修正: itandi BBは路線ごとに駅リストを切り替えるため、
      // 全路線クリック後まとめて選択しても最後の路線の駅しか選択できないバグを修正。
      // 路線ごとにクリック→1500ms待機→その路線の駅を選択 の順に処理する。
      var _selectedSt = new Set(); // 選択完了した駅の正規化名（重複クリック防止）
      function clickNextLine() {
        if (lineIdx >= lineNames.length) {
          if (!anyLineClicked) {
            console.warn("[AX] selectItandiLines: 路線が1本も選択できなかった → 中断");
            _abort(); return;
          }
          // 全路線・駅の選択完了 → 確定
          var _missing = stNames.filter(function(s) { return !_selectedSt.has(norm(s)); });
          if (_missing.length) console.log("[AX] 選択できなかった駅: " + _missing.join(", "));
          setTimeout(function () {
            clickBtn("確定");
            setTimeout(onDone, 1500);
          }, 600 + Math.floor(Math.random() * 300));
          return;
        }
        var clicked = clickLabel(lineNames[lineIdx], dlg);
        if (clicked) anyLineClicked = true;
        lineIdx++;

        if (!stNames.length) {
          // 駅指定なし → 路線だけ選択して次へ
          setTimeout(clickNextLine, 600 + Math.floor(Math.random() * 400));
          return;
        }

        // 路線クリック後、人間らしいランダム待機（900〜2200ms）してから駅を選択
        setTimeout(function() {
          // 駅を1件ずつランダム遅延でクリック（一気押し防止）
          var _stIdx = 0;
          var _lineKey = lineNames[lineIdx - 1];
          function clickNextStation() {
            if (_stIdx >= stNames.length) {
              // 全駅試行後 → JR駅フォールバック
              stNames.forEach(function(sn) {
                if (!_selectedSt.has(norm(sn)) && sn.startsWith("JR")) {
                  console.log("[AX] 駅未発見(JR駅): " + sn + " → JR沿線フォールバック試行");
                  var jrLabels = [].slice.call(document.querySelectorAll("label")).filter(function(l) {
                    var inp = l.querySelector("input[type='checkbox']");
                    return inp && !inp.checked && norm(l.textContent).includes("JR") && isVis(l);
                  });
                  jrLabels.forEach(function(l) { l.click(); });
                  if (jrLabels.length && tryClickStation(sn)) { _selectedSt.add(norm(sn)); }
                }
              });
              setTimeout(clickNextLine, 500 + Math.floor(Math.random() * 700));
              return;
            }
            var sn = stNames[_stIdx++];
            if (!_selectedSt.has(norm(sn))) {
              if (tryClickStation(sn)) {
                _selectedSt.add(norm(sn));
              } else {
                var _diagDlg = document.querySelector('[role="dialog"]') || document;
                var _diagLbls = [].slice.call(_diagDlg.querySelectorAll("label")).filter(function(l) { return l.querySelector("input[type='checkbox']"); });
                console.log("[AX] 駅未発見: " + sn + " | route=" + _lineKey + " | label数=" + _diagLbls.length + " | サンプル:", _diagLbls.slice(0,6).map(function(l){return '"'+l.textContent.replace(/\s+/g,'').slice(0,20)+'"';}).join(', '));
              }
            }
            // 次の駅まで 300〜800ms ランダム待機（人間らしい操作）
            setTimeout(clickNextStation, 300 + Math.floor(Math.random() * 500));
          }
          clickNextStation();
        }, 900 + Math.floor(Math.random() * 1300));
      }
      clickNextLine();
    }
    pollKinki();
    return true;
  }

  var STRUCTURE_MAP = {
    "木造": "wooden", "木造一部RC造": "wooden",
    "鉄骨造": "steel", "S造": "steel", "重量鉄骨造": "steel",
    "軽量鉄骨造": "lightweight_steel",
    "鉄筋コンクリート造": "rc", "RC": "rc", "RC造": "rc",
    "鉄骨鉄筋コンクリート造": "src", "SRC": "src", "SRC造": "src",
    "ブロック": "block",
    "鉄筋ブロック": "reinforcing_block",
    "PC": "pc", "PC造": "pc",
    "HPC": "hpc", "HPC造": "hpc",
    "ALC": "alc", "ALC造": "alc",
    "CFT": "cft", "CFT造": "cft",
  };
  // DBキー → itandi BB サイドバーのラベルテキスト（IDセレクタ失敗時のフォールバック用）
  var STRUCTURE_LABEL_MAP = {
    "鉄骨鉄筋コンクリート造": "SRC",
    "鉄筋コンクリート造": "RC",
    "鉄骨造": "鉄骨造",
    "軽量鉄骨造": "軽量鉄骨造",
    "木造": "木造",
    "ブロック": "ブロック",
    "鉄筋ブロック": "鉄筋ブロック",
    "PC": "PC", "PC造": "PC",
    "HPC": "HPC", "HPC造": "HPC",
    "ALC": "ALC", "ALC造": "ALC",
    "CFT": "CFT", "CFT造": "CFT",
    "S造": "鉄骨造", "重量鉄骨造": "鉄骨造",
    "SRC": "SRC", "SRC造": "SRC",
    "RC": "RC", "RC造": "RC",
  };

  var VALID_LAYOUTS = ["1R","1K","1DK","1LDK","2K","2DK","2LDK","3K","3DK","3LDK","4K","4DK","4LDK","5K_OVER"];

  // モーダル完了後に入力する条件（専有面積・築年数・間取り・構造・ペット・駅徒歩）
  function fillRemainingFields(cond) {
    // 専有面積（フィールド名はfloor_area_amount:gteq / lteq）
    if (cond.area_min) {
      var areaMinEl = document.querySelector('input[name="floor_area_amount:gteq"]');
      if (areaMinEl) setReactVal(areaMinEl, cond.area_min);
    }
    if (cond.area_max) {
      var areaMaxEl = document.querySelector('input[name="floor_area_amount:lteq"]');
      if (areaMaxEl) setReactVal(areaMaxEl, cond.area_max);
    }
    if (cond.walk_minutes) {
      var walkEl = document.querySelector('input[name="station_walk_minutes:lteq"]');
      if (walkEl) setReactVal(walkEl, cond.walk_minutes);
    }
    if (cond.building_age) {
      var ageEl = document.querySelector('input[name="building_age:lteq"]');
      if (ageEl) setReactVal(ageEl, cond.building_age);
    }
    if (cond.floor_plan) {
      var FLOOR_RANK_IT = ["1R","1K","1DK","1LDK","2K","2DK","2LDK","3K","3DK","3LDK","4K","4DK","4LDK","5K_OVER"];
      var FLOOR_TEXT_IT = {
        "1R":"1R","ワンルーム":"1R","1K":"1K","1DK":"1DK","1LDK":"1LDK",
        "2K":"2K","2DK":"2DK","2LDK":"2LDK",
        "3K":"3K","3DK":"3DK","3LDK":"3LDK",
        "4K":"4K","4DK":"4DK","4LDK":"4LDK",
        "5K以上":"5K_OVER","5K":"5K_OVER","5K_OVER":"5K_OVER"
      };
      // ID直接選択が失敗した場合（itandi BBがDOM更新でIDを変えた等）にラベルテキストで探すフォールバック
      function tickFloor(id) {
        var el = document.querySelector('input[name="room_layout:in"][id="' + id + '"]');
        if (!el) {
          var labelText = id === "5K_OVER" ? "5K以上" : id;
          var lbl = [].slice.call(document.querySelectorAll("label")).find(function(l) {
            var t = l.textContent.trim().replace(/\s+/g, "");
            return (t === labelText || t === id) && isVis(l);
          });
          if (lbl) {
            el = lbl.querySelector("input[type='checkbox']");
            if (!el && lbl.htmlFor) el = document.getElementById(lbl.htmlFor);
          }
          if (!el) { console.warn("[AX] 間取りCB未発見: " + id); return; }
          console.log("[AX] 間取りCB labelフォールバック成功: " + id);
        }
        tick(el);
      }
      var fpStr = cond.floor_plan.trim();
      var ijouMatch  = fpStr.match(/^(.+?)以上$/);
      var rangeMatch = fpStr.match(/^(.+?)[～〜](.+?)$/);
      if (ijouMatch) {
        var baseKey = FLOOR_TEXT_IT[ijouMatch[1].trim()] || ijouMatch[1].trim();
        var baseIdx = FLOOR_RANK_IT.indexOf(baseKey);
        if (baseIdx >= 0) {
          for (var ri = baseIdx; ri < FLOOR_RANK_IT.length; ri++) {
            tickFloor(FLOOR_RANK_IT[ri]);
          }
        }
      } else if (rangeMatch) {
        // 「1DK～1LDK」→ 1DKから1LDKまでの範囲を全選択
        var fromKey = FLOOR_TEXT_IT[rangeMatch[1].trim()] || rangeMatch[1].trim();
        var toKey   = FLOOR_TEXT_IT[rangeMatch[2].trim()] || rangeMatch[2].trim();
        var fromIdx = FLOOR_RANK_IT.indexOf(fromKey);
        var toIdx   = FLOOR_RANK_IT.indexOf(toKey);
        if (fromIdx < 0) fromIdx = 0;
        if (toIdx < 0) toIdx = fromIdx;
        if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
        for (var ri = fromIdx; ri <= toIdx; ri++) {
          tickFloor(FLOOR_RANK_IT[ri]);
        }
      } else {
        // もしくは・または等の接続詞でも分割し、修飾語付き文字列からも間取りを抽出
        var itFloorKeys = Object.keys(FLOOR_TEXT_IT).sort(function(a,b){ return b.length - a.length; });
        function extractFloorIT(token) {
          if (FLOOR_TEXT_IT[token]) return FLOOR_TEXT_IT[token];
          for (var ki = 0; ki < itFloorKeys.length; ki++) {
            if (token.indexOf(itFloorKeys[ki]) >= 0) return FLOOR_TEXT_IT[itFloorKeys[ki]];
          }
          return null;
        }
        fpStr.split(/[・,、\/\.\s]+|もしくは|または|もしくわ|あるいは/).forEach(function (plan) {
          plan = plan.trim();
          var id = extractFloorIT(plan);
          if (id && VALID_LAYOUTS.indexOf(id) !== -1) {
            tickFloor(id);
          }
        });
      }
    }
    // 広げて検索：LDK選択済みの場合、同室数DKも追加チェック
    if (cond.is_wide) {
      ["1LDK","2LDK","3LDK","4LDK"].forEach(function(ldk) {
        var ldkEl = document.querySelector('input[name="room_layout:in"][id="' + ldk + '"]');
        if (ldkEl && ldkEl.checked) {
          var dk = ldk.replace("LDK", "DK");
          var dkEl = document.querySelector('input[name="room_layout:in"][id="' + dk + '"]');
          if (dkEl && !dkEl.checked) tick(dkEl);
        }
      });
    }
    if (cond.structure_types && cond.structure_types.length) {
      cond.structure_types.forEach(function (s) {
        var v = STRUCTURE_MAP[s];
        // ① IDセレクタで直接チェック（最安定）
        var el = v ? document.querySelector('input[name="structure_type:in"][id="' + v + '"]') : null;
        if (el) { tick(el); return; }
        // ② ラベルテキストでフォールバック（itandi BB サイドバー上の表示名で探す）
        var labelText = STRUCTURE_LABEL_MAP[s] || s;
        if (clickLabel(labelText)) {
          console.log("[AX] 構造チェック(label):", labelText);
          return;
        }
        // ③ 元のキー名でも試す
        if (labelText !== s) clickLabel(s);
      });
    }
    if (cond.pet_ok) {
      var petEl = document.querySelector('input[name="option_id:all_in"][id="22010"]');
      function tryTickPet() {
        if (petEl) { tick(petEl); return true; }
        // isVis不要で直接探す（セクション折り畳み中でも対応）
        var lbl = [].slice.call(document.querySelectorAll("label")).find(function(l) {
          return l.textContent.trim() === "ペット相談";
        });
        if (!lbl) return false;
        var inp = lbl.querySelector("input[type='checkbox']");
        if (inp) { if (!inp.checked) inp.click(); } else lbl.click();
        console.log("[AX] ペット相談チェック完了");
        return true;
      }
      if (!tryTickPet()) {
        // セクションが折り畳まれている → 「入居条件（その他）」を展開して再試行
        var sectionToggle = [].slice.call(document.querySelectorAll("button,[role='button'],div,li")).find(function(el) {
          return el.textContent.includes("入居条件") && el.textContent.includes("その他") && isVis(el);
        });
        if (sectionToggle) {
          sectionToggle.click();
          setTimeout(function() {
            petEl = document.querySelector('input[name="option_id:all_in"][id="22010"]');
            if (!tryTickPet()) clickLabel("ペット相談");
          }, 700);
        } else {
          clickLabel("ペット相談");
        }
      }
    }
    if (cond.preferences && /バス.*トイレ別|トイレ別|バストイレ別/i.test(cond.preferences)) {
      var bathEl = document.querySelector('input[name="option_id:all_in"][id="11010"]');
      if (bathEl) tick(bathEl); else clickLabel("バス・トイレ別");
    }
    // 敷金・礼金なし
    if (cond.shikirei_free) {
      var skiLabel = [].slice.call(document.querySelectorAll('label')).find(function(l) {
        var t = l.textContent.replace(/[\s　]/g, '');
        return t === '敷金・礼金なし' || t === '敷金礼金なし' || t === '敷礼なし';
      });
      if (skiLabel) {
        var skiInp = skiLabel.querySelector('input[type="checkbox"]');
        if (skiInp && !skiInp.checked) skiInp.click();
        else if (!skiInp) skiLabel.click();
        console.log('[AX] 敷金・礼金なし チェック完了(itandi)');
      }
    }
  }

  function fill(cond) {
    // 85秒ウォッチドッグ: フリーズ/例外時にbackground.jsを強制解放
    var _watchdog = setTimeout(function () {
      console.warn("[AX] watchdog: 85s timeout — fill-done強制送信");
      window.postMessage({ from: "aixlinx-fill-done", error: "watchdog-timeout" }, "*");
    }, 85000);
    function _safeDone(errMsg) {
      clearTimeout(_watchdog);
      var msg = { from: "aixlinx-fill-done" };
      if (errMsg) msg.error = errMsg;
      window.postMessage(msg, "*");
    }

    // 非ブロッキング警告トースト（alert()はJS実行を止めるため自動モードで使用禁止）
    function showItandiWarnToast(msg) {
      console.log('[AX] ' + msg);
      var t = document.createElement('div');
      t.textContent = '[AX] ' + msg;
      t.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;'
        + 'background:#c0392b;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;'
        + 'max-width:80vw;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4);';
      document.body.appendChild(t);
      setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 5000);
    }

    // 連続検索対応: 前回の条件をリセット
    var _resetBtn = [].slice.call(document.querySelectorAll("button")).find(function(b) {
      var t = b.textContent.trim();
      var r = b.getBoundingClientRect();
      return ["条件全削除","条件クリア","全クリア","クリア"].indexOf(t) >= 0 && (r.width > 0 || r.height > 0);
    });
    var _resetDelay = 0;
    if (_resetBtn) { _resetBtn.click(); _resetDelay = 600; console.log("[AX] 条件リセット実行"); }
    else {
      // ★ 修正(Bug1): 所在地選択はチップ積み上げ方式で解除処理がないため、
      // リセットボタン未発見時は前回検索の区チップが残留したまま追加される。
      // 発見できない場合を必ず可視化し、残留チップ（削除×ボタン付きタグ）の個別削除を試みる
      console.warn("[AX] ⚠️ 条件リセットボタン未発見: 前回の所在地チップが残留している可能性があります");
      var _chipCloseBtns = [].slice.call(document.querySelectorAll("button, [role='button']")).filter(function(b) {
        var t = (b.textContent || "").trim();
        var aria = b.getAttribute && (b.getAttribute("aria-label") || "");
        var r = b.getBoundingClientRect();
        if (!(r.width > 0 || r.height > 0)) return false;
        // チップの削除ボタン: テキストが「×」「✕」のみ、または aria-label が削除系
        return t === "×" || t === "✕" || /削除|remove|delete/i.test(aria);
      });
      if (_chipCloseBtns.length) {
        console.log("[AX] 残留チップ削除ボタンを " + _chipCloseBtns.length + " 件クリック");
        _chipCloseBtns.forEach(function(b, i) { setTimeout(function() { try { b.click(); } catch (e) {} }, i * 250); });
        _resetDelay = _chipCloseBtns.length * 250 + 400;
      }
    }

    setTimeout(function() { try {

    // 未登録地名の警告（NEIGHBORHOOD_WARD_MAPに未登録のトークンをコンソールに表示）
    if (cond.unknown_tokens && cond.unknown_tokens.length) {
      console.log("[AX] ⚠️ 未登録地名（スキップ）: " + cond.unknown_tokens.join(", "));
      console.log("[AX] → popup.js の NEIGHBORHOOD_WARD_MAP に追加が必要です");
    }

    // ── area_mode: webappトグル/ポップアップの明示指定が絶対ルール（自動判定より優先）──
    if (cond.area_mode === "ward") {
      cond.itandi_lines  = [];
      cond.station_names = null;
    } else if (cond.area_mode === "station") {
      cond.ward_name     = null;
      cond.ward_names    = null;
      cond.ward_town_map = null;
    }
    console.log("[AX] 場所モード判定(itandi)", {
      area_mode: cond.area_mode, wards: cond.ward_names || cond.ward_name,
      lines: cond.itandi_lines, stations: cond.station_names });

    // reclassifyLineTokens: station_namesに路線名が混入している場合はitandi_linesへ移動
    (function reclassifyLineTokens() {
      if (!cond.station_names || !cond.station_names.length) return;
      var remaining = [];
      cond.station_names.forEach(function(tok) {
        if (tok.length >= 3 && /線$/.test(tok)) {
          if (!cond.itandi_lines) cond.itandi_lines = [];
          if (cond.itandi_lines.indexOf(tok) === -1) {
            cond.itandi_lines.push(tok);
            console.log('[AX] reclassify: station_names → itandi_lines:', tok);
          }
        } else {
          remaining.push(tok);
        }
      });
      cond.station_names = remaining;
    })();

    // ── STEP 1: 賃料（最初に入力）────────────────────────────────────────
    if (cond.rent_max) {
      var rentVal = cond.rent_max > 1000 ? cond.rent_max / 10000 : cond.rent_max;
      var rentEl = document.querySelector('input[name="rent:lteq"]');
      if (rentEl) setReactVal(rentEl, rentVal);
    }
    tick(document.querySelector('input[name="totalRentCheck"]'));

    // ── STEP 2 & 3: 所在地 or 路線・駅モーダル → 完了後に残り条件 → 検索 ──
    var wardNames = cond.ward_names && cond.ward_names.length ? cond.ward_names : (cond.ward_name ? [cond.ward_name] : []);
    var hasArea  = wardNames.length > 0;
    var hasLines = !!(cond.itandi_lines && cond.itandi_lines.length);

    setTimeout(function () {

      function afterModal() {
        // 間取り input が現れるまで最大3秒ポーリング（固定500ms待機ではReact再レンダリングが保証されない）
        var _afterModalPolled = 0;
        var _afterModalPoll = setInterval(function() {
          _afterModalPolled += 100;
          var layoutInput = document.querySelector("input[name='room_layout:in']") ||
                            document.querySelector("input[name*='layout']");
          if (layoutInput || _afterModalPolled >= 3000) {
            clearInterval(_afterModalPoll);
            fillRemainingFields(cond);
            setTimeout(function () {
              clickBtn("検索");
              setTimeout(function () {
                _safeDone();
              }, 500);
            }, 1000);
          }
        }, 100);
      }

      if (hasArea) {
        var opened = selectItandiArea(wardNames, cond.ward_town_map || null, cond.town_area || null, afterModal);
        if (!opened) {
          var _errA = '所在地で絞り込みボタンが見つかりませんでした';
          console.warn('[AX] ' + _errA);
          showItandiWarnToast(_errA);
          _safeDone(_errA);
        }

      } else if (hasLines) {
        var stNames = cond.station_names || (cond.station_name ? [cond.station_name] : []);
        var opened = selectItandiLines(cond.itandi_lines, stNames, afterModal, function() {
          console.warn('[AX] 路線選択失敗 → fill-done(error)');
          _safeDone('itandi路線選択失敗');
        });
        if (!opened) {
          var _errL = '路線・駅で絞り込みボタンが見つかりませんでした';
          console.warn('[AX] ' + _errL);
          showItandiWarnToast(_errL);
          _safeDone(_errL);
        }

      } else {
        var _errE = '所在地または路線・駅の情報がありません';
        console.warn('[AX] ' + _errE);
        showItandiWarnToast(_errE);
        _safeDone(_errE);
      }

    }, 800);

    } catch(err) {
      console.error('[AX] fill exception', err);
      _safeDone('fill-exception: ' + String(err));
    }
    }, _resetDelay); // 連続検索リセット待機
  }

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "axlx-itandi-fill-exec") return;
    fill(e.data.conditions);
  });
})();
