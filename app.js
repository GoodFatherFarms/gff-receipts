/* GFF Receipts PWA (v8). Talks to the Apps Script backend with fetch:
   POST, Content-Type text/plain (no CORS preflight), redirect: follow (Apps Script answers 302 -> googleusercontent).
   Offline: the app shell is cached by sw.js; unsent entries wait in IndexedDB and go up when there's signal. */
'use strict';
(function () {
  var CFG = window.GFF_CONFIG || {};
  var IS_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // A different backend can only be picked on a local test server, so a link can never point the real app elsewhere.
  var API = (IS_LOCAL && new URLSearchParams(location.search).get('api')) || (IS_LOCAL && localStorage.getItem('gff_api')) || CFG.API_URL;
  if (IS_LOCAL && new URLSearchParams(location.search).get('api')) localStorage.setItem('gff_api', API);
  var VERSION = CFG.APP_VERSION || '8';
  var PAYS = ['Card', 'Cash', 'Check', 'Square', 'Other'];
  var NEW = '__new';

  var $ = function (id) { return document.getElementById(id); };
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('gff_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('gff_' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem('gff_' + k); } catch (e) {} }
  };
  var S = { token: LS.get('token', ''), user: LS.get('user', null), boot: LS.get('boot', null), online: navigator.onLine, pending: 0 };

  // ---------- small helpers ----------
  function pad(n) { return ('0' + n).slice(-2); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function newRid() {
    var d = new Date();
    return 'GFF-' + String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + (Math.random().toString(36).slice(2, 6) + '0000').slice(0, 4);
  }
  function money(x) { var n = Number(x) || 0; return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function num(v) { var s = String(v == null ? '' : v).replace(/[$,\s]/g, ''); return s === '' ? NaN : Number(s); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function isOwner() { return !!(S.user && S.user.role === 'owner'); }
  var toastT;
  function toast(t, err) {
    var e = $('toast'); e.textContent = t; e.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastT); toastT = setTimeout(function () { e.className = ''; }, err ? 6000 : 3200);
  }

  // Bottom-sheet dialog instead of prompt()/confirm() (those behave badly in installed iPhone apps).
  // fields: [{id, label, type, inputmode, placeholder, value, options:[[value,label]]}] -> resolves {id: value} or null
  function ask(text, fields, okText, cancelText) {
    return new Promise(function (resolve) {
      $('m-text').textContent = text;
      var box = $('m-fields'); box.innerHTML = '';
      (fields || []).forEach(function (f) {
        var l = el('label', 'f', f.label); l.htmlFor = 'mf-' + f.id; box.appendChild(l);
        var i;
        if (f.options) { i = el('select'); f.options.forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; i.appendChild(op); }); }
        else { i = el('input'); i.type = f.type || 'text'; if (f.inputmode) i.inputMode = f.inputmode; if (f.maxlength) i.maxLength = f.maxlength; i.autocomplete = 'off'; }
        i.id = 'mf-' + f.id; if (f.placeholder) i.placeholder = f.placeholder; if (f.value != null) i.value = f.value;
        box.appendChild(i);
      });
      $('m-ok').textContent = okText || 'OK';
      $('m-cancel').textContent = cancelText || 'Cancel';
      $('m-cancel').classList.toggle('hide', cancelText === false);
      $('modal').classList.remove('hide');
      var first = box.querySelector('input,select'); if (first) setTimeout(function () { first.focus(); }, 50);
      function done(v) { $('modal').classList.add('hide'); $('m-ok').onclick = $('m-cancel').onclick = null; resolve(v); }
      $('m-ok').onclick = function () { var out = {}; (fields || []).forEach(function (f) { out[f.id] = $('mf-' + f.id).value.trim(); }); done(out); };
      $('m-cancel').onclick = function () { done(null); };
    });
  }
  function confirmBox(text, okText) { return ask(text, [], okText || 'Yes').then(function (v) { return !!v; }); }

  // ---------- backend ----------
  // Calls that work without a sign-in: an 'auth' error from these is about the PIN or reset link, not a lost session.
  var NO_TOKEN = { login: 1, requestPinReset: 1, checkReset: 1, resetWithToken: 1 };
  function api(action, data, opts) {
    opts = opts || {};
    var body = JSON.stringify(Object.assign({ action: action, token: S.token }, data || {}));
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, opts.timeout || 30000);
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body,
                        redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        if (!res.ok) { var e1 = new Error('Server error ' + res.status); e1.code = 'net'; throw e1; }
        return res.json().catch(function () { var e2 = new Error('Bad reply from the server.'); e2.code = 'net'; throw e2; });
      }, function () { var e = new Error(navigator.onLine ? 'Could not reach the server.' : 'No signal.'); e.code = 'net'; setNet(false); throw e; })
      .then(function (j) {
        clearTimeout(timer); setNet(true);
        if (!j.ok) { var e = new Error(j.error || 'Something went wrong.'); e.code = j.code || 'bad'; if (e.code === 'auth' && !NO_TOKEN[action]) authLost(e.message); throw e; }
        return j;
      }, function (e) { clearTimeout(timer); throw e; });
  }

  // ---------- offline queue (IndexedDB, localStorage fallback) ----------
  var Q = (function () {
    var dbp = null;
    function db() {
      if (!dbp) dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) return rej(new Error('no idb'));
        var r = indexedDB.open('gff-receipts', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('queue', { keyPath: 'rid' }); };
        r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    function tx(mode, fn) {
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction('queue', mode), req = fn(t.objectStore('queue'));
          t.oncomplete = function () { res(req && req.result); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); };
        });
      });
    }
    var lsAll = function () { return LS.get('queue', []); };
    return {
      put: function (it) { return tx('readwrite', function (s) { return s.put(it); }).catch(function () { var q = lsAll().filter(function (x) { return x.rid !== it.rid; }); q.push(it); if (!LS.set('queue', q)) throw new Error('Phone storage full.'); }); },
      del: function (rid) { return tx('readwrite', function (s) { return s.delete(rid); }).catch(function () { LS.set('queue', lsAll().filter(function (x) { return x.rid !== rid; })); }); },
      all: function () { return tx('readonly', function (s) { return s.getAll(); }).then(function (a) { return a || []; }).catch(function () { return lsAll(); }); }
    };
  })();

  // ---------- sign-in ----------
  // Password managers: the sign-in is a real <form> (username + current-password). After the backend says the PIN
  // is right, the browser is told about it:
  //  - Chrome/Android (Credential Management API): navigator.credentials.store(PasswordCredential).
  //  - Safari/iOS (iCloud Keychain) and others: WebKit only offers "Save password" after a real form submission
  //    that navigates, so the form is allowed to submit to ./signed-in. The service worker answers that POST
  //    from its cache, so the PIN never goes to GitHub or anywhere else, and the app reopens signed in.
  //  - No service worker yet (very first open): the page stays put (history.replaceState), the form is hidden.
  var HAS_PC = !!(window.PasswordCredential && navigator.credentials && navigator.credentials.store);
  var nativeSubmit = false;
  function device() { return (navigator.userAgent.match(/\(([^)]+)\)/) || [])[1] || ''; }
  function showLogin(msg) {
    $('splash').classList.add('hide'); $('app').classList.add('hide'); $('reset').classList.add('hide'); $('login').classList.remove('hide'); $('toast').className = '';
    $('l-name').value = LS.get('lastName', ''); $('l-pin').value = '';
    $('l-remember').checked = !!LS.get('remember', false);
    $('l-msg').textContent = msg || 'Ask Jonah for your PIN.';
    setTimeout(function () { ($('l-name').value ? $('l-pin') : $('l-name')).focus(); }, 60);
  }
  function authLost(msg) {
    S.token = ''; LS.del('token');
    showLogin((msg || 'Please sign in again.') + ' Anything waiting to send is still on this phone.');
  }
  function signedIn(r, name) {
    S.token = r.token; S.user = r.user; LS.set('token', r.token); LS.set('user', r.user); LS.set('lastName', name);
    LS.set('sessExp', r.expires || 0); LS.set('sessTrusted', !!r.trusted);
    if (S.boot && S.boot.user && S.boot.user.uid !== r.user.uid) { S.boot = null; LS.del('boot'); LS.del('custs'); }
  }
  // Tells the phone's password manager the sign-in worked. form = the <form>, id/pw = what was typed.
  function offerSave(form, id, pw) {
    if (HAS_PC) {
      try {
        var c = new window.PasswordCredential({ id: id, password: pw, name: id });
        return navigator.credentials.store(c).catch(function () {}).then(function () { return false; });
      } catch (e) { /* fall through */ }
    }
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      nativeSubmit = true;
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
      return Promise.resolve(true);   // the page is navigating
    }
    try { history.replaceState({ signedIn: Date.now() }, '', location.pathname + location.search); } catch (e) {}
    return Promise.resolve(false);
  }
  function doLogin(e) {
    if (nativeSubmit) return;   // second pass: let the browser really submit (see offerSave)
    if (e) e.preventDefault();
    var name = $('l-name').value.trim(), pin = $('l-pin').value.trim(), remember = $('l-remember').checked;
    if (!name || !/^\d{4,6}$/.test(pin)) { $('l-msg').textContent = 'Type your name and your 4 to 6 digit PIN.'; return; }
    $('l-go').disabled = true; $('l-go').textContent = 'Signing in…';
    LS.set('remember', remember);
    api('login', { name: name, pin: pin, remember: remember, device: device() }).then(function (r) {
      signedIn(r, name);
      $('l-name').value = name;   // the password manager reads the typed values from the form
      return offerSave($('l-form'), name, pin).then(function (navigating) {
        if (navigating) return;
        $('login').classList.add('hide'); $('l-pin').value = ''; start();
      });
    }).catch(function (e2) {
      $('l-pin').value = '';
      $('l-msg').textContent = e2.code === 'net' ? 'No connection. Signing in needs signal the first time.' : e2.message;
    }).then(function () { $('l-go').disabled = false; $('l-go').textContent = 'Sign in'; });
  }
  $('l-form').addEventListener('submit', doLogin);
  // Chrome/Android: offer a saved PIN on the sign-in screen (never signs in silently after "Sign out").
  function tryStoredCredential() {
    if (!HAS_PC || !navigator.credentials.get) return;
    navigator.credentials.get({ password: true, mediation: 'optional' }).then(function (c) {
      if (!c || c.type !== 'password' || !c.password || S.token) return;
      $('l-name').value = c.id; $('l-pin').value = c.password;
    }).catch(function () {});
  }

  // ---------- forgot PIN (owner) ----------
  $('l-forgot').onclick = function () {
    ask('Forgot your PIN? The owner gets a reset link by email (it works once, for 30 minutes). Employees: ask Jonah for a new PIN.',
        [{ id: 'name', label: 'Your name', value: $('l-name').value.trim() }], 'Send reset link').then(function (v) {
      if (!v || !v.name) return;
      $('l-msg').textContent = 'Sending…';
      api('requestPinReset', { name: v.name, device: device() }).then(function (r) { $('l-msg').textContent = r.message; })
        .catch(function (e) { $('l-msg').textContent = e.code === 'net' ? 'No connection. Try again with signal.' : e.message; });
    });
  };
  var resetToken = '';
  function showReset(tok) {
    resetToken = tok;
    $('splash').classList.add('hide'); $('app').classList.add('hide'); $('login').classList.add('hide'); $('reset').classList.remove('hide');
    $('r-form').classList.add('hide'); $('r-msg').textContent = 'Checking the link…';
    api('checkReset', { resetToken: tok }).then(function (r) {
      $('r-name').value = r.name; $('r-form').classList.remove('hide');
      $('r-msg').textContent = 'Setting a new PIN signs out every phone. Then sign in again with the new PIN.';
      setTimeout(function () { $('r-pin').focus(); }, 60);
    }).catch(function (e) {
      $('r-msg').textContent = e.code === 'net' ? 'No connection. Open the link again with signal.' : e.message;
    });
  }
  function doReset(e) {
    if (nativeSubmit) return;
    if (e) e.preventDefault();
    var p1 = $('r-pin').value.trim(), p2 = $('r-pin2').value.trim(), name = $('r-name').value;
    if (!/^\d{4,6}$/.test(p1)) { $('r-msg').textContent = 'The PIN must be 4 to 6 digits.'; return; }
    if (p1 !== p2) { $('r-msg').textContent = 'The two PINs don’t match.'; return; }
    $('r-go').disabled = true; $('r-go').textContent = 'Saving…';
    api('resetWithToken', { resetToken: resetToken, newPin: p1 }).then(function () {
      resetToken = '';
      S.token = ''; LS.del('token'); LS.set('lastName', name);
      LS.set('afterReset', name);
      return offerSave($('r-form'), name, p1).then(function (navigating) {
        if (navigating) return;
        afterReset();
      });
    }).catch(function (e2) {
      $('r-msg').textContent = e2.code === 'net' ? 'No connection. Try again with signal.' : e2.message;
    }).then(function () { $('r-go').disabled = false; $('r-go').textContent = 'Set new PIN'; });
  }
  function afterReset() {
    var name = LS.get('afterReset', ''); LS.del('afterReset');
    showLogin('New PIN saved for ' + name + '. Every phone was signed out. Sign in with the new PIN. ' +
      'If you use the GFF Receipts icon on your home screen, open it and sign in there too.');
  }
  $('r-form').addEventListener('submit', doReset);
  $('r-back').onclick = function () { resetToken = ''; showLogin(); };

  // ---------- tabs ----------
  function show(tab) {
    document.querySelectorAll('nav#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + tab); });
    window.scrollTo(0, 0);
    if (tab === 'ok') loadApprovals();
    if (tab === 'set') loadSettings();
    if (tab === 'home') loadSummary();
  }
  document.querySelectorAll('nav#tabs button').forEach(function (b) { b.onclick = function () { show(b.dataset.tab); }; });
  document.querySelectorAll('[data-go]').forEach(function (b) { b.onclick = function () { show(b.dataset.go); }; });
  $('gear').onclick = function () { show('set'); };
  $('pendBanner').onclick = function () { show('ok'); };

  // ---------- segmented buttons ----------
  function seg(boxId, options, remembered, onChange) {
    var box = $(boxId), val = remembered && options.indexOf(remembered) > -1 ? remembered : options[0];
    box.innerHTML = '';
    options.forEach(function (o) {
      var b = el('button', o === val ? 'on' : '', o); b.type = 'button';
      b.onclick = function () { val = o; box.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); }); if (onChange) onChange(o); };
      box.appendChild(b);
    });
    return { get: function () { return val; } };
  }
  var pay = seg('e-pay', PAYS, LS.get('pay', 'Card'), function (v) { LS.set('pay', v); });
  var chan;
  function chanChanged(v) { $('chkRow').classList.toggle('hide', v !== 'Check'); }

  // ---------- boot data (categories, vendors, presets...) ----------
  var CATS = [], VENDORS = [], VCATS = {}, CUSTS = [], PRESETS = [];
  function applyBoot(b) {
    S.boot = b;
    CATS = (b.categories || []).slice();
    document.querySelectorAll('select.catsel').forEach(function (s) { fillCat(s, s.value); });
    VENDORS = (b.vendors || []).slice();
    LS.get('vendors', []).forEach(function (v) { if (VENDORS.map(lc).indexOf(lc(v)) < 0) VENDORS.unshift(v); });
    ['Tractor Supply', 'Townline Poultry Farm', 'Runnings', 'Speedway', 'Meijer', 'Jacklin Steel Supply'].forEach(function (v) { if (VENDORS.indexOf(v) < 0) VENDORS.push(v); });
    fillList('vendors', VENDORS.slice(0, 80));
    VCATS = Object.assign({}, b.vendorCats || {}, LS.get('vcats', {}));
    var seen = {}, ft = [];
    LS.get('feedTypes', []).concat(b.feedTypes || []).forEach(function (t) { if (!seen[lc(t)]) { seen[lc(t)] = 1; ft.push(t); } });
    fillList('feedTypes', ft);
    CUSTS = (b.customers || []).slice();
    LS.get('custs', []).forEach(function (c) { if (CUSTS.indexOf(c) < 0) CUSTS.unshift(c); });
    fillList('custs', CUSTS.slice(0, 300));
    chan = seg('i-ch', b.channels || ['Cash', 'Check', 'Square', 'Venmo', 'Other'], LS.get('chan', 'Cash'), function (v) { LS.set('chan', v); chanChanged(v); });
    chanChanged(chan.get());
    buildTags(b.taxTags || Object.keys(TAG_HELP));
    PRESETS = b.presets || [];
    buildPresets();
    milesEst();
    var owner = isOwner();
    $('tab-ok').classList.toggle('hide', !owner);
    $('ownerCards').classList.toggle('hide', !owner);
    $('empHello').classList.toggle('hide', owner);
    $('teamBox').classList.toggle('hide', !owner);
    $('recentTitle').textContent = owner ? 'Recent (everyone)' : 'Your recent entries';
    $('who').textContent = S.user ? S.user.name + (owner ? ' · owner' : '') : '';
  }
  function lc(s) { return String(s || '').toLowerCase(); }
  function fillList(id, arr) { var dl = $(id); dl.innerHTML = ''; arr.forEach(function (v) { var o = el('option'); o.value = v; dl.appendChild(o); }); }
  function loadBoot() {
    return api('boot').then(function (b) { LS.set('boot', b); applyBoot(b); return b; });
  }

  // ---------- categories ----------
  function fillCat(sel, chosen) {
    sel.innerHTML = '';
    CATS.forEach(function (c) { var o = el('option', null, c); o.value = c; sel.appendChild(o); });
    var n = el('option', null, S.boot && S.boot.canAddCategories ? '➕ Add new category…' : '➕ Something else (Jonah will file it)…'); n.value = NEW; sel.appendChild(n);
    if (chosen && CATS.indexOf(chosen) > -1) sel.value = chosen;
    sel.dataset.prev = sel.value;
    sel.onchange = function () {
      if (sel.value !== NEW) { sel.dataset.prev = sel.value; sel.dataset.touched = '1'; updateFeed(); return; }
      ask(S.boot && S.boot.canAddCategories ? 'New category (saved for next time):' : 'What kind of expense is it? It is filed under "other" with your note until Jonah sorts it.',
          [{ id: 'name', label: 'Category', placeholder: 'e.g. fencing' }], 'Use it').then(function (v) {
        var name = v && v.name;
        if (!name) { sel.value = sel.dataset.prev; return; }
        var hit = CATS.filter(function (c) { return lc(c) === lc(name); })[0];
        if (!hit) { var at = CATS.indexOf('other'); CATS.splice(at < 0 ? CATS.length : at, 0, name); hit = name; }
        document.querySelectorAll('select.catsel').forEach(function (s) { var keep = s === sel ? hit : s.value; fillCat(s, keep === NEW ? s.dataset.prev : keep); });
        sel.dataset.touched = '1'; updateFeed();
      });
    };
  }
  fillCat($('e-cat'));

  $('e-vendor').addEventListener('change', function () {
    var c = VCATS[lc(this.value.trim())];
    if (c && CATS.indexOf(c) > -1 && !$('e-cat').dataset.touched) { $('e-cat').value = c; $('e-cat').dataset.prev = c; updateFeed(); }
  });
  ['e-amount', 'e-vendor', 'e-date'].forEach(function (id) { $(id).addEventListener('input', function () { this.classList.remove('auto'); this.dataset.auto = ''; }); });

  // ---------- photos ----------
  var rid = newRid();
  var photos = [];   // {key, thumb, b64, driveId, status, promise}
  function compress(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1600, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        var q = 0.72, data = c.toDataURL('image/jpeg', q);
        while (data.length > 1100000 && q > 0.4) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
        URL.revokeObjectURL(url); res(data);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Could not read that photo.')); };
      img.src = url;
    });
  }
  function onFiles(list) {
    if (!list || !list.length) return;
    show('exp');
    Array.prototype.forEach.call(list, function (f) {
      if (photos.length >= 10) return toast('Up to 10 photos per receipt.', true);
      compress(f).then(function (data) {
        var p = { key: Math.random().toString(36).slice(2), thumb: data, b64: data.split(',')[1], status: 'Uploading…' };
        photos.push(p); renderThumbs(); upload(p, photos.length - 1);
      }).catch(function (e) { toast(e.message, true); });
    });
  }
  $('cam').onchange = function () { onFiles(this.files); this.value = ''; };
  $('lib').onchange = function () { onFiles(this.files); this.value = ''; };
  function upload(p, index) {
    if (!S.online && !navigator.onLine) { p.status = 'Kept on phone'; renderThumbs(); ocrMsg('no', 'No signal: fill it in by hand. The photo is kept and goes up when you save.'); return; }
    ocrMsg('wait', '🔎 Reading the receipt…');
    p.promise = api('ocr', { base64: p.b64, type: 'image/jpeg', rid: rid, index: index }, { timeout: 60000 }).then(function (r) {
      p.driveId = r.id; p.status = '✓ Saved'; renderThumbs();
      if (r.ocr && (r.ocr.amount != null || r.ocr.vendor || r.ocr.date)) applyOcr(r.ocr);
      else ocrMsg('no', 'Couldn’t read this photo. Type the amount and store below.');
    }).catch(function () {
      p.status = 'Kept on phone'; renderThumbs();
      ocrMsg('no', 'Couldn’t read the photo right now. Fill it in by hand. The photo is kept and goes up when you save.');
    });
  }
  function renderThumbs() {
    var box = $('thumbs'); box.innerHTML = '';
    photos.forEach(function (p) {
      var t = el('div', 'th'), im = el('img'); im.src = p.thumb; im.alt = 'Receipt photo'; t.appendChild(im);
      var x = el('button', 'x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove photo'); x.onclick = function () { removePhoto(p); }; t.appendChild(x);
      t.appendChild(el('div', 'st', p.status)); box.appendChild(t);
    });
    $('photoBtns').classList.toggle('hide', !photos.length);
  }
  function removePhoto(p) {
    photos = photos.filter(function (x) { return x !== p; }); renderThumbs();
    (p.promise || Promise.resolve()).then(function () { if (p.driveId) api('trashPhoto', { id: p.driveId }).catch(function () {}); });
  }
  $('retake').onclick = function () { if (photos.length) removePhoto(photos[photos.length - 1]); $('cam').click(); };
  function ocrMsg(cls, t) { var o = $('ocr'); o.className = cls; o.textContent = t; }
  function setAuto(id, v) {
    var f = $(id);
    if (v == null || v === '') return false;
    if (f.value && !f.dataset.auto) return false;   // never overwrite what was typed
    f.value = v; f.dataset.auto = '1'; f.classList.add('auto'); return true;
  }
  function applyOcr(o) {
    var got = [];
    if (o.amount != null && setAuto('e-amount', Number(o.amount).toFixed(2))) got.push(money(o.amount));
    if (o.vendor && setAuto('e-vendor', o.vendor)) { got.push(o.vendor); $('e-vendor').dispatchEvent(new Event('change')); }
    if (o.date && setAuto('e-date', o.date)) got.push(o.date);
    ocrMsg(got.length ? 'ok' : 'no', got.length ? '✏️ Read from photo: ' + got.join(' · ') + '. Yellow boxes are guesses, so check them.' : 'Photo saved. Couldn’t read new details from it.');
    updateLeft();
  }

  // ---------- splits ----------
  $('e-split').onchange = function () {
    var on = this.checked;
    $('splitBox').classList.toggle('hide', !on); $('catOne').classList.toggle('hide', on);
    if (on && !$('splits').children.length) { addSplit($('e-cat').value); addSplit(); }
    updateLeft();
  };
  function addSplit(cat) {
    if ($('splits').children.length >= 6) { toast('Up to 6 categories per receipt.', true); return; }
    var r = el('div', 'split'), s = el('select', 'catsel'), a = el('input'), x = el('button', 'x', '×');
    fillCat(s, cat && cat !== NEW ? cat : undefined);
    a.inputMode = 'decimal'; a.placeholder = '$'; a.oninput = updateLeft;
    x.type = 'button'; x.onclick = function () { r.remove(); updateLeft(); };
    r.appendChild(s); r.appendChild(a); r.appendChild(x); $('splits').appendChild(r); updateLeft();
  }
  $('addSplit').onclick = function () { addSplit(); };
  function splitRows() { return Array.prototype.map.call($('splits').children, function (r) { return { category: r.querySelector('select').value, amount: r.querySelector('input').value, input: r.querySelector('input') }; }); }
  function updateLeft() {
    var L = $('left');
    if (!$('e-split').checked) { L.textContent = ''; updateFeed(); return; }
    var total = num($('e-amount').value), used = 0, rows = splitRows();
    rows.forEach(function (r) { var a = num(r.amount); if (!isNaN(a)) used += a; });
    var left = isNaN(total) ? NaN : Math.round((total - used) * 100) / 100;
    rows.forEach(function (r) { r.input.placeholder = (!isNaN(left) && left > 0 && !r.amount) ? left.toFixed(2) : '$'; });
    if (isNaN(left)) { L.textContent = 'Enter the total first.'; L.className = ''; }
    else if (Math.abs(left) < 0.005) { L.textContent = '✓ Splits add up to ' + money(total); L.className = 'good'; }
    else { L.textContent = (left > 0 ? 'Left to assign: ' : 'Over by: ') + money(Math.abs(left)); L.className = 'bad'; }
    updateFeed();
  }
  $('e-amount').addEventListener('input', updateLeft);

  // ---------- feed pounds ----------
  var feedMode = seg('f-mode', ['Pounds', 'Bags'], LS.get('feedMode', 'Pounds'), function (m) { LS.set('feedMode', m); feedModeUi(); updateFeed(); });
  function feedModeUi() { var bags = feedMode.get() === 'Bags'; $('f-bagRow').classList.toggle('hide', !bags); $('f-lbsRow').classList.toggle('hide', bags); }
  feedModeUi();
  function isFeed(c) { return /^feed$/i.test(String(c || '')); }
  function feedDollars() {
    if (!$('e-split').checked) return isFeed($('e-cat').value) ? num($('e-amount').value) : NaN;
    var t = 0, any = false;
    splitRows().forEach(function (r) { if (isFeed(r.category)) { any = true; var a = num(r.amount); if (!isNaN(a)) t += a; } });
    return any ? t : NaN;
  }
  function feedShown() { return $('e-split').checked ? splitRows().some(function (r) { return isFeed(r.category); }) : isFeed($('e-cat').value); }
  function feedLbs() {
    if (feedMode.get() === 'Bags') { var b = num($('f-bags').value), per = num($('f-per').value); return (b > 0 && per > 0) ? b * per : NaN; }
    var l = num($('f-lbs').value); return l > 0 ? l : NaN;
  }
  function perLb(x) { var s = x.toFixed(3); return '$' + (s.slice(-1) === '0' ? s.slice(0, -1) : s) + '/lb'; }
  function updateFeed() {
    var on = feedShown(); $('feedBox').classList.toggle('hide', !on);
    if (!on) return;
    var lbs = feedLbs(), dollars = feedDollars();
    $('f-cpl').textContent = (lbs > 0 && dollars > 0) ? Math.round(lbs).toLocaleString() + ' lb · ' + perLb(dollars / lbs) : (lbs > 0 ? Math.round(lbs).toLocaleString() + ' lb' : '');
  }
  ['f-lbs', 'f-bags', 'f-per'].forEach(function (id) { $(id).addEventListener('input', updateFeed); });
  $('f-per').addEventListener('change', function () { var v = num(this.value); if (v > 0) LS.set('lbPerBag', v); });
  document.addEventListener('change', function (e) { if (e.target.classList && e.target.classList.contains('catsel')) updateFeed(); });

  // ---------- tax tags ----------
  var TAG_HELP = {
    'Equipment': 'Equipment: over $2,500 or lasts a year or more. It may need to be depreciated, not expensed. Keep the receipt.',
    'Personal money': 'Personal money: paid from your own account, not the farm\'s.',
    'Reimbursable': 'Reimbursable: someone owes this back (a customer, partner, or the farm owes you).',
    'Mixed personal/farm': 'Mixed: part farm, part personal. Add the farm % in Notes.'
  };
  var tagsOn = {};
  function buildTags(list) {
    var box = $('e-tags'); box.innerHTML = ''; tagsOn = {};
    list.forEach(function (t) {
      var b = el('button', '', t); b.type = 'button';
      b.onclick = function () { tagsOn[t] = !tagsOn[t]; b.classList.toggle('on', !!tagsOn[t]); tagHint(); };
      box.appendChild(b);
    });
    tagHint();
  }
  function tagHint() { $('tagHint').textContent = selectedTags().map(function (t) { return TAG_HELP[t] || t; }).join(' '); }
  function selectedTags() { return Object.keys(tagsOn).filter(function (t) { return tagsOn[t]; }); }

  // ---------- reset forms ----------
  function resetExpense() {
    ['e-amount', 'e-vendor', 'e-notes'].forEach(function (id) { $(id).value = ''; $(id).dataset.auto = ''; $(id).classList.remove('auto'); });
    $('e-date').value = today(); $('e-date').dataset.auto = '1'; $('e-date').classList.remove('auto');
    $('e-cat').dataset.touched = ''; $('e-split').checked = false; $('splits').innerHTML = '';
    $('splitBox').classList.add('hide'); $('catOne').classList.remove('hide'); $('left').textContent = '';
    photos = []; renderThumbs(); $('ocr').className = ''; rid = newRid();
    ['f-lbs', 'f-bags', 'f-type'].forEach(function (id) { $(id).value = ''; });
    $('f-per').value = LS.get('lbPerBag', 50);
    tagsOn = {}; document.querySelectorAll('#e-tags button').forEach(function (b) { b.classList.remove('on'); }); tagHint();
    updateFeed();
  }
  function resetIncome() { ['i-amount', 'i-cust', 'i-birds', 'i-prod', 'i-notes', 'i-chk', 'pk-cust'].forEach(function (id) { $(id).value = ''; }); $('i-date').value = today(); pkClear(); }
  function resetMiles() { ['m-purpose', 'm-to', 'm-miles', 'm-notes'].forEach(function (id) { $(id).value = ''; }); $('m-rt').checked = false; $('m-from').value = LS.get('from', ''); $('m-date').value = today(); milesEst(); }

  // ---------- expense save ----------
  function saveExpense() {
    var amount = num($('e-amount').value), vendor = $('e-vendor').value.trim();
    if (isNaN(amount) || amount < 0) return toast('Type the total amount.', true);
    if (!vendor) return toast('Type the vendor / store.', true);
    var d = { type: 'expense', rid: rid, date: $('e-date').value || today(), vendor: vendor, amount: amount.toFixed(2),
              payment: pay.get(), notes: $('e-notes').value.trim(), project: 'General' };
    if ($('e-split').checked) {
      var rows = splitRows(), sum = 0, bad = false;
      rows.forEach(function (r) { var a = num(r.amount); if (isNaN(a)) bad = true; else sum += a; });
      if (rows.length < 2) return toast('Add at least 2 categories, or turn off Split.', true);
      if (bad) return toast('Every split needs an amount.', true);
      if (Math.abs(sum - amount) > 0.005) return toast('Splits add up to ' + money(sum) + ', not ' + money(amount) + '.', true);
      if (rows.some(function (r) { return r.category === NEW; })) return toast('Pick a category on every split.', true);
      d.splits = rows.map(function (r) { return { category: r.category, amount: num(r.amount).toFixed(2) }; });
    } else {
      if ($('e-cat').value === NEW) return toast('Pick a category.', true);
      d.category = $('e-cat').value;
    }
    var lbs = feedShown() ? feedLbs() : NaN;
    if (lbs > 0) d.feedLbs = Math.round(lbs * 100) / 100;
    var ft = feedShown() ? $('f-type').value.trim() : '';
    if (ft) { d.feedType = ft; var fl = LS.get('feedTypes', []).filter(function (x) { return lc(x) !== lc(ft); }); fl.unshift(ft); LS.set('feedTypes', fl.slice(0, 20)); }
    d.taxTags = selectedTags();
    var btn = $('e-save'); btn.disabled = true; btn.textContent = 'Checking…';
    // Duplicate warning: same vendor + amount within 7 days. With no signal it is skipped (the id still stops double-saves).
    var check = Promise.race([
      api('checkDuplicate', { vendor: d.vendor, amount: d.amount, date: d.date, rid: d.rid }, { timeout: 6000 }).then(function (r) { return r.matches || []; }).catch(function () { return []; }),
      new Promise(function (res) { setTimeout(function () { res([]); }, 6500); })
    ]);
    check.then(function (m) {
      if (!m.length) return true;
      return confirmBox('Looks like this was already logged on ' + m[0].date + ' (' + money(m[0].amount) + ' at ' + d.vendor + (m[0].status && m[0].status !== 'Approved' ? ', ' + m[0].status : '') + '). Save anyway?', 'Save anyway');
    }).then(function (go) {
      if (!go) { btn.disabled = false; btn.textContent = 'Save expense'; return; }
      btn.textContent = photos.some(function (p) { return !p.driveId; }) ? 'Uploading photo…' : 'Saving…';
      var mine = photos.slice();
      return Promise.all(mine.map(function (p) { return (p.promise || Promise.resolve()).catch(function () {}); })).then(function () {
        d.photoIds = mine.filter(function (p) { return p.driveId; }).map(function (p) { return p.driveId; });
        d.photos = mine.filter(function (p) { return !p.driveId; }).map(function (p) { return { base64: p.b64, type: 'image/jpeg' }; });
        rememberVendor(vendor, d.category || (d.splits && d.splits[0].category));
        submit(d, money(amount) + ' at ' + vendor);
        resetExpense(); btn.disabled = false; btn.textContent = 'Save expense';
      });
    });
  }
  function rememberVendor(v, c) {
    var list = LS.get('vendors', []).filter(function (x) { return lc(x) !== lc(v); }); list.unshift(v); LS.set('vendors', list.slice(0, 40));
    if (VENDORS.map(lc).indexOf(lc(v)) < 0) { VENDORS.unshift(v); fillList('vendors', VENDORS.slice(0, 80)); }
    if (c && c !== NEW) { VCATS[lc(v)] = c; var vc = LS.get('vcats', {}); vc[lc(v)] = c; LS.set('vcats', vc); }
  }

  // ---------- income ----------
  function saveIncome() {
    if ($('pk-on').checked) return savePickup();
    var amount = num($('i-amount').value);
    if (isNaN(amount) || amount < 0) return toast('Type the amount received.', true);
    var b = $('i-birds').value.trim();
    if (b && isNaN(Number(b))) return toast('Birds should be a number.', true);
    var d = { type: 'income', rid: newRid(), date: $('i-date').value || today(), customer: $('i-cust').value.trim(), amount: amount.toFixed(2),
              channel: chan.get(), birds: b, product: $('i-prod').value.trim(), notes: $('i-notes').value.trim(),
              checkNo: chan.get() === 'Check' ? $('i-chk').value.trim() : '' };
    rememberCustomer(d.customer);
    submit(d, money(amount) + ' sale (' + d.channel + ')'); resetIncome();
  }

  // ---------- pickup day (quick sales). Prices come from the server (Code.gs PRESETS). ----------
  var DEPOSITS = [0, 5, 10, 15, 50];
  var ticket = [], deposit = 0;
  function buildPresets() {
    var box = $('pk-presets'); box.innerHTML = '';
    PRESETS.forEach(function (p) {
      var b = el('button'); b.type = 'button'; b.appendChild(document.createTextNode(p.label)); b.appendChild(el('small', null, money(p.price)));
      b.onclick = function () { ticket.push(p); pkRender(); };
      box.appendChild(b);
    });
    var o = el('button'); o.type = 'button'; o.appendChild(document.createTextNode('Other $')); o.appendChild(el('small', null, 'type amount'));
    o.onclick = function () {
      ask('Other item', [{ id: 'a', label: 'Amount ($)', inputmode: 'decimal', placeholder: '20.00' }, { id: 'n', label: 'What (optional)', placeholder: 'Eggs' }], 'Add').then(function (v) {
        var a = v && num(v.a); if (a > 0) { ticket.push({ label: 'Other', name: v.n || 'Other', price: a, birds: 0 }); pkRender(); }
      });
    };
    box.appendChild(o);
  }
  (function () {
    var box = $('pk-dep');
    DEPOSITS.forEach(function (v) {
      var b = el('button', v === 0 ? 'on' : '', v === 0 ? 'None' : '−' + money(v)); b.type = 'button';
      b.onclick = function () { deposit = v; box.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); }); pkRender(); };
      box.appendChild(b);
    });
  })();
  function pkDue() { var t = 0; ticket.forEach(function (p) { t += p.price; }); return Math.round((t - (ticket.length ? deposit : 0)) * 100) / 100; }
  function pkRender() {
    var box = $('pk-ticket'); box.innerHTML = '';
    ticket.forEach(function (p, i) {
      var r = el('div', 'tk'); r.appendChild(el('span', null, p.name)); r.appendChild(el('b', null, money(p.price)));
      var x = el('button', 'undo', '×'); x.type = 'button'; x.onclick = function () { ticket.splice(i, 1); pkRender(); }; r.appendChild(x);
      box.appendChild(r);
    });
    $('pk-due').textContent = 'Due: ' + money(Math.max(pkDue(), 0));
  }
  function pkClear() { ticket = []; deposit = 0; $('pk-dep').querySelectorAll('button').forEach(function (x, i) { x.classList.toggle('on', i === 0); }); pkRender(); }
  function pkDay() { var s = LS.get('pkday', null); if (!s || s.date !== today()) s = { date: today(), total: 0, n: 0, birds: 0, by: {} }; return s; }
  function pkDayRender() {
    var s = pkDay(); $('pk-date').textContent = s.date; $('pk-total').textContent = money(s.total);
    $('pk-break').textContent = s.n ? s.n + ' sale' + (s.n === 1 ? '' : 's') + ' · ' + s.birds + ' birds · ' + Object.keys(s.by).map(function (k) { return k + ' ' + money(s.by[k]); }).join(' · ') : 'No sales yet';
  }
  $('pk-reset').onclick = function () { confirmBox('Start a new pickup-day total? (The ledger is not changed.)', 'New day').then(function (ok) { if (ok) { LS.set('pkday', { date: today(), total: 0, n: 0, birds: 0, by: {} }); pkDayRender(); } }); };
  $('pk-on').onchange = function () {
    var on = this.checked; LS.set('pkOn', on);
    $('pk').classList.toggle('hide', !on); $('inc-normal').classList.toggle('hide', on); $('inc-normal2').classList.toggle('hide', on);
    $('i-save').textContent = on ? 'Save sale & next customer' : 'Save sale';
    pkDayRender();
  };
  function savePickup() {
    if (!ticket.length) return toast('Tap what they bought.', true);
    var due = pkDue();
    if (due < 0) return toast('Deposit is more than the order.', true);
    var counts = {}, birds = 0;
    ticket.forEach(function (p) { counts[p.name] = (counts[p.name] || 0) + 1; birds += p.birds; });
    var product = Object.keys(counts).map(function (k) { return counts[k] + '× ' + k; }).join('; ');
    var notes = $('i-notes').value.trim();
    if (deposit && ticket.length) notes = 'Deposit ' + money(deposit) + ' paid online' + (notes ? ' | ' + notes : '');
    var d = { type: 'income', rid: newRid(), date: $('i-date').value || today(), customer: $('pk-cust').value.trim(), amount: due.toFixed(2),
              channel: chan.get(), birds: birds || '', product: product, notes: notes, pickupDay: true,
              checkNo: chan.get() === 'Check' ? $('i-chk').value.trim() : '' };
    rememberCustomer(d.customer);
    var s = pkDay(); s.total = Math.round((s.total + due) * 100) / 100; s.n++; s.birds += birds; s.by[d.channel] = Math.round(((s.by[d.channel] || 0) + due) * 100) / 100; LS.set('pkday', s);
    submit(d, money(due) + ' ' + (d.customer || 'sale') + ' (' + d.channel + ')');
    resetIncome(); pkDayRender(); $('pk-cust').focus();
  }
  function rememberCustomer(c) {
    if (!c) return;
    var l = LS.get('custs', []).filter(function (x) { return lc(x) !== lc(c); }); l.unshift(c); LS.set('custs', l.slice(0, 200));
    if (CUSTS.map(lc).indexOf(lc(c)) < 0) { CUSTS.unshift(c); fillList('custs', CUSTS.slice(0, 300)); }
  }

  // ---------- miles ----------
  function milesEst() {
    var m = num($('m-miles').value); if ($('m-rt').checked) m = m * 2;
    var rate = Number(S.boot && S.boot.irsRate) || 0.76;
    $('m-est').textContent = isNaN(m) ? 'IRS rate: $' + rate.toFixed(3) + '/mi' : m + ' mi ≈ ' + money(m * rate) + ' deduction at $' + rate.toFixed(3) + '/mi';
  }
  $('m-miles').oninput = milesEst; $('m-rt').onchange = milesEst;
  function saveMiles() {
    var m = num($('m-miles').value);
    if (isNaN(m) || m <= 0) return toast('Type the miles.', true);
    if (!$('m-purpose').value.trim()) return toast('What was the trip for?', true);
    var d = { type: 'mileage', rid: newRid(), date: $('m-date').value || today(), purpose: $('m-purpose').value.trim(), from: $('m-from').value.trim(),
              to: $('m-to').value.trim(), miles: m, roundTrip: $('m-rt').checked, notes: $('m-notes').value.trim() };
    LS.set('from', d.from);
    submit(d, (d.roundTrip ? m * 2 : m) + ' mi trip'); resetMiles();
  }
  $('e-save').onclick = saveExpense; $('i-save').onclick = saveIncome; $('m-save').onclick = saveMiles;

  // ---------- send + offline queue ----------
  // Every entry carries its own id, so retrying never double-saves. Queue items remember who made them,
  // so if someone else signs in on this phone, they are never sent under the wrong name.
  function submit(d, label) {
    var item = { rid: d.rid, d: d, label: label, uid: S.user && S.user.uid, who: S.user && S.user.name, at: new Date().toLocaleString(), err: '' };
    toast('Saving ' + label + '…');
    api('save', d, { timeout: 90000 }).then(function (r) {
      toast(r.status === 'Pending' ? '✅ Sent ' + label + '. Waiting for Jonah to approve.' : '✅ Saved ' + label + '. Ready for the next one.');
      loadSummary();
    }).catch(function (e) {
      item.err = e.code === 'net' ? '' : e.message;
      Q.put(item).then(renderQueue, function () {
        d.photos = []; d.notes = (d.notes ? d.notes + ' | ' : '') + 'photo lost offline'; Q.put(item).then(renderQueue);
        toast('Phone storage full. Kept the entry but not the photo.', true);
      });
      if (e.code !== 'auth') toast('⚠️ Not sent yet (' + (e.code === 'net' ? 'no signal' : e.message) + '). It’s kept on this phone.', true);
    });
  }
  function renderQueue() {
    return Q.all().then(function (q) {
      var box = $('queue'); box.innerHTML = '';
      box.classList.toggle('hide', !q.length);
      if (!q.length) return;
      box.appendChild(el('b', null, '⚠️ ' + q.length + ' not sent yet. They’re kept on this phone.'));
      q.forEach(function (it) {
        var mine = S.user && it.uid === S.user.uid;
        var r = el('div', 'qi'); r.appendChild(el('span', null, it.label + ' · ' + it.at + (mine ? '' : ' · ' + (it.who || 'someone else') + ' must sign in to send it') + (it.err ? ' · ' + it.err : '')));
        var x = el('button', 'undo', 'Discard'); x.onclick = function () { confirmBox('Throw away “' + it.label + '”? It was never sent.', 'Throw away').then(function (ok) { if (ok) Q.del(it.rid).then(renderQueue); }); };
        r.appendChild(x); box.appendChild(r);
      });
      var b = el('button', 'big gold', '↻ Send now'); b.onclick = syncQueue; box.appendChild(b);
    });
  }
  var syncing = false;
  function syncQueue() {
    if (syncing || !S.token || !S.user) return Promise.resolve();
    syncing = true;
    var ok = 0;
    return Q.all().then(function (q) {
      var chain = Promise.resolve();
      q.filter(function (it) { return it.uid === S.user.uid; }).forEach(function (it) {
        chain = chain.then(function () {
          return api('save', it.d, { timeout: 90000 }).then(function () { ok++; return Q.del(it.rid); })
            .catch(function (e) { if (e.code === 'auth') throw e; it.err = e.code === 'net' ? '' : e.message; return Q.put(it); });
        });
      });
      return chain;
    }).catch(function () {}).then(function () {
      syncing = false; renderQueue();
      if (ok) { toast('✅ Sent ' + ok + ' waiting entr' + (ok === 1 ? 'y' : 'ies') + '.'); loadSummary(); }
    });
  }
  function setNet(on) {
    S.online = on;
    var n = $('net'); n.textContent = on ? 'Online' : 'No signal'; n.className = 'pill' + (on ? '' : ' off');
  }
  window.addEventListener('online', function () { setNet(true); syncQueue(); });
  window.addEventListener('offline', function () { setNet(false); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && S.token) { syncQueue(); loadSummary(); } });
  setInterval(function () { if (S.token && navigator.onLine) syncQueue(); }, 90000);

  // ---------- home summary + undo ----------
  function chip(status) { var c = el('span', 'st-chip st-' + status, status === 'Pending' ? 'Waiting' : status); return c; }
  function loadSummary() {
    if (!S.token) return;
    api('summary').then(function (s) {
      if (s.role === 'owner') {
        document.querySelectorAll('.mo').forEach(function (m) { m.textContent = s.month.split(' ')[0]; });
        $('s-spent').textContent = money(s.spent); $('s-inc').textContent = money(s.income);
        var net = s.income - s.spent; $('s-net').textContent = money(net); $('s-net').className = 'v ' + (net < 0 ? 'neg' : 'pos');
        $('s-mi').textContent = Math.round(s.miles) + ' mi';
        S.pending = s.pendingCount || 0;
        var pb = $('pendBanner'); pb.classList.toggle('hide', !S.pending);
        pb.textContent = '✅ ' + S.pending + ' employee entr' + (S.pending === 1 ? 'y' : 'ies') + ' waiting for you (' + money(s.pendingTotal) + '). Tap to review.';
        var bd = $('okBadge'); bd.textContent = S.pending; bd.classList.toggle('hide', !S.pending);
      }
      var box = $('recent'); box.innerHTML = '';
      if (!s.recent.length) box.appendChild(el('div', 'hint', 'Nothing logged from the app yet.'));
      s.recent.forEach(function (r) {
        var row = el('div', 'ent'), m = el('div', 'm');
        var icon = r.type === 'income' ? '💵 ' : r.type === 'mileage' ? '🚚 ' : '🧾 ';
        var l = el('div', 'l', icon + r.label); if (r.status && r.status !== 'Approved' || s.role !== 'owner') l.appendChild(chip(r.status)); m.appendChild(l);
        m.appendChild(el('div', 'd', r.date + ' · ' + r.detail + (r.count > 1 ? ' · split ' + r.count + ' ways' : '') + (r.by ? ' · ' + r.by : '')));
        row.appendChild(m);
        row.appendChild(el('div', 'a ' + (r.type === 'income' ? 'pos' : ''), (r.type === 'expense' ? '-' : r.type === 'income' ? '+' : '') + money(r.amount)));
        if (r.canUndo) {
          var u = el('button', 'undo', 'Undo'); u.onclick = function () {
            confirmBox('Delete “' + r.label + ' ' + money(r.amount) + '” from the ledger?', 'Delete').then(function (ok) {
              if (!ok) return;
              u.disabled = true; u.textContent = '…';
              api('undo', { rid: r.rid }).then(function () { toast('Deleted.'); loadSummary(); }).catch(function (e) { toast('Couldn’t delete: ' + e.message, true); u.disabled = false; u.textContent = 'Undo'; });
            });
          };
          row.appendChild(u);
        }
        box.appendChild(row);
      });
    }).catch(function (e) {
      if (e.code === 'auth') return;
      $('recent').innerHTML = ''; $('recent').appendChild(el('div', 'hint', 'Can’t load right now (no signal?). Saving still works offline.'));
    });
  }
  $('refresh').onclick = function () { loadSummary(); syncQueue(); };

  // ---------- approvals (owner) ----------
  var lastApprovals = [];
  function loadApprovals() {
    if (!isOwner()) return;
    var box = $('appr'); box.innerHTML = ''; box.appendChild(el('div', 'hint', 'Loading…'));
    api('approvals').then(function (r) {
      lastApprovals = r.items || [];
      box.innerHTML = '';
      $('apprAll').classList.toggle('hide', lastApprovals.length < 2);
      var bd = $('okBadge'); bd.textContent = lastApprovals.length; bd.classList.toggle('hide', !lastApprovals.length);
      if (!lastApprovals.length) { box.appendChild(el('div', 'hint', '🎉 Nothing waiting.')); return; }
      lastApprovals.forEach(function (it) {
        var c = el('div', 'ap'), top = el('div', 'top');
        var icon = it.type === 'income' ? '💵 ' : it.type === 'mileage' ? '🚚 ' : '🧾 ';
        top.appendChild(el('span', null, icon + it.label));
        top.appendChild(el('span', 'amt', it.type === 'mileage' ? it.detail + ' · ' + money(it.amount) : money(it.amount)));
        c.appendChild(top);
        c.appendChild(el('div', 'meta', it.date + ' · by ' + it.by + ' · sent ' + it.enteredAt + (it.payment ? ' · ' + it.payment : '')));
        if (it.type === 'expense') c.appendChild(el('div', 'lines', it.splits.map(function (s) { return s.category + ' ' + money(s.amount) + (s.qty ? ' (' + s.qty + ' ' + s.unit + ')' : ''); }).join(' · ')));
        if (it.type === 'income' && (it.product || it.birds)) c.appendChild(el('div', 'lines', [it.detail, it.product, it.birds ? it.birds + ' birds' : ''].filter(String).join(' · ')));
        if (it.notes) c.appendChild(el('div', 'meta', it.notes));
        if (it.tags) c.appendChild(el('div', 'meta', 'Tax tags: ' + it.tags));
        if (it.photos && it.photos.length) {
          var ph = el('div', 'photos');
          it.photos.forEach(function (u, i) { var a = el('a', null, '📷 Photo ' + (i + 1)); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; ph.appendChild(a); });
          c.appendChild(ph);
        } else if (it.type === 'expense') c.appendChild(el('div', 'meta', 'No photo.'));
        var row = el('div', 'row'), no = el('button', 'btn danger', 'Reject'), yes = el('button', 'btn ok', '✓ Approve');
        yes.onclick = function () { yes.disabled = no.disabled = true; api('approve', { rids: [it.rid] }).then(function () { toast('Approved.'); loadApprovals(); }).catch(function (e) { toast(e.message, true); yes.disabled = no.disabled = false; }); };
        no.onclick = function () {
          ask('Reject this entry? It stays in the sheet marked Rejected and never counts.', [{ id: 'why', label: 'Why (they will see the status)', placeholder: 'Personal, not farm' }], 'Reject').then(function (v) {
            if (!v) return; yes.disabled = no.disabled = true;
            api('reject', { rid: it.rid, reason: v.why }).then(function () { toast('Rejected.'); loadApprovals(); }).catch(function (e) { toast(e.message, true); yes.disabled = no.disabled = false; });
          });
        };
        row.appendChild(no); row.appendChild(yes); c.appendChild(row);
        box.appendChild(c);
      });
    }).catch(function (e) { box.innerHTML = ''; box.appendChild(el('div', 'hint', 'Can’t load approvals: ' + e.message)); });
  }
  $('apprAll').onclick = function () {
    var n = lastApprovals.length, total = lastApprovals.reduce(function (s, x) { return s + (x.type === 'mileage' ? 0 : x.amount); }, 0);
    confirmBox('Approve all ' + n + ' entries (' + money(total) + ')?', 'Approve all').then(function (ok) {
      if (!ok) return;
      api('approve', { rids: lastApprovals.map(function (x) { return x.rid; }) }).then(function (r) { toast('Approved ' + r.changed + '.'); loadApprovals(); }).catch(function (e) { toast(e.message, true); });
    });
  };

  // ---------- settings + team ----------
  function loadSettings() {
    $('set-who').textContent = S.user ? S.user.name + ' (' + S.user.role + ')' : '';
    $('set-ver').textContent = 'GFF Receipts ' + VERSION + (IS_LOCAL ? ' · LOCAL TEST → ' + API : '');
    loadDevices();
    if (isOwner()) loadTeam();
  }
  function day(ms) { var d = new Date(Number(ms) || 0); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  function loadDevices() {
    var box = $('devices'); box.innerHTML = '';
    var exp = LS.get('sessExp', 0);
    $('set-sess').textContent = exp ? 'This phone stays signed in until ' + day(exp) + (LS.get('sessTrusted', false) ? ' (kept signed in).' : '.') : '';
    api('listSessions').then(function (r) {
      r.sessions.forEach(function (sx) {
        var row = el('div', 'dev'), m = el('div', 'm');
        m.appendChild(el('div', 'n', (sx.current ? '📱 This phone' : '📱 ' + (sx.device || 'Another device'))));
        m.appendChild(el('div', 'd', 'Signed in ' + day(sx.at) + ' · until ' + day(sx.expires) + (sx.trusted ? ' · kept signed in' : '')));
        row.appendChild(m);
        if (sx.current) { LS.set('sessExp', sx.expires); LS.set('sessTrusted', !!sx.trusted); $('set-sess').textContent = 'This phone stays signed in until ' + day(sx.expires) + (sx.trusted ? ' (kept signed in).' : '.'); }
        else {
          var b = el('button', 'btn danger', 'Sign out');
          b.onclick = function () { b.disabled = true; api('revokeSessions', { sid: sx.sid }).then(function () { toast('Signed out that device.'); loadDevices(); }).catch(function (e) { b.disabled = false; toast(e.message, true); }); };
          row.appendChild(b);
        }
        box.appendChild(row);
      });
    }).catch(function (e) { if (e.code !== 'auth') box.appendChild(el('div', 'hint', 'Can’t load devices: ' + e.message)); });
  }
  $('set-out-others').onclick = function () {
    confirmBox('Sign out every other phone or computer signed in as you? This phone stays signed in.', 'Sign them out').then(function (ok) {
      if (ok) api('revokeSessions', { scope: 'others' }).then(function (r) { toast('Signed out ' + r.removed + ' other device' + (r.removed === 1 ? '' : 's') + '.'); loadDevices(); }).catch(function (e) { toast(e.message, true); });
    });
  };
  $('team-out-all').onclick = function () {
    confirmBox('Sign out EVERYONE (every person, every phone) except this phone? They sign in again with their PIN. Unsent entries stay on their phones.', 'Sign out everyone').then(function (ok) {
      if (ok) api('revokeSessions', { scope: 'everyone' }).then(function (r) { toast('Signed out ' + r.removed + ' device' + (r.removed === 1 ? '' : 's') + '.'); loadDevices(); }).catch(function (e) { toast(e.message, true); });
    });
  };
  function loadTeam() {
    var box = $('team'); box.innerHTML = '';
    api('listUsers').then(function (r) {
      r.users.forEach(function (u) {
        var row = el('div', 'tm' + (u.active ? '' : ' off')), m = el('div', 'm');
        m.appendChild(el('div', 'n', u.name + (u.role === 'owner' ? ' · owner' : '')));
        m.appendChild(el('div', 'd', (u.active ? 'Active' : 'Turned off') + ' · last sign-in ' + (u.lastLogin || 'never')));
        row.appendChild(m);
        if (S.user && u.uid !== S.user.uid) {
          var pinB = el('button', 'btn', 'New PIN'), act = el('button', 'btn' + (u.active ? ' danger' : ''), u.active ? 'Turn off' : 'Turn on');
          pinB.onclick = function () {
            ask('New PIN for ' + u.name + '. They will be signed out on every phone.', [{ id: 'pin', label: 'New PIN (4-6 digits)', type: 'password', inputmode: 'numeric', maxlength: 6 }], 'Set PIN').then(function (v) {
              if (!v) return; api('resetPin', { uid: u.uid, pin: v.pin }).then(function () { toast('PIN changed for ' + u.name + '.'); }).catch(function (e) { toast(e.message, true); });
            });
          };
          act.onclick = function () {
            confirmBox((u.active ? 'Turn off ' + u.name + '? They are signed out right away. Their past entries stay.' : 'Turn ' + u.name + ' back on?'), u.active ? 'Turn off' : 'Turn on').then(function (ok) {
              if (ok) api('updateUser', { uid: u.uid, active: !u.active }).then(loadTeam).catch(function (e) { toast(e.message, true); });
            });
          };
          var outB = el('button', 'btn', 'Sign out');
          outB.onclick = function () {
            confirmBox('Sign ' + u.name + ' out on every phone? They sign in again with their PIN.', 'Sign out').then(function (ok) {
              if (ok) api('revokeSessions', { scope: 'user', uid: u.uid }).then(function (r) { toast('Signed out ' + u.name + ' (' + r.removed + ' device' + (r.removed === 1 ? '' : 's') + ').'); }).catch(function (e) { toast(e.message, true); });
            });
          };
          row.appendChild(pinB); row.appendChild(outB); row.appendChild(act);
        }
        box.appendChild(row);
      });
    }).catch(function (e) { box.appendChild(el('div', 'hint', 'Can’t load the team: ' + e.message)); });
  }
  $('team-add').onclick = function () {
    ask('Add a person. Give them their name and PIN in person (not by text).', [
      { id: 'name', label: 'Name (what they type to sign in)', placeholder: 'Maria' },
      { id: 'pin', label: 'PIN (4-6 digits)', type: 'password', inputmode: 'numeric', maxlength: 6 },
      { id: 'role', label: 'Role', options: [['employee', 'Employee: logs entries, you approve them'], ['owner', 'Owner: sees everything']] }
    ], 'Add').then(function (v) {
      if (!v) return;
      api('addUser', v).then(function (r) { toast('Added ' + r.user.name + '.'); loadTeam(); }).catch(function (e) { toast(e.message, true); });
    });
  };
  $('set-pin').onclick = function () {
    ask('Change your PIN. Other phones signed in as you will be signed out.', [
      { id: 'old', label: 'Current PIN', type: 'password', inputmode: 'numeric', maxlength: 6 },
      { id: 'n1', label: 'New PIN (4-6 digits)', type: 'password', inputmode: 'numeric', maxlength: 6 },
      { id: 'n2', label: 'New PIN again', type: 'password', inputmode: 'numeric', maxlength: 6 }
    ], 'Change PIN').then(function (v) {
      if (!v) return;
      if (v.n1 !== v.n2) return toast('The new PINs don’t match.', true);
      api('changePin', { oldPin: v.old, newPin: v.n1 }).then(function () { toast('PIN changed.'); }).catch(function (e) { toast(e.message, true); });
    });
  };
  $('set-sync').onclick = function () { syncQueue(); };
  $('set-reload').onclick = function () { loadBoot().then(function () { toast('Updated.'); }).catch(function (e) { toast(e.message, true); }); };
  $('set-out').onclick = function () {
    Q.all().then(function (q) {
      var mine = q.filter(function (it) { return S.user && it.uid === S.user.uid; }).length;
      return confirmBox((mine ? mine + ' of your entries are not sent yet. They stay on this phone until you sign in again. ' : '') + 'Sign out of this phone?', 'Sign out');
    }).then(function (ok) {
      if (!ok) return;
      api('logout').catch(function () {});
      if (HAS_PC && navigator.credentials.preventSilentAccess) navigator.credentials.preventSilentAccess().catch(function () {});
      S.token = ''; LS.del('token'); LS.del('boot'); LS.del('custs'); LS.del('pkday'); LS.del('sessExp'); LS.del('sessTrusted');
      showLogin('Signed out.');
    });
  };

  // ---------- app updates (service worker) ----------
  if ('serviceWorker' in navigator) {
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (refreshing) return; refreshing = true; location.reload(); });
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      function ready(w) { $('update').classList.remove('hide'); $('update-go').onclick = function () { w.postMessage('SKIP_WAITING'); }; }
      if (reg.waiting && navigator.serviceWorker.controller) ready(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        w.addEventListener('statechange', function () { if (w.state === 'installed' && navigator.serviceWorker.controller) ready(w); });
      });
      setInterval(function () { reg.update().catch(function () {}); }, 3600000);
    }).catch(function () {});
  }

  // ---------- start ----------
  function start() {
    $('splash').classList.add('hide'); $('login').classList.add('hide'); $('app').classList.remove('hide');
    if (S.boot) applyBoot(S.boot);
    if (LS.get('pkOn', false)) { $('pk-on').checked = true; $('pk-on').onchange.call($('pk-on')); }
    resetExpense(); resetIncome(); resetMiles();
    setNet(navigator.onLine);
    renderQueue();
    var go = new URLSearchParams(location.search).get('go');
    show(['exp', 'inc', 'mil'].indexOf(go) > -1 ? go : 'home');
    loadBoot().then(function () { syncQueue(); }).catch(function (e) { if (!S.boot && e.code !== 'auth') toast('Offline: using the last saved lists.', true); });
  }
  // ./signed-in and ./pin-set are where the sign-in / new-PIN forms submit (answered by sw.js). Tidy the address.
  if (/\/(signed-in|pin-set)$/.test(location.pathname)) {
    try { history.replaceState(null, '', location.pathname.replace(/(signed-in|pin-set)$/, '')); } catch (e) {}
  }
  var hashReset = (location.hash.match(/^#reset=([a-f0-9]{64})$/) || [])[1];
  if (hashReset) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}   // the token never stays in the address bar
    showReset(hashReset);
  } else if (LS.get('afterReset', '')) afterReset();
  else if (S.token && S.user) start();
  else { showLogin(); tryStoredCredential(); }
})();
