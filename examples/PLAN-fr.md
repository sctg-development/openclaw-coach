# Plan d'Entraînement

<!--
  EXEMPLE. Toutes les valeurs ci-dessous sont fictives. Copiez ce fichier dans l'espace de travail d'OpenClaw sous le nom PLAN.md
  (voir la README, "Fichiers de l'espace de travail"). Le coach le lit chaque matin et le réécrit lorsque le plan
  change : c'est pourquoi c'est du Markdown simple et non un fichier de données. Gardez le tableau "Prochaines 7 jours"
  à jour ; le coach le transforme en `plan` pour que `coach_training_load` vérifie la projection de charge.
-->

- Dernière mise à jour : 2026-11-16 (revue hebdomadaire)
- Objectif : Exemple Mountain Trail, 42 km / 2 300 m D+, 2027-06-12 (30 semaines restantes)
- Phase actuelle : **Base**, semaine 4 sur 8 (volume aérobique, impact repris progressivement)
- Contraintes en vigueur (depuis ATHLETE.md) : max 300 m de descente par session jusqu'au 2026-12-15, pas
  plus de 3 jours de course consécutifs.

## Phases

| Phase | Dates | Objectif | Objectif hebdomadaire |
|---|---|---|---|
| Base | 2026-10-26 à 2026-12-20 | Volume aérobique, rechargement du tendon, force 2x | 4 h 30 à 6 h, 600 à 1 200 m D+ |
| Build 1 | 2026-12-28 à 2027-03-07 | Force en escalade, seuil, longues escalades | 6 à 8 h, 1 500 à 2 500 m D+ |
| Build 2 | 2027-03-08 à 2027-05-02 | Spécificité de course, longues journées, descentes (si autorisées) | 7 à 9 h, 2 000 à 3 000 m D+ |
| Taper | 2027-05-24 à 2027-06-11 | Volume réduit d'environ la moitié sur 2,5 semaines, garder une certaine intensité | 3 à 5 h |
| Course | 2027-06-12 | | |

Une semaine plus légère (environ 70 % de la précédente) toutes les quatre semaines : la suivante est la semaine 8, débutant le 2026-12-14.

## Prochaines 7 jours

Les zones sont les zones de fréquence cardiaque de `coach_zones_and_paces` (zone 2 = 70-80 % de max). Le plafond d'aujourd'hui
provenant de la briefing l'annule toujours.

| Date | Jour | Séance | Durée | Zone | Notes |
|---|---|---|---|---|---|
| 2026-11-17 | Mar | Course facile, boucle en côte | 55 min | 2 | Marche les parties pentues, pas de descente au-dessus de 300 m |
| 2026-11-18 | Mer | Repos | | | |
| 2026-11-19 | Jeu | Course avec 6 x 3 min en zone 4 en montée | 60 min | 2 + 4 | Skip the intervals if the ceiling is "easy" |
| 2026-11-20 | Ven | Force : jambes et tronc | 45 min | | Levées de mollets, fentes, soulevé de terre monobras |
| 2026-11-21 | Sam | Course longue en trail | 2 h 15 | 2 | Environ 900 m D+, alimentation toutes les 30 min |
| 2026-11-22 | Dim | Course facile | 45 min | 1-2 | Plat, terrain souple |
| 2026-11-23 | Lun | Force : haut du corps et tronc | 45 min | | |

## Règles d'ajustement

- Plafond "easy" ou "rest" : remplacez la séance par une facile (zone 1-2, moitié de la durée) ou par du repos.
  Ne compenser jamais une séance annulée le jour suivant.
- Plafond "moderate" : gardez la séance, supprimez les intervalles.
- Douleur d'Achille au-dessus de 3/10, ou tout symptôme de maladie : arrêtez et signalez-le avant tout autre chose.
- Si deux séances consécutives sont remplacées, la revue hebdomadaire réduit la semaine suivante au lieu de compenser.

## Journal des changements

- 2026-11-16 : HRV trend below the personal range for 6 days; replaced Monday's 70-minute run by
  rest, and moved the intervals from Tuesday to Thursday.
- 2026-11-15 : Week 3 completed as planned (5 h 10, 740 m D+).
