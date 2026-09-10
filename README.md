# Planning M2 BTI

Emploi du temps global du Master 2 BTI (STAPS · PolyTech · ECM), avec vues
personnalisées par profil, navigation semaine par semaine, indicateur de
l’heure actuelle et espace constructeur pour modifier le planning.

**Excel = source de vérité**. Le fichier `data/planning.xlsx` est parsé au
démarrage ; les modifications faites depuis l’espace constructeur sont
persistées séparément dans `data/overrides.json` et appliquées par-dessus.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Stack technique](#stack-technique)
- [Structure du projet](#structure-du-projet)
- [Démarrer en local](#démarrer-en-local)
- [Variables d’environnement](#variables-denvironnement)
- [Espace constructeur](#espace-constructeur)
- [Modèle de données](#modèle-de-données)
- [Format du fichier Excel](#format-du-fichier-excel)
- [Déploiement sur Render](#déploiement-sur-render)
- [Scripts utiles](#scripts-utiles)

## Fonctionnalités

- Vue **semaine complète** (lundi → vendredi, 8 h → 18 h) sur ordinateur.
- Vue **mobile** avec un jour à la fois, swipe entre jours puis semaines.
- **Barre bleue** de l’heure actuelle, positionnée au pixel près, mise à jour
  chaque minute — ne s’affiche que sur le jour du jour.
- **Détection automatique** de la semaine courante à l’ouverture.
- **Sélecteur de semaine** (bouton précédent/suivant, « Aujourd’hui »,
  `<input type="week">`).
- **Profils** : filtrage par groupe / origine (BTI, STAPS, PolyTech, ECM,
  Clinicien, sous-groupes A/B/C/D).
- **Pill « en cours »** et **« prochain cours »** en tête de page.
- **Modale détail** du cours (professeur, salle, groupes, notes).
- **Espace constructeur** protégé par mot de passe (`/constructeur`) :
  - CRUD complet des cours ;
  - répétition sur plusieurs semaines via sélection cliquer-glisser ;
  - suppression individuelle ;
  - diff Excel ↔ site ;
  - rechargement de l’Excel ;
  - remise à zéro des overrides.
- **Validation** (heure de fin > début, jour valide, groupes non vides…).
- Fonctionne sans build step, sans dépendance native.

## Stack technique

- **Backend** : Node.js ≥ 18, Express 4, ExcelJS, cookie-parser.
- **Frontend** : HTML/CSS/JS vanilla (modules ES natifs), aucun framework,
  aucun bundler.
- **Stockage** : JSON sur disque (`data/overrides.json`) — persistance
  simple, portable, adaptée à un disque persistant Render.

## Structure du projet

```
Calendrier-BTI/
├── client/
│   ├── admin/           # Espace constructeur (/constructeur)
│   │   ├── admin.css
│   │   ├── admin.js
│   │   └── index.html
│   ├── css/app.css
│   ├── js/
│   │   ├── api.js
│   │   ├── app.js       # Bootstrap et logique UI
│   │   ├── calendar.js  # Rendu de la grille
│   │   └── dates.js
│   └── index.html
├── data/
│   ├── planning.xlsx    # Source de vérité (dans le repo)
│   ├── planning-cache.json  # Généré au démarrage (git-ignoré)
│   └── overrides.json       # Modifications admin (git-ignoré)
├── scripts/
│   ├── import-excel.js  # Régénère planning-cache.json
│   └── diff-excel.js    # Affiche les différences Excel ↔ site
├── server/
│   ├── lib/
│   │   ├── auth.js
│   │   ├── excel-parser.js
│   │   └── store.js
│   ├── routes/api.js
│   └── server.js
├── package.json
├── render.yaml
└── README.md
```

## Démarrer en local

```bash
git clone https://github.com/Emmanuel-creat/Calendrier-BTI.git
cd Calendrier-BTI
npm install
CONSTRUCTOR_PASSWORD="motdepasse" npm start
```

Puis ouvrir <http://localhost:3000/>. L’espace constructeur est disponible sur
<http://localhost:3000/constructeur>.

Sous Windows PowerShell :

```powershell
$env:CONSTRUCTOR_PASSWORD="motdepasse"; npm start
```

Sous CMD :

```cmd
set CONSTRUCTOR_PASSWORD=motdepasse && npm start
```

## Variables d’environnement

| Nom                      | Défaut                          | Rôle                                             |
| ------------------------ | ------------------------------- | ------------------------------------------------ |
| `PORT`                   | `3000`                          | Port d’écoute.                                   |
| `CONSTRUCTOR_PASSWORD`   | *(non défini)*                  | Requis pour accéder à `/constructeur`.           |
| `DATA_DIR`               | `<repo>/data`                   | Dossier de stockage cache + overrides.           |
| `EXCEL_PATH`             | `<repo>/data/planning.xlsx`     | Chemin vers l’Excel source de vérité.            |
| `CACHE_PATH`             | `<DATA_DIR>/planning-cache.json`| Cache de l’Excel parsé.                          |
| `OVERRIDES_PATH`         | `<DATA_DIR>/overrides.json`     | Modifications constructeur.                      |
| `EXCEL_SHEET`            | `26_27_V5`                      | Feuille du classeur utilisée.                    |
| `NODE_ENV`               | *(non défini)*                  | En `production`, cookies sécurisés uniquement.   |

## Espace constructeur

L’URL `/constructeur` n’est pas linkée depuis l’interface publique. Elle
demande un mot de passe défini par `CONSTRUCTOR_PASSWORD`. La vérification a
lieu côté serveur (`server/lib/auth.js`) et un cookie HttpOnly `bti_admin`
maintient la session pendant 12 h avec un renouvellement à chaque requête.

Depuis l’espace :

- **＋ Nouveau cours** : formulaire complet + sélection multi-semaines.
- **Éditer** un cours : ouvre la modale avec la sélection sur sa semaine, la
  répétition ajoute des occurrences supplémentaires.
- **Supprimer** (ligne ou dans la modale) : n’affecte que cette occurrence.
- **Diff Excel** : montre ajouts, suppressions et modifications par rapport à
  l’Excel.
- **Recharger l’Excel** : re-lit `data/planning.xlsx` et régénère le cache
  (les overrides sont conservés).
- **Réinitialiser overrides** : ⚠ efface toutes les modifications admin.

## Modèle de données

Un **cours** est un objet :

```jsonc
{
  "id": "c_1z0p1r8",           // identifiant stable
  "weekStart": "2025-10-06",   // lundi de la semaine (aligné au calendrier réel)
  "date": "2025-10-08",        // date exacte du cours
  "dayOfWeek": 3,              // 1 = lundi, 5 = vendredi
  "day": "Mercredi",
  "startTime": "14:00",
  "endTime": "16:00",
  "title": "Biologie cellulaire et tissulaire",
  "teacher": "S Roffino",
  "room": "Salle 4 aile A Fac Pharmacie Campus Timone",
  "notes": "",
  "groups": ["BTI", "STAPS"],  // Groupes auxquels le cours s'adresse
  "color": "FFFA06B4",         // Couleur ARGB d'origine (utilisée pour le thème du bloc)
  "special": null,             // "vacances"/"ferie"/"revisions"/"examen"/…
  "origin": "excel"            // "excel" | "override" | "admin"
}
```

Les **groupes** utilisés :

- Origines : `BTI`, `STAPS`, `PolyTech`, `ECM`, `Clinicien`, `M1 BTI`.
- Sous-groupes : `Groupe A`, `Groupe B`, `Groupe C`, `Groupe D`.
- Étiquettes libres : n’importe quelle chaîne saisie côté constructeur.

Le filtre côté serveur (`matchesProfile`) considère qu’un cours étiqueté
« BTI » est commun à toute la promo (visible pour tout profil), sauf s’il
cite explicitement d’autres origines qui n’incluent pas le profil sélectionné.

## Format du fichier Excel

Le parseur cible la feuille `26_27_V5` (paramétrable via `EXCEL_SHEET`) qui
suit ce schéma :

- **Ligne 1** : entêtes de jour (`Lundi` en col D, `Mardi` en col O,
  `Mercredi` en col Z, `Jeudi` en col AK, `Vendredi` en col AV).
- **Ligne 2** : entêtes horaires (`DATE`, `8h-9h`, …, `17h-18h`) pour chaque
  bloc de jour.
- **Colonnes A/B** : dates de début / fin de la semaine.
- **Colonne C** : annotation (`semaine ECM`, `vacances sco`, …).
- **Lignes 3+** : une ligne = une semaine.

Un cours est une **cellule fusionnée** sur plusieurs créneaux horaires. Son
contenu est du texte multi-lignes ou séparé par `|` :

```
Titre du cours
Prénom NOM
(Salle)
```

Le parseur :

1. lit chaque cellule fusionnée et déduit le créneau (heure de début =
   colonne de la fusion, heure de fin = colonne finale + 1) ;
2. sépare titre, professeur et salle ;
3. détecte les groupes via la couleur de fond et le contenu texte
   (`STAPS`, `centrale`, `polytech`, `GROUPE A`, …) ;
4. **corrige** un décalage constaté dans le fichier V5 : la cellule « Lundi »
   contient parfois la date du dimanche précédent. Les dates de tous les
   cours sont réalignées sur le calendrier réel.

Les cellules `ok`, `?`, `→` sont considérées comme du bruit et ignorées.

Les cellules dont le contenu commence par `VACANCES`, `ferie`, `Jour de
révisions`, `EXAMEN`, `SOUTENANCES`, `RENCONTRES`, `Afterwork` sont marquées
comme événements spéciaux (`special`) et affichées différemment.

## Déploiement sur Render

1. Pousse le repo sur GitHub (`git push`).
2. Sur [Render](https://render.com), *New → Blueprint*, et choisis le repo.
   Le fichier `render.yaml` déclare :
   - un service web Node.js ;
   - un disque persistant monté sur `/var/data` (pour `overrides.json`) ;
   - un healthcheck sur `/healthz`.
3. Dans les **Environment Variables** du service, définis
   `CONSTRUCTOR_PASSWORD` (obligatoire — l’espace constructeur restera
   inaccessible sinon).
4. Déploie. Le healthcheck confirmera le démarrage.

> ⚠ Sur le plan **free**, Render n’offre pas de disque persistant : les
> overrides seront perdus à chaque redémarrage. Passe sur `starter` pour
> conserver le disque, ou monte une base Postgres à part si le volume de
> modifications le justifie.

Pour actualiser le planning source (Excel) :

- remplace `data/planning.xlsx` dans le repo ;
- commit + push ;
- le redéploiement recréera le cache automatiquement ;
- ou depuis l’espace constructeur : bouton **Recharger l’Excel**.

## Scripts utiles

```bash
npm run import   # (Re)génère data/planning-cache.json depuis l'Excel.
npm run diff     # Affiche les différences Excel ↔ overrides en console.
npm run dev      # Démarre le serveur avec `--watch` (rechargement à chaud).
```

---

Fait avec 💙 pour la promo M2 BTI 2026-2027.
