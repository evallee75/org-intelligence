# Org Intelligence

**Scanner open source de santé d'une org Salesforce** : inventaire des métadonnées, score de santé,
carte des automatisations et de leurs conflits, stockage, sécurité, adoption, utilisation des champs
— avec des recommandations priorisées et une roadmap de nettoyage.

> _Open-source Salesforce org health scanner: metadata inventory, health score, automation map and
> conflicts, storage, security audit, adoption and field usage, with prioritized recommendations.
> 100 % native, read-only, nothing leaves your org._

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Salesforce API 66.0](https://img.shields.io/badge/Salesforce%20API-66.0-00A1E0)

- **100 % natif Salesforce** : aucun service externe, aucune télémétrie, aucune donnée ne quitte l'org.
- **Lecture seule** : le socle n'ajoute aucun objet et n'écrit rien dans vos données. Les résultats
  sont gardés dans le navigateur de chaque utilisateur (export / import de fichiers pour partager).
- **Modulaire** : un socle et sept modules optionnels, à installer selon vos besoins.

## Installation

**Guide pas à pas (sandbox et production) : [docs/INSTALL.md](docs/INSTALL.md)** — aussi en
[PDF](docs/Org-Intelligence-Installation.pdf).

En résumé, avec le [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) et
[Node.js](https://nodejs.org) 18+ :

```bash
git clone https://github.com/evallee75/org-intelligence.git
cd org-intelligence
sf org login web --alias ma-sandbox --instance-url https://test.salesforce.com
node scripts/install.mjs --target-org ma-sandbox
```

L'installeur demande les modules à installer, déploie, vous donne les accès et crée la connexion
Tooling API. Commencez toujours par une **sandbox**.

## Ce que fait Org Intelligence

| Section                       | Pour quoi faire                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**                  | Score de santé paramétrable (Strict / Balanced / Lenient), tendances, lancement des scans.                                                                            |
| **Org Scanner**               | 34 règles : Apex (couverture, API anciennes, SOQL / DML en boucle, IDs en dur), flows, objets et champs, règles de validation, dépendances, stockage.                 |
| **Automation**                | Tout ce qui s'exécute à l'enregistrement d'un objet, dans l'ordre d'exécution Salesforce ; conflits (même champ écrit deux fois, ordre non garanti, boucles) ; carte. |
| **Storage**                   | Stockage des données et des fichiers, enregistrements par objet.                                                                                                      |
| **Recommendations / Roadmap** | Une recommandation par constat, décisions (statut, motif, échéance), ordre de traitement selon votre capacité, export Jira (CSV).                                     |
| **Reports**                   | Tendances des scans et des recommandations. Exports Excel / CSV de chaque liste.                                                                                      |

### Modules optionnels

| Module                               | Pour quoi faire                                                                                                               | Objets ajoutés |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **Objects & Fields** (`field-usage`) | Taux de remplissage, champs inutilisés / abandonnés / constants ; analyse des types d'enregistrement, présentations et pages. | aucun          |
| **Security**                         | Audit en lecture seule (25 contrôles, note A–E, rapport imprimable), analyse des profils et permission sets.                  | aucun          |
| **Adoption**                         | Licences payées face aux licences utilisées, fonctionnalités natives inexploitées, coût des licences inutilisées.             | aucun          |
| **Inventory**                        | Inventaire des métadonnées (Visualforce, Aura, LWC, étiquettes, présentations, rapports, rôles…) avec ce qu'il faut nettoyer. | aucun          |
| **Context Hub**                      | Prépare le contexte d'un constat (Markdown, secrets masqués) pour un assistant IA — rien n'est envoyé automatiquement.        | aucun          |
| **Recommendations**                  | Édition **collaborative** : recommandations partagées, assignation, Chatter et @mentions, export Jira par API, rapports.      | 1 objet        |
| **API Monitoring**                   | Journal des appels API, consommation des limites, alertes (e-mail, tâche, notification).                                      | 3 objets       |

## Sécurité et données

Vous installez du code dans votre org : voici exactement ce qu'il fait.

- **Lit** les métadonnées (SOQL, describe, Tooling API de **votre** org), les limites et le nombre
  d'enregistrements. Les modules d'analyse ne conservent que des agrégats (taux, compteurs).
- **N'écrit rien** dans vos données. Seuls les modules Recommendations et API Monitoring écrivent,
  dans leurs propres objets. Les paramètres sont dans un custom setting du produit.
- **N'envoie rien hors de l'org**, sauf l'export Jira si vous le configurez.
- **Droits** : requêtes exécutées avec les droits de l'utilisateur (`USER_MODE`) ; scans et
  paramètres réservés aux administrateurs Org Intelligence (permission personnalisée).
- **Connexion Tooling API** : External Client App propre à votre org, créée par l'installeur ou en un
  clic depuis Settings, utilisée par chaque administrateur avec ses propres droits. La clé et le
  secret OAuth sont générés dans votre org et jamais stockés ni affichés
  ([détail](docs/org-intelligence/tooling-api-setup.md)).
- **Désinstallation complète** en une commande ou un bouton (Settings › Uninstall) : seuls les
  composants d'Org Intelligence sont supprimés.

## Pour les développeurs

```bash
npm install
npm run check:modules   # le socle ne dépend d'aucun module
npm run lint
npm run test:unit       # tests Jest des LWC
```

- `org-intelligence/` : le socle, y compris **tous** les écrans (LWC).
- `modules/<module>/` : un dossier par module. Chaque module s'enregistre par une classe d'entrée
  qui étend `OrgIntelModule`, découverte à l'exécution (`OrgIntelModules`, `Type.forName`) : le
  socle ne référence jamais un module.
- `source-tools/` : outil de désinstallation depuis l'application (déployé par l'installeur).
- `scripts/` : installation, désinstallation, test de fumée, connexion Tooling.
- Distribution en packages non verrouillés (optionnel) : [docs/PACKAGING.md](docs/PACKAGING.md).

Contributions bienvenues : ouvrez une issue ou une pull request.

## Licence

[MIT](LICENSE) — utilisation, modification et redistribution libres, y compris commerciales.
