// 크림(KREAM) 판매내역 추출 북마클릿 — 원본 소스 (검증용) v4
//
// v4에서 달라진 점: 건마다 북마클릿을 다시 누를 필요가 없습니다.
//   한 번 누르면 화면 오른쪽 위에 작은 패널이 뜨고, 그 뒤로는
//   [전체 자동 수집] 버튼 하나로 목록 전체를 훑거나,
//   사용자가 상세를 열기만 하면 자동으로 감지해 누적합니다.
//
// 동작:
//  [패널] 누적 건수 표시 / 전체 자동 수집 / CSV 저장 / 누적 비우기 / 닫기
//  [자동 감지] 보관 상세 팝업이 열리면 알림창 없이 조용히 누적 (중복은 건너뜀)
//  [전체 자동 수집] 목록을 끝까지 자동 스크롤한 뒤, "보관 상세"를 하나씩 열고
//    읽고 닫기를 반복합니다. 도중에 막히면 멈추고 안내하며,
//    그 뒤에는 사용자가 직접 열기만 해도 자동 감지가 계속 누적합니다.
//  [목록 추출] 상세 누적이 하나도 없을 때 CSV 저장을 누르면
//    화면 목록에서 추출합니다 (보관판매 정산내역: 금액 포함 /
//    판매내역 종료 탭: 금액 없음 / 기타: 가격 표기 화면).
//
// 보안 설계:
//   1. kream.co.kr 도메인에서만 동작
//   2. 네트워크 요청 없음 — 어떤 서버로도 데이터를 보내지 않음
//   3. 로그인 정보·쿠키에 접근하지 않음. 화면 텍스트만 읽으며,
//      계좌번호·현금영수증 발급번호 등 민감정보는 추출하지 않음
//   4. 자동 수집은 "보관 상세"라고 적힌 요소만 클릭 — 취소·삭제 등
//      다른 버튼은 절대 누르지 않음
//   5. 누적 데이터는 본인 브라우저(크림 도메인 localStorage)에만 임시 저장되고
//      CSV 저장 시 삭제됨
(function () {
  if (!/(^|\.)kream\.co\.kr$/.test(location.hostname)) {
    alert('이 버튼은 크림(kream.co.kr)에서만 동작합니다.\n크림에 로그인해 판매내역 화면을 연 뒤 눌러주세요.');
    return;
  }
  if (window.__taxHelperKream) { window.__taxHelperKream.show(); return; }

  var KEY = 'tax-helper-kream-details-v1';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---------- 텍스트 파싱 유틸 ----------
  function bodyLines() {
    return document.body.innerText.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  }
  var dateReLoose = /(20\d{2}|\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/;
  function normDateLoose(s) {
    var m = String(s).match(dateReLoose);
    if (!m) return null;
    var y = m[1].length === 2 ? '20' + m[1] : m[1];
    return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  }
  function normDateStrict(s) {
    return dateReLoose.test(String(s).trim()) && /^[\d.\-\/\s:]+$/.test(String(s).trim()) ? normDateLoose(s) : null;
  }
  function amt(s) {
    var t = String(s).replace(/[-원,\s]/g, '');
    return /^\d+$/.test(t) ? Number(t) : null;
  }
  function fmtWon(n) { return n === null || n === undefined ? '' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function loadBuf() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
  function saveBuf(b) { localStorage.setItem(KEY, JSON.stringify(b)); }

  // ---------- 상세(모달) 읽기 ----------
  function modalOpen() {
    var lines = bodyLines();
    var i = lines.indexOf('판매 정산 정보');
    return i >= 0 && lines.indexOf('거래일시', i) >= 0;
  }
  // 모달이 떠 있어도 innerText에는 배경 목록 텍스트가 섞이므로,
  // 라벨 검색은 모달 구간("판매 정산 정보" 이후)으로 한정한다
  function readModal() {
    var lines = bodyLines();
    var start = lines.indexOf('판매 정산 정보');
    if (start < 0 || lines.indexOf('거래일시', start) < 0) return null;
    function after(label) {
      var i = lines.indexOf(label, start);
      return i >= 0 && i + 1 < lines.length ? lines[i + 1] : null;
    }
    var num = null;
    for (var i2 = 0; i2 < lines.length; i2++) {
      var mNum = lines[i2].match(/^보관번호\s*(I-[A-Z0-9-]+)/i);
      if (mNum) { num = mNum[1]; break; }
    }
    var name = null, size = null;
    var k = lines.indexOf('상품상세');   // 모달에만 있는 라벨 (목록은 '보관 상세')
    if (k >= 2) { size = lines[k - 1]; name = lines[k - 2]; }
    var price = amt(after('판매가'));
    if (!name || price === null) return null;
    return {
      num: num || '', name: size ? name + ' (' + size + ')' : name,
      date: normDateLoose(after('거래일시') || '') || '',
      price: price, fee: amt(after('수수료')), settle: amt(after('정산금액'))
    };
  }
  // 열린 모달을 담고 있는 가장 작은 요소 (닫기 버튼을 그 안에서만 찾기 위함)
  function modalBox() {
    var best = null;
    var all = document.body.querySelectorAll('div,section,aside,dialog');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = el.innerText || '';
      if (t.indexOf('판매 정산 정보') >= 0 && t.indexOf('거래일시') >= 0) {
        if (!best || t.length < (best.innerText || '').length) best = el;
      }
    }
    return best;
  }

  // 상세 1건 누적. 반환: 'added' | 'dup' | null(읽기 실패)
  function capture() {
    var d = readModal();
    if (!d) return null;
    var buf = loadBuf();
    if (d.num && buf.some(function (b) { return b.num === d.num; })) return 'dup';
    if (!d.num && buf.some(function (b) { return b.name === d.name && b.date === d.date && b.price === d.price; })) return 'dup';
    buf.push(d);
    saveBuf(buf);
    render();
    return 'added';
  }

  // ---------- 자동 수집 ----------
  function detailButtons() {
    var out = [];
    var all = document.body.querySelectorAll('a,button,span,div,p,li');
    for (var i = 0; i < all.length; i++) {
      // "보관 상세"만 정확히 일치하는 요소만 클릭 대상 — 취소·삭제 등은 절대 누르지 않음
      if ((all[i].textContent || '').trim() === '보관 상세' && all[i].offsetParent !== null) out.push(all[i]);
    }
    return out;
  }
  async function waitFor(fn, ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(150); }
    return false;
  }
  async function autoScroll(setStatus) {
    var last = -1, stable = 0;
    for (var i = 0; i < 300 && stable < 3; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(400);
      var h = document.body.scrollHeight;
      if (h === last) stable++; else { stable = 0; last = h; }
      if (setStatus && i % 3 === 0) setStatus('목록 불러오는 중… (' + Math.round(h / 1000) + 'k)');
    }
    window.scrollTo(0, 0);
    await sleep(300);
  }
  async function closeModal() {
    var box = modalBox();
    if (box) {
      var cands = box.querySelectorAll('button,a,[role=button],span,i');
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        var lab = ((el.getAttribute && (el.getAttribute('aria-label') || el.className)) || '') + ' ' + (el.textContent || '').trim();
        if (/닫기|close/i.test(lab) && el.offsetParent !== null && (el.textContent || '').trim().length < 6) {
          el.click();
          if (await waitFor(function () { return !modalOpen(); }, 1500)) return true;
        }
      }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    if (await waitFor(function () { return !modalOpen(); }, 1200)) return true;
    history.back();
    return await waitFor(function () { return !modalOpen(); }, 1500);
  }
  var running = false;
  async function autoCollect(setStatus) {
    if (running) return;
    running = true;
    try {
      setStatus('목록을 끝까지 불러오는 중…');
      await autoScroll(setStatus);
      var n = detailButtons().length;
      if (!n) {
        setStatus('"보관 상세" 버튼을 찾지 못했습니다. 상세를 직접 열면 자동 누적됩니다.');
        return;
      }
      if (!confirm('화면에서 ' + n + '건의 [보관 상세]를 찾았습니다.\n하나씩 열어 판매가·수수료를 수집합니다. 진행할까요?\n\n(수집 중에는 화면을 건드리지 마세요. 중단하려면 패널의 [중단]을 누르세요)')) {
        setStatus('취소했습니다.');
        return;
      }
      var added = 0, failed = 0;
      for (var i = 0; i < n; i++) {
        if (!running) { setStatus('중단했습니다. 누적 ' + loadBuf().length + '건.'); return; }
        setStatus('수집 중… ' + (i + 1) + '/' + n);
        var btns = detailButtons();      // 목록이 다시 그려질 수 있어 매번 새로 찾는다
        if (i >= btns.length) break;
        btns[i].click();
        if (!(await waitFor(modalOpen, 6000))) { failed++; await closeModal(); continue; }
        await sleep(350);                // 금액이 늦게 채워지는 경우 대비
        var r = capture();
        if (r === 'added') added++; else if (r === null) failed++;
        if (!(await closeModal())) {
          setStatus('팝업이 닫히지 않아 멈췄습니다. 누적 ' + loadBuf().length + '건. 직접 닫고 계속하세요.');
          return;
        }
        await sleep(250);
      }
      setStatus('완료 — 새로 ' + added + '건 수집' + (failed ? ' / ' + failed + '건 실패' : '') + '. 누적 ' + loadBuf().length + '건.');
    } finally { running = false; render(); }
  }

  // ---------- CSV ----------
  function esc(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  var header = ['구분', '판매일', '플랫폼', '품목', '판매가', '구매일', '구매가', '손익', '보유기간', '판매사유'];
  function downloadCSV(rows, fname, msg) {
    var csv = '\uFEFF' + header.map(esc).join(',') + '\r\n' + rows.join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = fname;
    a.click();
    alert(msg);
  }
  function saveDetails() {
    var buf = loadBuf();
    if (!buf.length) return false;
    var rows = buf.map(function (b) {
      var memo = [];
      if (b.fee !== null && b.fee !== undefined) memo.push('크림 수수료 ' + fmtWon(b.fee) + '원');
      if (b.settle !== null && b.settle !== undefined) memo.push('정산금액 ' + fmtWon(b.settle) + '원');
      if (b.num) memo.push(b.num);
      return ['리셀', b.date, '크림(KREAM)', b.name, b.price, '', '', '', '', memo.join(' / ')].map(esc).join(',');
    });
    localStorage.removeItem(KEY);
    render();
    downloadCSV(rows, '크림판매상세.csv',
      '누적된 상세 ' + buf.length + '건을 크림판매상세.csv로 내려받았습니다 (누적 목록은 비웠습니다).\n' +
      '중고거래 세금 도우미 > ② 판매 대장 > CSV 복원으로 불러오세요.\n판매가는 총 판매금액이며, 수수료는 판매사유 칸에 기록되어 있습니다.');
    return true;
  }

  // ---------- 목록 화면 추출 (상세 누적이 없을 때) ----------
  var sizeRe = /^(ONE ?SIZE|FREE|[A-Z]{1,4}|[WM]?\d{2,3}(\.\d)?|US ?\d{1,2}(\.\d)?|EU ?\d{2,3}|\d{2,3}\s*-\s*[0-9A-Za-z가-힣 ]+)$/i;
  function scanList() {
    var lines = bodyLines();
    var items = [];
    // 목록 1: "보관 판매" 정산내역 — 상품명 / I-번호 / 사이즈 / 정산금액 / 정산일
    lines.forEach(function (l, i) {
      if (l !== '정산일') return;
      var date = normDateStrict(lines[i + 1] || '');
      if (!date) return;
      var amount = null, size = null, name = null, j, c;
      for (j = i - 1; j >= Math.max(0, i - 10); j--) {
        c = lines[j];
        if (c === '정산일') break;
        if (c === '정산금액' && amount === null) amount = amt(lines[j + 1] || '');
        if (c === '사이즈' && size === null) size = lines[j + 1] || '';
        if (/^I-[A-Z0-9-]+$/i.test(c) && !name) {
          var cand = lines[j - 1] || '';
          if (cand === '-' || cand.length < 3) cand = lines[j - 2] || '';
          if (cand.length >= 3) name = cand;
          break;
        }
      }
      if (name && amount !== null) {
        items.push({ name: size ? name + ' (' + size + ')' : name, date: date, price: amount, memo: '크림 정산금액 기준' });
      }
    });
    // 목록 2: 판매내역 "종료" 탭 — 상품명 / 사이즈 / 정산일 / 정산완료 (가격 없음)
    var doneRe = /^(정산완료|판매완료|배송완료|거래완료)$/;
    var cancelRe = /^(취소완료|거래실패|반송완료|판매거부)$/;
    var noiseRe = /(합격|불합격|검수)|^-$/;
    if (!items.length) {
      lines.forEach(function (l, i) {
        if (cancelRe.test(l) || !doneRe.test(l)) return;
        var date = null, size = null, name = null, j, c;
        for (j = i - 1; j >= Math.max(0, i - 6) && !name; j--) {
          c = lines[j];
          if (doneRe.test(c) || cancelRe.test(c)) break;
          if (noiseRe.test(c)) continue;
          if (!date) { var d = normDateStrict(c); if (d) { date = d; continue; } }
          if (!size && sizeRe.test(c)) { size = c; continue; }
          if (c.length >= 4 && !sizeRe.test(c) && !normDateStrict(c)) name = c;
        }
        if (name) items.push({ name: size ? name + ' (' + size + ')' : name, date: date || '', price: '', memo: '' });
      });
    }
    // 목록 3(예비): 가격 표기가 있는 기타 화면
    if (!items.length) {
      var isPrice = function (s) { return /^[\d,]{4,}\s*원?$/.test(s) && (s.indexOf(',') >= 0 || s.indexOf('원') >= 0); };
      lines.forEach(function (l, i) {
        if (!isPrice(l)) return;
        var name = null, date = null, j, c;
        for (j = i - 1; j >= Math.max(0, i - 5) && !name; j--) {
          c = lines[j];
          if (!isPrice(c) && !normDateStrict(c) && !/^\d+(\.\d+)?$/.test(c) && !sizeRe.test(c) && c.length >= 4) name = c;
        }
        for (j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3) && !date; j++) {
          var d2 = normDateStrict(lines[j]); if (d2) date = d2;
        }
        if (name) items.push({ name: name, date: date || '', price: Number(l.replace(/[원,\s]/g, '')), memo: '' });
      });
    }
    return items;
  }
  async function saveList(setStatus) {
    setStatus('목록을 끝까지 불러오는 중…');
    await autoScroll(setStatus);
    var items = scanList();
    if (!items.length) {
      setStatus('판매내역을 찾지 못했습니다.');
      alert('판매내역을 찾지 못했습니다.\n보관 판매 > 정산완료 탭 또는 판매 내역 > 종료 탭에서 목록이 보이는 상태로 눌러주세요.');
      return;
    }
    var rows = items.map(function (it) {
      return ['리셀', it.date, '크림(KREAM)', it.name, it.price === '' ? '' : it.price, '', '', '', '', it.memo || ''].map(esc).join(',');
    });
    setStatus(items.length + '건 저장했습니다.');
    downloadCSV(rows, '크림판매내역.csv',
      items.length + '건을 크림판매내역.csv로 내려받았습니다.\n중고거래 세금 도우미 > ② 판매 대장 > CSV 복원으로 불러오세요.\n\n' +
      '판매가·수수료까지 정확히 넣으려면 패널의 [전체 자동 수집]을 사용하세요.');
  }

  // ---------- 패널 ----------
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#fff;color:#191f28;' +
    'border:1px solid #d8dce0;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:14px 16px;' +
    'width:270px;font:13px/1.5 -apple-system,"Malgun Gothic",sans-serif;';
  box.innerHTML =
    '<div style="font-weight:700;margin-bottom:2px;">크림 판매내역 수집</div>' +
    '<div id="thk-count" style="font-size:20px;font-weight:800;margin:2px 0 8px;">0건 누적</div>' +
    '<button id="thk-auto" style="width:100%;padding:9px;margin-bottom:6px;border:0;border-radius:8px;background:#3182f6;color:#fff;font-weight:700;font-size:13px;cursor:pointer;">전체 자동 수집</button>' +
    '<button id="thk-save" style="width:100%;padding:9px;margin-bottom:6px;border:1px solid #d8dce0;border-radius:8px;background:#fff;font-weight:600;font-size:13px;cursor:pointer;">CSV 저장</button>' +
    '<div style="display:flex;gap:6px;"><button id="thk-clear" style="flex:1;padding:7px;border:1px solid #d8dce0;border-radius:8px;background:#fff;font-size:12px;cursor:pointer;">누적 비우기</button>' +
    '<button id="thk-hide" style="flex:1;padding:7px;border:1px solid #d8dce0;border-radius:8px;background:#fff;font-size:12px;cursor:pointer;">닫기</button></div>' +
    '<div id="thk-status" style="margin-top:8px;font-size:12px;color:#6b7684;">상세를 열면 자동으로 누적됩니다.</div>';
  document.body.appendChild(box);
  var $ = function (id) { return box.querySelector('#' + id); };
  function setStatus(s) { $('thk-status').textContent = s; }
  function render() {
    var n = loadBuf().length;
    $('thk-count').textContent = n + '건 누적';
    $('thk-auto').textContent = running ? '중단' : '전체 자동 수집';
  }
  $('thk-auto').onclick = function () {
    if (running) { running = false; return; }
    autoCollect(setStatus);
    render();
  };
  $('thk-save').onclick = function () { if (!saveDetails()) saveList(setStatus); };
  $('thk-clear').onclick = function () {
    if (confirm('누적된 상세 내역을 모두 지울까요?')) { localStorage.removeItem(KEY); render(); setStatus('비웠습니다.'); }
  };
  $('thk-hide').onclick = function () { box.style.display = 'none'; };
  window.__taxHelperKream = { show: function () { box.style.display = ''; render(); } };

  // 상세 팝업이 열리면 알림창 없이 조용히 누적
  var last = 0;
  new MutationObserver(function () {
    if (running || Date.now() - last < 400) return;
    last = Date.now();
    if (modalOpen()) { var r = capture(); if (r === 'added') setStatus('누적했습니다. 계속 열어보세요.'); }
  }).observe(document.body, { childList: true, subtree: true });

  render();
  if (loadBuf().length) setStatus('이전 누적분이 있습니다. [CSV 저장]으로 내려받으세요.');
})();
