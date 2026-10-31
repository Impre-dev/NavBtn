# Roadmap — NavBtn

## File priorisée

(vide — aucun chantier ouvert)

## Leçons de plateforme

| Fait | Conséquence | Contournement |
|---|---|---|
| Les maj Zen suppriment des internals natifs sans prévenir (1.22b : `maxTabPreviews` getter-only ; 1.24b : `_clearCanvas` supprimé) | Nos monkey-patches meurent en silence : TypeError au clic droit, panel jamais ouvert, zéro trace en console visible | Sonde `tr()` permanente : `openInstant` est sous try-catch et loggue message+stack dans `trace.log` (v1.4.16). Au prochain symptôme, lire le log AVANT de spéculer |
| Ctrl+Tab clavier et clic-droit bouton partagent le même `ctrlTab.open()` natif | Une casse du chemin open() tue les DEUX entrées en même temps | — |

## Livré & poussé

| Version | Quoi | Validation | Hash |
|---|---|---|---|
| 1.4.16 | Fix Zen 1.24b : `_clearCanvas` supprimé du natif → miroir `replaceChildren()` ; try-catch+log sur `openInstant` | Clic droit OK constaté opérateur 31/10 + trace.log (POST-open _timer:true, popupshown, resizePanel) | a5a7ad3 |
| 1.4.15 | Dark-fixe : look gameboy épinglé en dur (#FBFBFB/#BEBE7BE), fond opaque Ctrl+Tab sombre fixe | Constat opérateur 27/10 | ad06daa |
| 1.4.14 | Fix Zen 1.22b : `maxTabPreviews` getter-only → helper cascade (assignation/defineProperty/dégradation), switcher isolé en try-catch | Constat opérateur 17/10 | b9d54b5 |
