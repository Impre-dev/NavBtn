// ==UserScript==
// @name           NavBtn
// @version        1.4.6
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
    str(name, fallback) {
      try {
        return Services.prefs.prefHasUserValue(name) ? Services.prefs.getStringPref(name) : fallback;
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
      const path = PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'navbtn', 'resources', 'key.wav');
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

    // Labo d'animations : preset live via la pref MCM navbtn.anim.
    // Observer de pref = event-driven, changement sans restart.
    Services.prefs.addObserver('navbtn.anim', {
      observe: () => {
        if (!wrapEl) return;
        wrapEl.setAttribute('navbtn-anim', pref.str('navbtn.anim', 'fade'));
        previewAnim();
      },
    });

    console.log('[NavBtn] v1.4.6 — bouton prêt, MRU armé au SSWindowRestored');
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

    // Refresh favicon/label/busy : cible ET onglet courant (double favicon
    // + fin de chargement qui révèle le bouton, cf updateButton)
    tc.addEventListener('TabAttrModified', (e) => {
      if (e.target === targetTab() || e.target === gBrowser.selectedTab) updateButton();
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
  let curEl; // favicon droite — site courant (présent)
  let tgtEl; // favicon gauche — site précédent (passé, la cible)
  let wrapEl;

  function buildButton() {
    const wrap = document.createElement('div');
    wrap.id = 'navbtn-wrap';
    // Anti-flash : caché dès la création, avant le premier append au DOM.
    // Le premier updateButton() ne le révèle que si une cible existe VRAIMENT.
    wrap.classList.add('navbtn-notarget');
    wrapEl = wrap;
    // Preset d'animation courant (labo MCM — navbtn.anim)
    wrap.setAttribute('navbtn-anim', pref.str('navbtn.anim', 'fade'));

    btn = document.createElement('div');
    btn.id = 'navbtn';
    btn.setAttribute('role', 'button');

    // [précédent] / [courant] — timeline naturelle : passé à gauche,
    // présent à droite (le cerveau lit l'espace comme du temps)
    tgtEl = document.createElement('div');
    tgtEl.className = 'navbtn-fav navbtn-tgt';

    const slash = document.createElement('div');
    slash.className = 'navbtn-slash';

    curEl = document.createElement('div');
    curEl.className = 'navbtn-fav navbtn-cur';

    btn.appendChild(tgtEl);
    btn.appendChild(slash);
    btn.appendChild(curEl);
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
          gBrowser.explicitUnloadTabs([tab]).catch((err) => console.error('[NavBtn] Discard error:', err.message));
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
  // Preview MCM : rejoue l'animation d'ENTRÉE du preset courant.
  // Cycle add class → reflow forcé → remove : l'état caché s'applique
  // sans transition (règle CSS navbtn-preview), puis son retrait
  // déclenche la transition/animation d'entrée du preset.
  function previewAnim() {
    if (!wrapEl) return;
    wrapEl.classList.add('navbtn-preview');
    void wrapEl.offsetWidth; // reflow : styles cachés appliqués à froid
    wrapEl.classList.remove('navbtn-preview');
  }

  function bootSplashActive() {
    if (typeof window.__bgZenLoaded === 'undefined') return false;
    const mw = document.getElementById('main-window');
    return !!mw && !mw.hasAttribute('bgzen-booted');
  }

  function updateButton() {
    if (!btn) return;
    const t = targetTab();

    // Auto-hide : invisible tant qu'aucun aller-retour n'est possible,
    // pendant le boot splash BG-Zen (notre z-index flotte au-dessus de lui),
    // ou tant que l'onglet courant charge (attribut busy) → le bouton
    // n'apparaît qu'une fois le site arrivé, favicons déjà posées
    // (l'entrée/sortie de busy tire TabAttrModified → event-driven).
    const curTab = gBrowser.selectedTab;
    const loading = !!curTab && curTab.hasAttribute('busy');
    if (wrapEl) {
      wrapEl.classList.toggle('navbtn-notarget', (!t || loading || bootSplashActive()) && pref.bool('navbtn.autoHide', true));
    }

    // Favicon droite — où tu es (le présent)
    const cur = gBrowser.selectedTab;
    const curImg = cur && cur.getAttribute('image');
    if (curImg) {
      curEl.style.backgroundImage = 'url("' + curImg + '")';
      curEl.classList.remove('navbtn-nofav');
    } else {
      curEl.style.backgroundImage = '';
      curEl.classList.add('navbtn-nofav');
    }

    // Favicon gauche — le site précédent (le passé, la cible du clic)
    if (!t) {
      tgtEl.style.backgroundImage = '';
      tgtEl.classList.add('navbtn-nofav');
      btn.setAttribute('tooltiptext', 'NavBtn — rien à switcher');
      return;
    }

    const img = t.getAttribute('image');
    if (img) {
      tgtEl.style.backgroundImage = 'url("' + img + '")';
      tgtEl.classList.remove('navbtn-nofav');
    } else {
      tgtEl.style.backgroundImage = '';
      tgtEl.classList.add('navbtn-nofav');
    }
    btn.setAttribute('tooltiptext', 'NavBtn → ' + (t.label || 'onglet'));
  }

  // ================================================================
  // SWITCHER CTRLTAB — portage OneForAll v1.2 (quasi verbatim)
  // Trigger: Ctrl+Alt+Numpad1 (envoyé par la souris via AHK)
  // Cancel:  Escape
  // ================================================================
  const CANCEL_KEY = 'Escape';

  // ================================================================
  // GRILLE RESPONSIVE du switcher ctrlTab
  // Source native (browser-ctrlTab.js) :
  //  - max 7 previews (maxTabPreviews), chacun <button flex="1">
  //    → l'attribut XUL flex=1 les étire/squeeze sur UNE ligne
  //  - largeur réelle d'un item = canvasWidth + 16px (padding 8+8)
  // Ici : grille compacte max GRID_MAX_COLS colonnes, items figés
  // (flex: 0 0 auto) + flex-wrap sur le conteneur → 7 onglets =
  // 4 cols × 2 rows centré, fini la ligne qui traverse l'écran.
  // ================================================================
  const GRID_MAX_COLS = 4;
  const MAX_TAB_PREVIEWS = 12; // cap natif : 7 (prévu pour une seule ligne)

  // Le conteneur natif #ctrlTab-previews est un <hbox> XUL : impossible
  // d'y imposer une grille fiable — les <button flex="1"> restent soumis
  // au box layout XUL quel que soit le display CSS posé sur le parent.
  // → on déplace les previews dans une vraie <div> HTML en display:grid,
  // créée UNE fois puis réutilisée à chaque ouverture (les listeners des
  // boutons suivent le nœud, updatePreviews opère sur le tableau previews
  // indépendamment du DOM — aucun état natif cassé).
  function ensureGrid(ct) {
    const cont = ct.panel.querySelector('#ctrlTab-previews');
    if (!cont) return null;
    let grid = ct.panel.querySelector('#navbtn-ctrltab-grid');
    if (!grid) {
      grid = document.createElement('div');
      grid.id = 'navbtn-ctrltab-grid';
      for (const p of [...cont.children]) grid.appendChild(p);
      cont.parentNode.insertBefore(grid, cont.nextSibling);
      cont.hidden = true;
    }
    return grid;
  }

  // Slot shadow du panel ctrlTab : c'est LUI qui peint le gris natif
  // (bg rgba(102,102,102,.85), mesuré au diagnostic) et le padding/flex
  // du thème tidypopup (display:flex + padding 6px !important sur
  // ::part(content)). Un override CSS ::part() ne matche pas depuis
  // notre feuille (::part = author sheets uniquement) → styles INLINE
  // via chrome JS : priorité maximale, contestable par personne.
  // Appelée à l'init ET à popupshown (le shadow root peut être créé
  // paresseusement à la première ouverture).
  function neutralizeSlot(ct) {
    if (ct.__navbtnSlotDone) return;
    const slot = ct.panel.openOrClosedShadowRoot?.querySelector('slot');
    if (!slot) return; // pas encore créé — retenter à popupshown
    const s = slot.style;
    s.setProperty('display', 'block', 'important');
    s.setProperty('background', 'transparent', 'important');
    s.setProperty('box-shadow', 'none', 'important');
    s.setProperty('border', 'none', 'important');
    s.setProperty('padding', '0', 'important');
    s.setProperty('margin', '0', 'important');
    s.setProperty('overflow', 'clip', 'important');
    s.setProperty('border-radius', '16px', 'important');
    ct.__navbtnSlotDone = true;
    console.log('[NavBtn] slot ctrlTab neutralisé (gris/padding/flex)');
  }

  // --- Blur du switcher : NOS overlays (doctrine : NavBtn possède
  // ctrlTab, structure ET peau — plans/doctrine-mods.md). Porté depuis
  // Nebula-Fork avec le FIX du bug qui causait le "padding fantôme" :
  // Nebula posait les overlays en coords VIEWPORT (r.top + scrollY —
  // scrollY vaut TOUJOURS 0 dans un doc chrome) alors qu'ils sont
  // absolus dans #browser, dont l'origine est SOUS les toolbars →
  // conteneur flou décalé bas/droite, vignettes collées en haut-gauche.
  // Fix : soustraire le rect de #browser (même référentiel).
  function portBlur() {
    const ct = window.ctrlTab;
    const browser = document.getElementById('browser');
    if (!ct || !browser) return;
    if (document.getElementById('navbtn-ctrltab-blur-above')) return;

    const mk = (id, css) => {
      const o = document.createElement('div');
      o.id = id;
      Object.assign(o.style, { position: 'absolute', display: 'none', borderRadius: '16px' }, css);
      browser.appendChild(o);
      return o;
    };

    // above : le blur (au-dessus du fond opaque, sous le panel)
    const above = mk('navbtn-ctrltab-blur-above', {
      zIndex: '2147483646',
      pointerEvents: 'auto',
      backdropFilter: 'blur(32px) saturate(140%)',
    });
    // below : fond opaque qui assure la lisibilité derrière le blur
    const below = mk('navbtn-ctrltab-blur-below', {
      pointerEvents: 'none',
      backgroundColor: 'light-dark(rgb(200 200 200 / 100%), rgb(20 20 20 / 100%))',
    });

    let raf = 0;
    const hide = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      above.style.display = below.style.display = 'none';
    };
    // Tracking visuel pendant l'ouverture uniquement (démarré à
    // popupshown, stoppé à popuphidden — pas de boucle au repos).
    const track = () => {
      const r = ct.panel.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) return hide();
      const b = browser.getBoundingClientRect(); // LE FIX : référentiel #browser
      const s = {
        top: r.top - b.top + 'px',
        left: r.left - b.left + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
        display: 'block',
      };
      Object.assign(above.style, s);
      Object.assign(below.style, s);
      raf = requestAnimationFrame(track);
    };

    ct.panel.addEventListener('popupshown', track);
    ct.panel.addEventListener('popuphidden', hide);
    console.log('[NavBtn] blur switcher porté (overlays propres, coords fixées)');
  }

  function resizePanel(ct) {
    const count = ct.tabPreviewCount;
    const itemH = ct.canvasHeight + 10 + 40; // canvas + padding + favicon/label
    const gap = 4;
    const avail = screen.availWidth * 0.95;

    // Largeur item : ⚠ ne JAMAIS mesurer le bouton lui-même — grid-item
    // étiré sur son track (justify-items: stretch par défaut), son
    // scrollWidth ≥ clientWidth = track courant → à CHAQUE fermeture
    // d'onglet itemW gonflait de +8 (cliquet), cols chutait, les rangées
    // poussaient et le popup ne suivait pas (slot overflow:clip) →
    // vignettes coupées en "fines bandes" + layout qui dérive. On mesure
    // l'INNER (.ctrlTab-preview-inner) : enfant XUL d'un bouton
    // pack=center, il garde sa largeur NATURELLE (canvas + padding +
    // border ; le label a contain:inline-size → zéro contribution) —
    // stable à l'ouverture comme après N fermetures. +8 : favicon natif
    // débordant (margin-inline-end négatif). Floor théorique tant que
    // le panel n'est pas layouté (mesure = 0).
    const grid = ensureGrid(ct);
    let itemW = ct.canvasWidth + 20; // floor : canvas + 2×5 pad inner + 2×2 border + favicon
    if (grid) {
      const inner = grid.querySelector('.ctrlTab-preview:not([hidden]) > .ctrlTab-preview-inner');
      if (inner) {
        const w = Math.ceil(inner.getBoundingClientRect().width) + 8;
        if (w > itemW) itemW = w;
      }
    }

    // Colonnes : limitées par la grille, le nombre d'onglets ET l'écran
    const cols = Math.max(1, Math.min(count, GRID_MAX_COLS, Math.floor((avail - 20) / (itemW + gap))));
    const rows = Math.ceil(count / cols);
    const gridW = cols * itemW + (cols - 1) * gap;
    const width = gridW + 20; // padding horizontal du panel (10+10)

    ct.panel.style.width = width + 'px';

    // Grille IN-FLOW : elle dimensionne le panel (la fenêtre native suit
    // le slot). Le décalage XUL d'antan n'existe plus : le slot shadow
    // est forcé en display:block/padding:0 par JS (cf portSwitcher),
    // les marges sont gérées par le margin symétrique de la grille.
    if (grid) {
      grid.style.display = 'grid';
      grid.style.gridTemplateColumns = 'repeat(' + cols + ', ' + itemW + 'px)';
      grid.style.gap = gap + 'px';
      // ⚠ PADDING, pas margin : la fenêtre popup épouse le contenu SANS
      // compter les margins verticaux (testé : 10→20px = zéro effet).
      // Le padding est interne → il pousse le fit-content → la fenêtre
      // grandit. Top +3 : compensation visuelle (padding interne vignette).
      grid.style.width = gridW + 'px'; // content-box : +20px de padding → gridW+20 = largeur panel
      grid.style.padding = '24px 10px 0';
      grid.style.margin = '0';
    }

    // showAll sous la grille, in-flow lui aussi.
    const allC = ct.panel.querySelector('#ctrlTab-showAll-container');
    if (allC) {
      allC.style.width = gridW + 'px';
      allC.style.margin = '0 10px 0'; // G/D ok (largeur panel forcée)
      allC.style.paddingBottom = '12px'; // padding pour le bas (idem)
    }

    // Position initiale estimée (anti-flash) — le centrage exact est
    // fait à popupshown sur les dimensions réelles (cf portSwitcher).
    // ⚠ Centrage sur la FENÊTRE, pas l'écran (le natif fait
    // openPopupAtScreen → panel hors fenêtre quand elle n'est pas
    // plein écran — défaut hérité d'OneForAll).
    const estimateHeight = itemH * rows + 75;
    const x = window.screenX + (window.outerWidth - width) / 2;
    const y = window.screenY + (window.outerHeight - estimateHeight) / 2;
    ct.panel.moveTo(x, y);

    console.log(
      '[NavBtn] ctrlTab grid:',
      count,
      'previews →',
      cols,
      'cols ×',
      rows,
      'rows, item',
      Math.round(itemW) + 'px, panel',
      Math.round(width) + 'px',
    );
  }

  function isTrigger(e) {
    return e.code === 'Numpad1' && e.ctrlKey && e.altKey;
  }

  function portSwitcher() {
    const ct = window.ctrlTab;

    // Le cap natif (7 previews) était dimensionné pour une ligne unique.
    // Notre grille permet plus. ⚠ Piège natif : le getter previews() se
    // remplace par un CACHE après son premier accès (il ne recrée jamais
    // les boutons) → si ctrlTab.init() l'a déjà touché au boot, monter
    // maxTabPreviews ne change rien. On gère les 2 cas : lever le cap,
    // puis étendre le cache existant à la main via _makePreview() natif.
    ct.maxTabPreviews = MAX_TAB_PREVIEWS;
    const host = document.getElementById('navbtn-ctrltab-grid') || document.getElementById('ctrlTab-previews');
    const previewsArr = ct.previews; // crée 12 si vierge, sinon le cache 7
    if (previewsArr.length - 1 < MAX_TAB_PREVIEWS && host) {
      const showAll = previewsArr.pop(); // showAllButton reste en fin de liste
      while (previewsArr.length < MAX_TAB_PREVIEWS) {
        const p = ct._makePreview();
        previewsArr.push(p);
        host.appendChild(p);
      }
      previewsArr.push(showAll);
      console.log('[NavBtn] previews étendus :', previewsArr.length - 1);
    }

    neutralizeSlot(ct);
    portBlur();

    // Centrage EXACT : l'estimation de hauteur multi-lignes dérive trop →
    // on mesure le panel réellement rendu à popupshown (event-driven) et
    // on recentre sur les vraies dimensions, les deux axes.
    ct.panel.addEventListener('popupshown', () => {
      neutralizeSlot(ct);

      // Recalage à l'ouverture : le panel est layouté ici → la mesure
      // d'itemW (cf resizePanel) est fiable dès la 1re frame au lieu de
      // démarrer sur le floor théorique et de "sauter" au 1er middle-click.
      try {
        resizePanel(ct);
      } catch (e) {
        console.warn('[NavBtn] resize at shown:', e.message);
      }

      const r = ct.panel.getBoundingClientRect();

      // Centrage exact sur les dimensions réelles (la grille in-flow
      // dimensionne le panel naturellement — rien à recalculer).
      ct.panel.moveTo(window.screenX + (window.outerWidth - r.width) / 2, window.screenY + (window.outerHeight - r.height) / 2);

      // Wheel attaché UNIQUEMENT pendant l'ouverture (cf onWheel plus bas)
      window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    });

    ct.panel.addEventListener('popuphidden', () => {
      window.removeEventListener('wheel', onWheel, { capture: true, passive: false });
    });

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

    // --- WHEEL — naviguer les previews ---
    // ⚠ Perf : un listener passive:false sur window se place dans le chemin
    // de latence du scroll de CHAQUE page, panel fermé ou pas. On l'attache
    // donc à popupshown et on le détache à popuphidden (zéro coût au repos).
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY > 0) ct.advanceFocus(true);
      else ct.advanceFocus(false);
    };

    // --- PATCH updatePreview — garde anti double-résolution ---
    // Course native (browser-ctrlTab.js:383) : quand on ferme vite, deux
    // get() du MÊME tab sont en vol (updatePreviews ré-assigne les mêmes
    // tabs aux mêmes previews) → le 1er remplace le placeholder, le 2e
    // fait replaceChild(img, placeholder parti) → DOMException attrapée
    // par le catch natif (bruit console + vignette figée). Le garde
    // natif (switch sur _tab) protège contre un tab CHANGÉ, pas contre
    // un doublon. Réimplémentation à l'identique + le garde manquant :
    // si l'enfant capturé n'est plus dans le canvas → replaceChildren.
    ct.updatePreview = function (aPreview, aTab) {
      if (aPreview == this.showAllButton) return;

      aPreview._tab = aTab;

      if (!aTab) {
        this._clearCanvas(aPreview._canvas);
        aPreview.hidden = true;
        aPreview._label.removeAttribute('value');
        aPreview.removeAttribute('tooltiptext');
        aPreview._favicon.removeAttribute('src');
        return;
      }

      const canvas = aPreview._canvas;
      const canvasWidth = this.canvasWidth;
      const canvasHeight = this.canvasHeight;
      let existingPreview = canvas.firstChild;
      if (!existingPreview) {
        const placeholder = document.createElement('img');
        placeholder.className = 'ctrlTab-placeholder';
        placeholder.setAttribute('width', canvasWidth);
        placeholder.setAttribute('height', canvasHeight);
        placeholder.setAttribute('alt', '');
        canvas.appendChild(placeholder);
        existingPreview = placeholder;
      }
      tabPreviews
        .get(aTab)
        .then((img) => {
          if (aPreview._tab !== aTab) {
            if (aPreview._tab === null) this._clearCanvas(canvas);
            return;
          }
          if (img) {
            img.style.width = canvasWidth + 'px';
            img.style.height = canvasHeight + 'px';
            if (existingPreview.parentNode === canvas) {
              canvas.replaceChild(img, existingPreview);
            } else {
              // Doublon résolu en 2e : l'enfant capturé a déjà tourné —
              // on repart propre, dernier résolu = dernier affiché.
              canvas.replaceChildren(img);
            }
          }
        })
        .catch((error) => console.error(error));

      aPreview._label.setAttribute('value', aTab.label);
      aPreview.setAttribute('tooltiptext', aTab.label);
      if (aTab.image) {
        aPreview._favicon.setAttribute('src', aTab.image);
      } else {
        aPreview._favicon.removeAttribute('src');
      }
      aPreview.hidden = false;
    };

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

      // Recalcul grille + recentrage (responsive, cf resizePanel)
      try {
        resizePanel(ct);
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
                resizePanel(ct);
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
    // open() calcule canvasWidth = écran*0.85/maxTabPreviews → vignettes
    // minuscules avec notre cap de 12. Et si on re-rendait après coup,
    // les DEUX batches de thumbnails async se battraient (le dernier
    // résolu gagne) → tailles mixtes. Dance propre : cap à 7 le temps
    // d'open() (taille vignette "grand écran", rendu unique), puis
    // restauration immédiate pour tabPreviewCount.
    const cap = ct.maxTabPreviews;
    ct.maxTabPreviews = 7;
    ct.open();
    ct.maxTabPreviews = cap;
    if (ct._timer) {
      clearTimeout(ct._timer);
      ct._timer = null;
      ct._openPanel();
      // _openPanel pose la largeur native mono-ligne → on repasse
      // en grille responsive immédiatement (même frame, pas de flash)
      resizePanel(ct);
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
