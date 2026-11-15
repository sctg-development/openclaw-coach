# CAHIER DES CHARGES TECHNIQUE ET FONCTIONNEL
## Plugin OpenClaw « OpenClaw Coach » 2 — moteur de récupération, de charge et de coaching sur données Garmin

---

**Version du document :** 2.0.0 (2026-11-15) — remplace la version 1.1.0
**Statut :** spécification de la version 2.0.0 **implémentée** dans ce dépôt (branche `v2`), tests verts sur données synthétiques, **non encore exécutée contre un compte Garmin réel**
**Ingestion :** `garmin-cli` (`gc`) ≥ 0.4.0, commande `gc daily` ajoutée pour ce projet
**Plateforme hôte :** OpenClaw (SDK de plugin ≥ 2026.8.2)
**Langages :** TypeScript (ESM, TypeBox) pour le plugin ; Python pour `garmin-cli`
**Documents liés :** `docs/SCIENCE.md` (formules, preuves, limites, bibliographie vérifiée, recommandations de LLM) ; `skills/coach/SKILL.md` (comportement du coach) ; `v2/bevel/` (analyse concurrentielle)

> **Ce qui change par rapport à la version 1.1.0 de ce document.** La version précédente cadrait bien
> le périmètre et les risques, mais restait presque muette sur l'essentiel : *quels calculs* faire sur la
> VFC, la fréquence cardiaque de repos, le sommeil, la respiration, la SpO2, la température et la charge.
> Elle repoussait tout score « à plus tard, faute de calibration ». Cette version tranche : chaque signal
> a un modèle publié, une ligne de base individuelle, un statut de calibration et une limite écrite. Les
> scores sans modèle publié (âge biologique, banque d'énergie, fraîcheur musculaire) restent hors
> périmètre, pour une raison explicite. La liste des écarts avec la version 1.1.0 est en annexe A.

---

## 1. Vision et positionnement

### 1.1 Thèse

Les applications de référence (Bevel, Whoop, Oura) transforment des signaux de capteurs en scores de
récupération, d'effort et de sommeil. Leur valeur tient à trois choses : une **ligne de base
individuelle**, une **synthèse actionnable** le matin, un **assistant** qui explique. Leurs défauts sont
connus : formules non publiées, donc non vérifiables ; données hébergées chez un tiers ; abonnement.

OpenClaw Coach 2 reprend les trois forces et corrige les trois défauts :

1. **Les mêmes signaux, avec des formules publiées.** Tout calcul est une fonction testée, documentée
   et sourcée. Quand la littérature ne fournit pas de modèle, le plugin ne fabrique pas de score.
2. **Le code calcule, le LLM interprète.** Le modèle de langage ne reçoit jamais de séries brutes et ne
   fait aucune arithmétique ; il reçoit des résultats compacts (environ 1 300 jetons pour le bilan du
   jour) avec leur statut et leurs références.
3. **Les données restent sur l'instance.** Un fichier local d'agrégats quotidiens ; rien d'autre que ce
   que l'agent envoie à son fournisseur de LLM.

Bevel reste une source d'inspiration fonctionnelle. Le plugin n'en reprend ni la marque, ni les noms de
scores, ni des formules supposées.

### 1.2 Décisions d'architecture

| Sujet | Décision | Conséquence |
|---|---|---|
| Identité | Paquet `@sctg/openclaw-coach`, plugin `coach`, outils `coach_*`, version 2.0.0 | Rupture assumée avec la 0.1.0 : `coach_garmin_digest` disparaît (remplacé par `coach_daily_briefing`). |
| Calculs | Modèles déterministes dans `src/science/`, versionnés un par un | Chaque résultat porte `algorithm.id`, `algorithm.version`, `refs`. |
| Référence | Ligne de base individuelle robuste sur 60 jours | Aucun seuil de population sur les signaux autonomes. |
| Statut des données | `ready` / `calibrating` / `insufficient_data` sur chaque bloc | Jamais de score inventé, jamais de zéro à la place d'une absence. |
| Historique | Stockage local JSON, alimenté par `gc daily` | Nécessaire : les lignes de base demandent 60 à 180 jours. |
| Scores Garmin | Restitués à part, sous leur nom | Jamais recombinés dans un score maison. |
| Écritures | Journal local ; création de séance Garmin désactivée par défaut, aperçu puis confirmation | Aucun effet externe sans accord explicite. |
| Planification | Automatisations OpenClaw | Le plugin n'embarque pas d'ordonnanceur. |
| Périmètre médical | Coaching d'un adulte sportif en bonne santé | Pas de diagnostic, pas de dépistage, pas de prescription. |

### 1.3 Architecture

```
 Montre Garmin ──► Garmin Connect
                        │
                        ▼
 garmin-cli (gc ≥ 0.4.0)
   gc daily --start --end        agrégats quotidiens compacts (VFC, FC repos, sommeil,
                                 respiration, SpO2, température, stress, Body Battery)
   gc activities ...             liste et détail des activités
   gc metrics ...                scores Garmin, seuil lactique
                        │  JSON, execFile sans shell, codes d'erreur stables
                        ▼
 Plugin openclaw-coach
   src/garmin/     exécution de gc, normalisation des charges utiles
   src/sync.ts     rattrapage d'historique, cache, jours récents
   src/store.ts    stockage local (agrégats, activités, journal)
   src/profile.ts  ancrages de l'athlète (FCmax, FC repos, seuil, besoin de sommeil)
   src/science/    modèles : hrv, recovery, sleep, load, readiness, performance,
                   strength, associations, healthspan, stats
   src/tools.ts    dix outils coach_*
                        │  résultats compacts, statuts, références
                        ▼
 Agent OpenClaw + skill « coach » + ATHLETE.md / PLAN.md
   interprétation, décision, dialogue, mise à jour du plan
```

---

## 2. Ingestion : `garmin-cli`

### 2.1 Commande ajoutée : `gc daily`

La version 0.3.1 obligeait à un appel par signal et par jour, avec des charges utiles volumineuses
(plusieurs dizaines de kilooctets pour une nuit). Constituer 90 jours d'historique aurait demandé des
centaines d'appels. `gc daily` (version 0.4.0) produit **un enregistrement compact par jour** :

```bash
gc daily today
gc daily --start 2026-08-18 --end 2026-09-14            # plages : 3 requêtes Garmin pour 28 jours
gc daily --start 2026-11-10 --end 2026-11-15 --detail   # + détail par jour, 14 jours au plus
gc daily yesterday --keys                               # chemins des clés brutes, sans aucune valeur
```

- **Mode plage** (par défaut au-delà de 14 jours) : statistiques de sommeil, VFC et FC de repos par
  plage de dates ; trois requêtes Garmin pour 28 jours.
- **Mode détail** (par défaut jusqu'à 14 jours) : ajoute, par jour, la nuit détaillée, la VFC du jour et
  le résumé quotidien (stress, Body Battery, SpO2, respiration diurne, activité).
- **Sonde `--keys`** : imprime les chemins de clés des charges utiles brutes sans aucune valeur, pour
  vérifier le contrat sur un appareil donné sans exposer de donnée de santé.
- Une erreur sur un signal n'interrompt pas les autres ; elle est rapportée par code (`auth`,
  `rate_limited`, `connection`, `error`). Une session expirée interrompt tout.

### 2.2 Contrat de l'enregistrement quotidien (`schemaVersion: 1`)

Tous les champs sont nullables. Une section entièrement vide vaut `null`.

| Section | Champs | Unité |
|---|---|---|
| `sleep` | `startGmt`, `endGmt`, `startLocal`, `endLocal`, `durationS`, `deepS`, `lightS`, `remS`, `awakeS`, `napS`, `awakeCount`, `score`, `needS`, `avgStress`, `avgHr` | ISO 8601, secondes |
| `hrv` | `lastNightAvgMs`, `lastNight5MinHighMs`, `weeklyAvgMs`, `status`, `baselineLowUpperMs`, `baselineBalancedLowMs`, `baselineBalancedUpperMs` | ms (rMSSD) |
| `restingHr` | — | bpm |
| `respiration` | `sleepAvg`, `sleepLow`, `sleepHigh`, `wakingAvg` | cycles/min |
| `spo2` | `sleepAvg`, `sleepLow`, `dayAvg`, `dayLow` | % |
| `skinTempDeviationC` | — | °C, écart à la norme personnelle |
| `stress` | `avg`, `max`, `restS`, `lowS`, `mediumS`, `highS` | indice Garmin, secondes |
| `bodyBattery` | `high`, `low`, `charged`, `drained`, `sleepChange` | indice Garmin |
| `activity` | `steps`, `activeKcal`, `bmrKcal`, `moderateMin`, `vigorousMin`, `floorsUp` | — |
| `heartRate` | `min`, `max` | bpm |
| `sources`, `errors` | provenance et erreurs par signal | — |

Règles : chaque champ est cherché sous plusieurs noms (les charges utiles varient selon l'appareil) ;
les marqueurs Garmin « pas de valeur » (≤ 0) deviennent `null` ; l'heure locale Garmin est rendue sans
suffixe de fuseau ; un écart de température en °F est converti par le facteur 5/9 seul.

### 2.3 Matrice signal → commande → usage

| Signal de la montre | Commande | Modèle qui l'exploite |
|---|---|---|
| VFC nocturne (rMSSD) | `gc daily` | VFC, récupération, alerte précoce, décision, journal |
| FC de repos | `gc daily` | récupération, alerte précoce, charge (FC de réserve), santé |
| Durée et horaires de sommeil | `gc daily` | sommeil (suffisance, dette, régularité), récupération, décision |
| Stades de sommeil | `gc daily` | restitués, non notés |
| Fréquence respiratoire nocturne | `gc daily` | récupération, alerte précoce |
| SpO2 nocturne | `gc daily` | alerte précoce (signal secondaire), note prudente |
| Température cutanée | `gc daily` | récupération, alerte précoce |
| Stress, Body Battery | `gc daily --detail` | restitués |
| Minutes d'intensité | `gc daily --detail` | marqueurs de santé |
| Activités (durée, FC, temps par zone, dénivelé, charge Garmin, VO2max) | `gc activities --start --end` | charge, distribution d'intensité, FCmax observée |
| Tours, zones et météo d'une activité | `gc activities splits / hr-zones / weather` | analyse d'activité |
| Séries de musculation | `gc activities exercise-sets` | musculation |
| Seuil lactique | `gc metrics lactate-threshold` | zones |
| Training Readiness, Training Status, VO2max | `gc metrics training-readiness / training-status` | restitués pour comparaison |
| Création de séance | `gc workouts create --name --sport --steps` | `coach_workout_push` |

### 2.4 Résilience et sécurité d'exécution

- `execFile` avec arguments séparés, jamais de shell ; identifiants d'activité validés (`^\d{1,20}$`),
  dates validées, cibles de séance validées par expression régulière ; aucune commande libre venant du LLM.
- Délai d'exécution (30 s, 90 s pour les plages), tampon borné, trois appels simultanés au plus.
- Erreurs ramenées à des codes stables (`not_configured`, `auth`, `rate_limited`, `timeout`,
  `unsupported`, `parse_error`, `connection`, `error`), sans sortie de commande.
- Après `auth`, `not_configured` ou `unsupported`, la synchronisation s'arrête et l'outil répond à partir
  du stockage local.

---

## 3. Moteurs de calcul

Le détail (formules complètes, constantes, niveau de preuve, limites, bibliographie) est dans
`docs/SCIENCE.md`. Ce chapitre fixe ce qui est exigé de chaque moteur.

### 3.0 Ligne de base individuelle

Fenêtre de 60 jours précédant le jour évalué ; centre = médiane ; dispersion = écart absolu médian ×
1,4826 (à défaut écart interquartile / 1,349), avec un plancher par signal ; 14 nuits au minimum, sinon
`calibrating`. Tous les écarts sont exprimés en score z par rapport à cette ligne de base.

### 3.1 Variabilité de la fréquence cardiaque (`hrv-baseline`)

- Transformation ln rMSSD ; tendance = moyenne glissante sur 7 jours (au moins 3 nuits).
- Plage normale = ligne de base ± 0,5 dispersion (plus petit changement notable).
- Sorties : position de la tendance (`below` / `within` / `above`), écart aigu de la dernière nuit,
  coefficient de variation sur 7 jours comparé à l'habituel, variation sur une semaine, nombre de jours
  consécutifs sous la plage.
- Exigence : une nuit isolée ne change pas la tendance ; une nuit manquante n'est pas un zéro.

### 3.2 Indice de récupération (`recovery-index`)

Indice 0–100 = 100 × Φ(moyenne pondérée de scores z orientés et bornés) :

| Composante | Poids |
|---|---|
| VFC (ln rMSSD) | 0,40 |
| FC de repos | 0,20 |
| Sommeil (durée / besoin) | 0,25 |
| Fréquence respiratoire (pénalisante seulement si élevée) | 0,075 |
| Température cutanée (pénalisante seulement si élevée) | 0,075 |

50 = nuit typique de l'athlète ; bandes basse / moyenne / haute à 34 et 67. Les composantes et la part
de poids disponible sont toujours renvoyées. **Les poids sont un choix de conception documenté, non
validé** : ils ne doivent pas être présentés comme équivalents à un score commercial.

### 3.3 Alerte précoce (`early-warning`)

Coïncidence, la même nuit, d'au moins deux écarts : FC de repos (z ≥ 2 et ≥ +3 bpm), VFC (z ≤ −2),
fréquence respiratoire (z ≥ 2 et ≥ +0,8), température (z ≥ 2 et ≥ +0,5 °C), SpO2 (z ≤ −2 et ≤ −2
points). Niveaux `none` / `watch` / `elevated`, drapeau `persistent` au deuxième jour. Sortie
accompagnée de la liste des causes banales. **Ce n'est pas un test diagnostique.**

### 3.4 Sommeil (`sleep-balance`)

- Besoin : valeur de Garmin si elle est fournie et plausible, sinon valeur configurée (8 h par défaut).
- Suffisance, efficacité, stades restitués sans notation.
- Dette : solde courant sur 14 nuits, plancher à zéro.
- Régularité : indice de régularité du sommeil calculé sur la période de sommeil principale, écart-type
  des heures de coucher, de lever et du milieu de sommeil, décalage social.

### 3.5 Charge d'entraînement (`training-load`)

- Charge de séance : TRIMP de Banister, appliqué zone par zone quand le temps par zone est connu, sinon
  à la FC moyenne ; coefficients selon le sexe. Score d'Edwards et charge Garmin renvoyés à côté.
- Condition (constante de temps 42 jours), fatigue (7 jours), forme = condition − fatigue de la veille.
- Indicateurs : monotonie, contrainte, variation hebdomadaire, ratio aigu/chronique découplé (descriptif,
  **jamais présenté comme un risque de blessure**), distribution d'intensité, indice de polarisation.
- **Projection** d'un plan (charges, ou durée et zone) pour vérifier une montée en charge ou un affûtage.
- Exigence : un jour hors de l'historique connu n'est pas un jour de repos ; une séance sans FC est
  comptée à part.

### 3.6 Décision du jour (`readiness-decision`)

Plafond d'intensité `rest` / `easy` / `moderate` / `hard`. Départ à `hard`, chaque règle ne peut
qu'abaisser : symptômes déclarés, alerte précoce, tendance de VFC sous la plage normale (règle de
l'entraînement guidé par la VFC, seule règle issue d'essais randomisés), indice de récupération bas,
nuit courte, dette de sommeil, pic de charge, monotonie, notes de bien-être basses. Sorties : plafond,
règles appliquées, confiance, réserves (dont « demander le ressenti » en l'absence de saisie), plage de
charge indicative. **C'est un plafond, pas une prescription.**

### 3.7 Analyse d'activité, zones et allures

- Allure ajustée à la pente (coût énergétique de Minetti), découplage aérobie entre les deux moitiés
  d'un effort continu, efficacité, drapeaux (chaleur, dérive, parcours vallonné).
- FCmax : mesurée, sinon 98ᵉ centile observé, sinon formule de Tanaka ; trois tables de zones (seuil,
  réserve, FCmax) ; VDOT, allures d'entraînement et équivalences sur route (Daniels, Riegel).

### 3.8 Musculation (`strength-summary`)

Volume, meilleure série, 1RM estimée (Epley et Brzycki, 1 à 10 répétitions), séries par groupe
musculaire. Descriptif. Pas de score de fraîcheur musculaire.

### 3.9 Journal et associations (`habit-associations`)

Saisie quotidienne : ressenti (fatigue, courbatures, humeur, sommeil perçu, stress, de 1 à 5), RPE de
séance, symptômes, habitudes (étiquettes booléennes ou quantités). Comparaison des nuits « après avec »
et « après sans » : effectifs, différence, intervalle de confiance par bootstrap, taille d'effet,
valeur p par permutation, ajustement pour comparaisons multiples ; 5 nuits au minimum par groupe.
**Association observée, jamais causalité.**

### 3.10 Marqueurs de santé à long terme (`healthspan-markers`)

Activité hebdomadaire et renforcement (repères OMS), VO2max estimé, FC de repos, durée et régularité du
sommeil, chacun avec son repère publié. **Aucun âge biologique.**

### 3.11 Hors périmètre de la version 2.0, et pourquoi

| Fonction | Statut | Condition pour l'ouvrir |
|---|---|---|
| Âge biologique | exclu | Le modèle publié (PhenoAge, Levine 2018) exige neuf biomarqueurs sanguins. Envisageable seulement comme calculateur séparé, sur saisie manuelle validée, avec avis médical. |
| Banque d'énergie intrajournalière | exclu | Séries intrajournalières et modèle validé ; le Body Battery Garmin est restitué. |
| Fraîcheur musculaire | exclu | Aucun modèle publié ; la montre ne mesure pas la proximité de l'échec. |
| Cycle menstruel | phase ultérieure, sur demande | Activation séparée, donnée sensible ; modèle d'ajustement des lignes de base à valider. |
| Nutrition | phase ultérieure | Modèle de données, consentement, rétention ; pas de recommandation clinique. |
| Bilans sanguins | exclu | Interprétation clinique ; hors données de la montre. |
| Ajustement individuel des constantes (42/7 jours, poids de récupération) | phase ultérieure | Six mois d'historique et de ressenti ; critère de performance régulier. |
| Charge mécanique (dénivelé négatif, musculation) | phase ultérieure | Indicateur à définir avec un avis de science du sport. |

---

## 4. Plugin OpenClaw

### 4.1 Outils

| Outil | Effet | Paramètres principaux | Sortie |
|---|---|---|---|
| `coach_daily_briefing` | lecture, écrit le stockage local | `date`, `sync` | décision, récupération, VFC, sommeil, alerte, charge, scores Garmin, séances d'hier et du jour, journal, profil |
| `coach_trends` | lecture | `days` (14–365), `includeDaily`, `sync` | agrégats hebdomadaires, VFC, sommeil, charge, marqueurs de santé |
| `coach_training_load` | lecture | `plan[]` (date ; charge, ou durée et zone), `sync` | modèle de charge, séances récentes, courbe hebdomadaire, projection |
| `coach_activity_deep_dive` | lecture | `activityId` | charge, zones, tours, découplage, météo, drapeaux |
| `coach_zones_and_paces` | lecture | `raceDistanceM`, `raceTimeS`, `targetDistanceM` | tables de zones, VDOT, allures, équivalences |
| `coach_strength_analysis` | lecture | `activityId` | exercices, volume, 1RM estimée |
| `coach_journal_log` | **écriture locale** | `date`, `tags`, `rpe`, notes de bien-être, `symptoms`, `notes` | entrée enregistrée |
| `coach_journal_insights` | lecture | `days` | associations, étiquettes insuffisantes, réserves |
| `coach_workout_push` | **écriture Garmin** | `name`, `sport`, `steps[]`, `confirm` | aperçu, ou identifiant de la séance créée |
| `coach_data_status` | lecture | `sync` | couverture, erreurs, ancrages, conseils de configuration |

Règles communes : sortie JSON compacte ; erreur d'entrée expliquée au modèle (`invalid_input`) ; erreur
interne sans détail technique ; un seul accès au stockage à la fois.

`coach_workout_push` : désactivé tant que `allowWorkoutPush` n'est pas `true` ; sans `confirm`, ne
renvoie qu'un aperçu (durée, charge estimée) ; 60 étapes au plus ; ne programme pas la séance à une date.

### 4.2 Configuration

`gcBinary`, `timezone`, `dataDir`, `historyDays` (90), `loadHistoryDays` (180), `retentionDays` (730),
`cacheMinutes` (15), `sex`, `birthYear`, `hrMax`, `hrRest`, `lthr`, `sleepNeedHours` (8),
`hrZoneFloorsPctMax` ([50, 60, 70, 80, 90]), `allowWorkoutPush` (`false`). Toute valeur invalide est
ignorée au profit de la valeur par défaut. Minimum recommandé : `timezone`, `sex`, `hrMax` mesurée.

### 4.3 Synchronisation et stockage

- **Premier appel** : 90 jours de signaux en plages de 28 jours, les deux derniers jours en détail, 180
  jours d'activités : environ 25 requêtes Garmin.
- **Ensuite** : seuls aujourd'hui et hier sont rafraîchis, au plus toutes les 15 minutes ; un jour vu
  alors qu'il était en cours est relu une fois terminé ; la dernière semaine d'activités est relue.
- **Stockage** : un fichier `coach-store.json` (répertoire en 0700, fichier en 0600, écriture atomique)
  contenant agrégats quotidiens, activités réduites, journal, seuil lactique. Ni séries intrajournalières,
  ni traces GPS, ni identifiants. Purge au-delà de `retentionDays`. Un fichier illisible arrête l'outil
  au lieu d'être écrasé.

### 4.4 Fichiers du workspace

`ATHLETE.md` (profil, ancrages mesurés, objectif, blessures et contraintes, disponibilité) et `PLAN.md`
(plan en cours) restent tenus par l'athlète et l'agent ; le plugin ne les lit ni ne les écrit. Les
contraintes d'`ATHLETE.md` priment sur toute sortie du plugin.

---

## 5. Skill `coach`

`skills/coach/SKILL.md` définit le comportement de l'agent :

1. **Partage des rôles** : les outils calculent, l'agent interprète ; ne jamais recalculer, estimer ou
   « corriger » un chiffre.
2. **Règles de sécurité** : contraintes d'`ATHLETE.md` impératives ; symptômes avant signaux (douleur
   thoracique, malaise, essoufflement anormal : arrêt et avis médical immédiat) ; pas de diagnostic ;
   option réversible en cas de doute ; poids, alimentation et cycle seulement à l'initiative de l'athlète.
3. **Lecture de chaque bloc** : plafond, VFC (tendance, pas la nuit), récupération (regarder les
   composantes), alerte précoce, sommeil, charge, scores Garmin en comparaison.
4. **Déroulés** : bilan quotidien (aujourd'hui, pourquoi, à surveiller, données manquantes), revue
   hebdomadaire, construction de plan avec **projection obligatoire**, analyse de séance, journal,
   création de séance en deux temps.
5. **Ton** : direct, chiffres toujours avec leur référence personnelle, séparation mesuré / inféré /
   recommandé, langue de l'athlète.

---

## 6. Automatisations

Le plugin ne crée aucune tâche. Recettes (syntaxe à vérifier avec `openclaw automations --help`) :

| Automatisation | Quand | Consigne |
|---|---|---|
| Bilan du matin | chaque jour, après l'heure de lever habituelle | lire `ATHLETE.md` et `PLAN.md`, appeler `coach_daily_briefing`, répondre en quelques lignes ; demander le ressenti s'il manque |
| Revue hebdomadaire | dimanche soir | `coach_trends` et `coach_training_load`, comparer au plan, proposer la semaine suivante **après projection**, mettre à jour `PLAN.md` |
| Point mensuel (facultatif) | premier lundi du mois | marqueurs de santé, régularité du sommeil, associations du journal |

Le bilan du matin dépend de la synchronisation de la montre : planifié trop tôt, il verra la nuit comme
absente (`insufficient_data`), ce que l'agent doit dire.

---

## 7. Recommandations de LLM

Détail et protocole d'acceptation en 15 cas dans `docs/SCIENCE.md`, section 8. En résumé :

- Capacités déterminantes : appel d'outils fiable, respect durable des règles de sécurité, fidélité aux
  chiffres, prise en compte des statuts. La connaissance médicale brute compte moins, puisque le calcul
  est fait par le plugin.
- Bilan quotidien et coaching courant : Claude Opus 5.5 (`claude-opus-5-5`), effort moyen ; à coût
  réduit, Claude Sonnet 5.5 (`claude-sonnet-5-5`).
- Plans de plusieurs mois et cas complexes : Claude Fable 5.2 (`claude-fable-5-2`), en tenant compte de
  sa rétention de données de 30 jours.
- Petits modèles et modèles locaux : seulement après réussite du protocole d'acceptation ; un modèle
  local est la seule configuration sans transmission de données de santé à un tiers.

---

## 8. Livraison, tests, vérification

### 8.1 État de la livraison

| Lot | État |
|---|---|
| `garmin-cli` 0.4.0 : `gc daily`, sonde `--keys`, 11 tests | fait (branche `feat/daily-export`) |
| Plugin 2.0.0 : dix outils, dix modules de calcul, stockage, synchronisation, 38 tests | fait (branche `v2`) |
| Skill, README, documentation scientifique | fait |
| **Validation sur compte Garmin réel** | **à faire** |
| Relecture scientifique et médicale | à faire (questions en section 7 de `docs/SCIENCE.md`) |

### 8.2 Recette sur données réelles (dans l'ordre)

1. `gc daily yesterday --keys` dans l'environnement du Gateway : comparer les chemins de clés à ceux
   attendus par `garmin-cli/src/garmincli/daily.py` (température cutanée, besoin de sommeil,
   statistiques par plage sont les plus incertains).
2. `gc daily --start <J−27> --end <J>` : vérifier que VFC, sommeil et FC de repos sont remplis.
3. `coach_data_status` avec `sync: true` : couverture par signal, erreurs, ancrages retenus.
4. `coach_daily_briefing` : comparer les valeurs brutes à l'application Garmin Connect (VFC de la nuit,
   FC de repos, durée de sommeil, séances de la veille).
5. `coach_activity_deep_dive` sur une sortie connue : unité de la température, tours, zones.
6. Après deux semaines : part de jours en bande basse, fréquence des alertes, cohérence avec le
   ressenti noté au journal.

### 8.3 Critères de validation

Tests de formules contre des valeurs publiées ou calculées à la main ; données nulles et partielles ;
historique insuffisant ; fuseaux et changement d'heure ; session expirée ; commande absente ; charge
utile invalide ; stockage corrompu ; identifiants et cibles hostiles ; écriture Garmin seulement si
activée et confirmée ; permissions du fichier. `npm run typecheck`, `npm test`, `npm run build` ;
`make lint` et `make test` côté `garmin-cli`.

### 8.4 Risques

| Risque | Mesure |
|---|---|
| Noms de champs Garmin différents sur l'appareil réel | recherche sous plusieurs noms, sonde `--keys`, recette 8.2 |
| Limitation de débit de Garmin | plages de dates, cache, trois appels simultanés au plus |
| Score pris pour un avis médical | statuts, réserves, règles du skill, aucune sortie diagnostique |
| Fausse alerte anxiogène | deux signaux exigés, causes banales listées, un signal isolé sans effet |
| FCmax estimée par l'âge | signalée dans chaque résultat de charge, valeur mesurée demandée |
| Écriture non voulue dans Garmin Connect | désactivée par défaut, aperçu, confirmation explicite |
| Données de santé transmises au fournisseur du LLM | sorties agrégées, `includeDaily` désactivé par défaut, choix du fournisseur documenté |
| Mono-athlète | une instance par athlète ; le multi-utilisateur demanderait un cloisonnement du stockage et des sessions Garmin |

---

## Annexe A — Écarts avec la version 1.1.0 de ce document

| Version 1.1.0 | Version 2.0.0 | Raison |
|---|---|---|
| « Pas de score maison tant qu'il n'est pas calibré » | Indice de récupération calculé, avec statut `calibrating` et composantes exposées | La calibration est individuelle (ligne de base), et le statut dit quand elle manque. |
| Pondération 45/25/20/10 « à étudier » | 40/20/25/7,5/7,5, bornes asymétriques, conversion par la loi normale | Formule complète et testée ; poids toujours déclarés comme choix de conception. |
| Ligne de base « 21 jours, moyenne et écart-type » | 60 jours, médiane et écart absolu médian, planchers | Robustesse aux nuits atypiques ; usage des travaux en conditions réelles. |
| Charge cardio « expérimentale, formule exponentielle non définie » | TRIMP de Banister par zone, condition, fatigue, forme, projection | Modèle publié depuis 1975–1991. |
| Aucun traitement de la respiration, de la SpO2, de la température | Composantes de la récupération et de l'alerte précoce | Demande d'origine du projet. |
| Dette de sommeil citée sans définition | Solde courant sur 14 nuits, régularité, décalage social | Définitions explicites. |
| « Pas de base locale dans le MVP » | Fichier JSON local | Les lignes de base l'exigent ; pas de SQLite, pas de migration. |
| Schéma SQL indicatif (nutrition, biomarqueurs) | supprimé | Hors périmètre ; la clé étrangère y était d'ailleurs fausse. |
| Outils `coach_log_nutrition`, `coach_query_biomarkers` | supprimés | Hors périmètre. |
| `coach_strength_analysis` avec `muscularLoadScore`, `muscleFatigueImpact`, repos recommandé | Volume, 1RM estimée, séries par groupe | Les champs supprimés n'avaient pas de modèle. |
| `coach_garmin_digest` conservé | remplacé par `coach_daily_briefing` | Les charges utiles brutes saturaient le contexte. |
| Skill nommé `bevel` dans l'exemple | Skill `coach` | Pas de marque tierce. |
| Automatisation « âge biologique du lundi » | Point mensuel sur les marqueurs de santé | Pas d'âge biologique. |
| Aucune recommandation de LLM | Section 7 et protocole d'acceptation | Demande d'origine du projet. |

## Annexe B — Correspondance avec les fonctions de Bevel

| Fonction de Bevel | Réponse d'OpenClaw Coach 2 |
|---|---|
| Score de récupération | Indice de récupération et ses composantes |
| Ligne de base personnalisée | Ligne de base robuste sur 60 jours |
| Dette et besoin de sommeil | Suffisance, dette (solde courant), régularité |
| Effort cardio et cible d'effort | TRIMP, condition, fatigue, forme ; plafond du jour et plage de charge indicative |
| Banque d'énergie, stress | Body Battery et stress Garmin restitués |
| Musculation : charge et fraîcheur | Volume et 1RM estimée ; pas de fraîcheur |
| Journal et « corrélations causales » | Journal et associations avec intervalles de confiance, sans causalité |
| Âge biologique | Marqueurs de santé un par un |
| Bilans sanguins, nutrition, cycle | Hors périmètre de la version 2.0 |
| Assistant proactif, plans | Skill `coach`, automatisations OpenClaw, projection de plan |
| Séances envoyées à la montre | `coach_workout_push`, après confirmation |
| Réveils intelligents, widgets, application de montre | Hors de portée d'un plugin serveur |
