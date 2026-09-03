// ==UserScript==
// @name           NavBtn
// @version        1.3.2
// @description    Bouton overlay gamboy — clic gauche: onglet précédent (MRU ping-pong) · clic droit: switcher ctrlTab
// @author         Impre
// @include        main
// ==/UserScript==

(function () {
  'use strict';

  // ================================================================
  // PREFS (MCM — voir preferences.json)
  // ================================================================
  const pref = {
    int(name, fallback) {
      try {
        return Services.prefs.prefHasUserValue(name) ? Services.prefs.getIntPref(name) : fallback;
      } catch (_) {
        return fallback;
      }
    },
    bool(name, fallback) {
      try {
        return Services.prefs.prefHasUserValue(name) ? Services.prefs.getBoolPref(name) : fallback;
      } catch (_) {
        return fallback;
      }
    },
  };

  // ================================================================
  // SON — key.wav en feedback de pression
  // Chargé UNE fois au boot (IOUtils → data URI), zéro I/O au clic.
  // play() dans le handler mousedown = user gesture → autoplay OK.
  // ================================================================
  let clickSound = null;

  async function loadSound() {
    try {
      const path = PathUtils.join(
        PathUtils.profileDir, 'chrome', 'sine-mods', 'navbtn', 'resources', 'key.wav',
      );
      if (!(await IOUtils.exists(path))) return;
      const bytes = await IOUtils.read(path);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      clickSound = new Audio('data:audio/wav;base64,' + btoa(binary));
      clickSound.volume = 0.5;
    } catch (e) {
      console.warn('[NavBtn] Sound load failed:', e.message);
    }
  }

  function playClick() {
    if (!clickSound) return;
    if (!pref.bool('navbtn.sound', true)) return;
    try {
      clickSound.currentTime = 0;
      clickSound.play().catch(() => {});
    } catch (_) {}
  }

  // ================================================================
  // INIT
  // ================================================================
  function init() {
    if (window.__navBtn) return;
    if (!window.gBrowser || !gBrowser.tabContainer || !window.ctrlTab) {
      setTimeout(init, 500);
      return;
    }
    window.__navBtn = true;

    buildButton();
    watchTabs();
    portSwitcher();
    loadSound();

    // Armement de la pile : quand le session restore a fini (event dédié),
    // sinon la chorégraphie de démarrage polluerait la pile MRU (flash).
    window.addEventListener('SSWindowRestored', armMru, { once: true });
    // LAST RESORT: si le session restore est désactivé, SSWindowRestored ne
    // tire jamais — aucun autre événement ne signale "fenêtre prête", donc
    // timer de secours one-shot (idempotent, sans effet si déjà armé).
    setTimeout(armMru, 3000);

    // Coordination BG-Zen : le boot splash couvre toute l'UI et notre bouton
    // (z-index max) flotte AU-DESSUS → masqué tant que le splash est actif.
    // BG-Zen pose l'attribut bgzen-booted sur #main-window à la sortie.
    // MutationObserver = event-driven, aucune polling.
    new MutationObserver(() => updateButton()).observe(document.getElementById('main-window'), {
      attributes: true,
      attributeFilter: ['bgzen-booted'],
    });

    console.log('[NavBtn] v1.3.2 — bouton prêt, MRU armé au SSWindowRestored');
  }

  // ================================================================
  // PILE MRU — 100% event-driven, O(1) amorti
  // mru[0] = onglet le plus récent (= courant après un TabSelect)
  // ================================================================
  const MRU_CAP = 30;
  const mru = [];

  // Anti-flash : la pile ne s'arme qu'une fois la fenêtre réellement prête.
  // Pendant la chorégraphie de démarrage (session restore, switch de
  // workspace Zen), des TabSelect transitoires créeraient une fausse cible
  // → le bouton apparaît brièvement puis disparaît.
  let mruArmed = false;

  function armMru() {
    if (mruArmed) return;
    mruArmed = true;
    // Seed avec l'onglet courant : pas de faux "précédent" au premier clic
    if (gBrowser.selectedTab) mru.unshift(gBrowser.selectedTab);
    updateButton();
  }

  function targetTab() {
    for (const t of mru) {
      if (t !== gBrowser.selectedTab && t.isConnected) return t;
    }
    return null;
  }

  function watchTabs() {
    const tc = gBrowser.tabContainer;

    tc.addEventListener('TabSelect', () => {
      if (!mruArmed) return; // ignore la chorégraphie de démarrage
      const t = gBrowser.selectedTab;
      const i = mru.indexOf(t);
      if (i !== -1) mru.splice(i, 1);
      mru.unshift(t);
      if (mru.length > MRU_CAP) mru.pop();
      updateButton();
    });

    // "Entrée disparaît" : le retrait à la fermeture fait remonter
    // naturellement vers l'onglet d'avant.
    tc.addEventListener('TabClose', (e) => {
      if (!mruArmed) return;
      const i = mru.indexOf(e.target);
      if (i !== -1) mru.splice(i, 1);
      updateButton();
      // Event-loop yield : laisse gBrowser.selectedTab basculer sur son
      // successeur APRÈS la fermeture, puis recalcule. Sans ça, si le
      // TabClose arrive avant le switch de sélection, targetTab() croit
      // qu'un aller-retour existe encore (bouton bloqué visible).
      setTimeout(updateButton, 0);
    });

    // Refresh favicon/label uniquement pour la cible courante
    tc.addEventListener('TabAttrModified', (e) => {
      if (e.target === targetTab()) updateButton();
    });
  }

  function switchToPrevious() {
    const t = targetTab();
    if (!t) {
      // Rien à switcher → feedback shake façon "pas de continue"
      btn.classList.remove('navbtn-shake');
      void btn.offsetWidth; // reflow pour relancer l'animation
      btn.classList.add('navbtn-shake');
      return;
    }
    gBrowser.selectedTab = t;
  }

  // ================================================================
  // BOUTON OVERLAY — un seul nœud dans le chrome UI
  // ================================================================
  let btn;
  let favEl;
  let wrapEl;

  function buildButton() {
    const wrap = document.createElement('div');
    wrap.id = 'navbtn-wrap';
    // Anti-flash : caché dès la création, avant le premier append au DOM.
    // Le premier updateButton() ne le révèle que si une cible existe VRAIMENT.
    wrap.classList.add('navbtn-notarget');
    wrapEl = wrap;

    btn = document.createElement('div');
    btn.id = 'navbtn';
    btn.setAttribute('role', 'button');

    // ◀◀ — icône rewind en pur CSS (clip-path, thème via currentColor)
    const ff = document.createElement('div');
    ff.className = 'navbtn-ff';

    favEl = document.createElement('div');
    favEl.className = 'navbtn-fav';

    btn.appendChild(ff);
    btn.appendChild(favEl);
    wrap.appendChild(btn);
    document.documentElement.appendChild(wrap);

    // Applique les prefs MCM (offset, size)
    const offset = pref.int('navbtn.offset', 24);
    const size = pref.int('navbtn.size', 52);
    wrap.style.bottom = offset + 'px';
    wrap.style.right = offset + 'px';
    btn.style.height = size + 'px';

    // Clic gauche → switch immédiat · middle-click → close (ou discard si épinglé)
    btn.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        playClick();
        const tab = gBrowser.selectedTab;
        // Épinglé/Essential : discard (unload mémoire, onglet conservé)
        // — même règle que le switcher ctrlTab, API officielle Zen
        if (tab.pinned || tab.hasAttribute('zen-essential')) {
          gBrowser
            .explicitUnloadTabs([tab])
            .catch((err) => console.error('[NavBtn] Discard error:', err.message));
        } else {
          gBrowser.removeTab(tab);
        }
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      playClick();
      switchToPrevious();
    });

    // Sécurité : tuer l'auxclick middle (coller presse-papier, etc.)
    btn.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // Clic droit → switcher ctrlTab (et tuer le contextmenu natif)
    btn.addEventListener(
      'contextmenu',
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!window.ctrlTab.isOpen) openInstant(window.ctrlTab);
      },
      true,
    );

    // Masquer en fullscreen vidéo (event-driven, pas de polling)
    document.addEventListener('fullscreenchange', () => {
      if (!pref.bool('navbtn.hideFullscreen', true)) return;
      wrap.classList.toggle('navbtn-hidden', !!document.fullscreenElement);
    });

    // Nettoyage de la classe shake en fin d'animation
    btn.addEventListener('animationend', () => btn.classList.remove('navbtn-shake'));

    updateButton();
  }

  // Splash BG-Zen actif ? (BG-Zen absent du profil → jamais actif)
  function bootSplashActive() {
    if (typeof window.__bgZenLoaded === 'undefined') return false;
    const mw = document.getElementById('main-window');
    return !!mw && !mw.hasAttribute('bgzen-booted');
  }

  function updateButton() {
    if (!btn) return;
    const t = targetTab();

    // Auto-hide : invisible tant qu'aucun aller-retour n'est possible OU
    // pendant le boot splash BG-Zen (notre z-index flotte au-dessus de lui)
    if (wrapEl) {
      wrapEl.classList.toggle(
        'navbtn-notarget',
        (!t || bootSplashActive()) && pref.bool('navbtn.autoHide', true),
      );
    }

    const showFav = pref.bool('navbtn.showFavicon', true);

    if (!t) {
      favEl.style.backgroundImage = '';
      favEl.classList.add('navbtn-nofav');
      btn.setAttribute('tooltiptext', 'NavBtn — rien à switcher');
      return;
    }

    const img = t.getAttribute('image');
    if (showFav && img) {
      favEl.style.backgroundImage = 'url("' + img + '")';
      favEl.classList.remove('navbtn-nofav');
    } else {
      favEl.style.backgroundImage = '';
      favEl.classList.add('navbtn-nofav');
    }
    btn.setAttribute('tooltiptext', 'NavBtn → ' + (t.label || 'onglet'));
  }

  // ================================================================
  // SWITCHER CTRLTAB — portage OneForAll v1.2 (quasi verbatim)
  // Trigger: Ctrl+Alt+Numpad1 (envoyé par la souris via AHK)
  // Cancel:  Escape
  // ================================================================
  const CANCEL_KEY = 'Escape';

  function isTrigger(e) {
    return e.code === 'Numpad1' && e.ctrlKey && e.altKey;
  }

  function portSwitcher() {
    const ct = window.ctrlTab;

    // --- KEYDOWN — toggle open/commit + cancel ---
    window.addEventListener(
      'keydown',
      (e) => {
        if (isTrigger(e)) {
          e.preventDefault();
          e.stopPropagation();
          if (!ct.isOpen) openInstant(ct);
          return;
        }

        if (e.code === CANCEL_KEY && ct.isOpen) {
          e.preventDefault();
          e.stopPropagation();
          ct.close();
        }
      },
      true,
    );

    // --- WHEEL — naviguer les previews (panel ouvert uniquement) ---
    window.addEventListener(
      'wheel',
      (e) => {
        if (!ct.isOpen) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.deltaY > 0) ct.advanceFocus(true);
        else ct.advanceFocus(false);
      },
      { capture: true, passive: false },
    );

    // --- MIDDLE-CLICK — close/discard depuis les previews ---
    // Monkey-patch: garder le panel ouvert quand tabCount tombe à 2
    // (le natif appelle close() → on remplace par updatePreviews())
    const origRemoveClosing = ct.removeClosingTabFromUI.bind(ct);
    ct.removeClosingTabFromUI = function (aTab) {
      if (this.tabCount == 2) {
        this.updatePreviews();
      } else {
        origRemoveClosing(aTab);
      }

      // Recalcul largeur + recentrage (même formule que _openPanel)
      try {
        let width = Math.min(screen.availWidth * 0.99, this.canvasWidth * 1.25 * this.tabPreviewCount);
        this.panel.style.width = width + 'px';
        let x = screen.availLeft + (screen.availWidth - width) / 2;
        let estimateHeight = this.canvasHeight * 1.25 + 75;
        let y = screen.availTop + (screen.availHeight - estimateHeight) / 2;
        this.panel.moveTo(x, y);
      } catch (e) {
        console.warn('[NavBtn] Panel resize failed:', e.message);
      }
    };

    window.addEventListener(
      'mousedown',
      (e) => {
        if (e.button !== 1 || !ct.isOpen) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        const preview = e.target.closest('.ctrlTab-preview');
        if (!preview || !preview._tab) return;

        const tab = preview._tab;
        const isPinned = tab.pinned || tab.hasAttribute('zen-essential');

        if (isPinned) {
          // Épinglé/Essential : discard (unload mémoire) via l'API officielle Zen
          gBrowser
            .explicitUnloadTabs([tab])
            .then(() => {
              try {
                ct.updatePreviews();
              } catch (_) {}

              try {
                let width = Math.min(screen.availWidth * 0.99, ct.canvasWidth * 1.25 * ct.tabPreviewCount);
                ct.panel.style.width = width + 'px';
                let x = screen.availLeft + (screen.availWidth - width) / 2;
                let estimateHeight = ct.canvasHeight * 1.25 + 75;
                let y = screen.availTop + (screen.availHeight - estimateHeight) / 2;
                ct.panel.moveTo(x, y);
              } catch (_) {}

              console.log('[NavBtn] Discarded pinned tab:', tab.label);
            })
            .catch((err) => {
              console.error('[NavBtn] Discard error:', err.message);
            });
        } else {
          gBrowser.removeTab(tab);
          console.log('[NavBtn] Closed tab:', tab.label);
        }
      },
      true,
    );

    // Bloquer click/auxclick middle pendant que le panel est ouvert
    for (const evtName of ['click', 'auxclick']) {
      window.addEventListener(
        evtName,
        (e) => {
          if (e.button !== 1 || !ct.isOpen) return;
          e.preventDefault();
          e.stopImmediatePropagation();
        },
        true,
      );
    }
  }

  // ================================================================
  // Ouvrir le switcher instantanément (bypass du délai natif 200ms)
  // ================================================================
  function openInstant(ct) {
    ct.open();
    if (ct._timer) {
      clearTimeout(ct._timer);
      ct._timer = null;
      ct._openPanel();
    }
  }

  // ================================================================
  // BOOTSTRAP
  // ================================================================
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
