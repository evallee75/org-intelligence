# Installer Org Intelligence

Ce guide installe Org Intelligence depuis GitHub dans une **sandbox** ou en **production**, en
5 étapes et environ 15 minutes. Une seule commande fait l'essentiel.

> **Conseil** : commencez toujours par une sandbox. Une fois l'outil validé, refaites les mêmes
> étapes en production.

---

## Avant de commencer

| Il vous faut                                | Comment vérifier                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Un utilisateur **administrateur système**   | Profil « System Administrator » (ou « Modify All Data » et « View Setup and Configuration ») |
| **Node.js** 18 ou plus                      | `node -v` dans un terminal — sinon : <https://nodejs.org> (version LTS)                      |
| Le **Salesforce CLI**                       | `sf --version` — sinon : <https://developer.salesforce.com/tools/salesforcecli>              |
| **Chatter** activé (module Recommendations) | Setup › Chatter Settings — inutile si vous n'installez pas ce module                         |

**Ce qui est installé** : des classes Apex, des écrans Lightning, une application et des permission
sets. Le socle **n'ajoute aucun objet** et **ne modifie aucune de vos données** : il lit les
métadonnées de l'org et garde ses résultats dans le navigateur. Seuls deux modules optionnels
ajoutent des objets (Recommendations : 1, API Monitoring : 3).

---

## Étape 1 — Récupérer le code

```bash
git clone https://github.com/evallee75/org-intelligence.git
cd org-intelligence
```

Sans Git : sur la page GitHub, **Code › Download ZIP**, décompressez, puis ouvrez un terminal dans
le dossier obtenu.

## Étape 2 — Se connecter à l'org

Une fenêtre de connexion Salesforce s'ouvre dans le navigateur ; connectez-vous avec votre
utilisateur administrateur.

```bash
# Sandbox
sf org login web --alias ma-sandbox --instance-url https://test.salesforce.com

# Production
sf org login web --alias ma-prod --instance-url https://login.salesforce.com
```

Si votre société impose sa propre page de connexion, utilisez l'adresse de votre domaine :
`--instance-url https://<votre-domaine>.my.salesforce.com` (sandbox :
`https://<votre-domaine>--<sandbox>.sandbox.my.salesforce.com`).

## Étape 3 — Lancer l'installation

```bash
node scripts/install.mjs --target-org ma-sandbox
```

L'installeur :

1. vérifie l'org (sandbox ou production) ;
2. vous propose chaque **module optionnel** — répondez `y` ou `n` :

   | Module          | En bref                                                          |
   | --------------- | ---------------------------------------------------------------- |
   | Recommendations | Recommandations partagées dans l'org, assignation, Chatter, Jira |
   | Context Hub     | Contexte d'un constat prêt à coller dans un assistant IA         |
   | API Monitoring  | Journal des appels API et alertes                                |
   | Field Usage     | Remplissage et utilisation des champs                            |
   | Adoption        | Licences payées / utilisées, fonctionnalités inexploitées        |
   | Security        | Audit de sécurité et rapport imprimable                          |
   | Inventory       | Inventaire des métadonnées à nettoyer                            |

3. déploie (quelques minutes en sandbox) ;
4. vous attribue les permission sets ;
5. propose de créer la **connexion Tooling API** : répondez `y`.

Un module peut être ajouté plus tard en relançant la même commande.

Pour tout installer sans questions :

```bash
node scripts/install.mjs --target-org ma-sandbox --modules all --tooling --yes
```

### En production

Même commande, avec l'alias de production :

```bash
node scripts/install.mjs --target-org ma-prod
```

Ce qui change :

- l'installeur vous demande une **confirmation** (ou l'option `--allow-production` sans questions) ;
- Salesforce exécute les **tests Apex d'Org Intelligence uniquement** (jamais ceux de votre org) :
  comptez **5 à 15 minutes** ;
- si un test échoue, **rien n'est installé** (le déploiement est tout ou rien) ;
- le bouton de désinstallation de l'application n'est pas déployé (cf. [Désinstaller](#désinstaller)).

## Étape 4 — Autoriser la connexion Tooling API

La connexion permet de lire la couverture de code, la logique des flows, les règles de validation
et les dépendances. Sans elle, le scanner fonctionne en mode réduit et le signale.

Chaque administrateur qui lance des scans l'autorise **une fois** :

1. Ouvrez l'application : lanceur d'applications (les 9 points) › **Org Intelligence** ;
2. **Settings** › **Tooling API connection** › **Connect** ;
3. Cliquez sur **Allow** dans la fenêtre Salesforce.

> Si vous avez répondu `n` à l'étape 3 : **Settings › Set up automatically** crée la connexion en une
> dizaine de secondes, puis **Connect**.

## Étape 5 — Lancer le premier scan

**Overview** › **New scan** › **Start scan**. Le scan dure de 1 à 10 minutes selon la taille de l'org ;
vous pouvez changer de section pendant ce temps (gardez l'onglet ouvert).

C'est terminé.

---

## Donner l'accès aux autres utilisateurs

Setup › **Permission Sets** › choisir le permission set › **Manage Assignments** › **Add Assignment**.

| Rôle                                                  | Socle                      | Modules installés                                                                               |
| ----------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| **Administrateur** (scans, paramètres, analyses)      | `Org Intelligence - Admin` | `Org Intelligence - <Module> Admin`                                                             |
| **Lecteur** (consulter, décider, commenter, exporter) | `Org Intelligence - User`  | `Org Intelligence - Recommendations User`, `Org Intelligence - Context Hub User` (si installés) |

Les autres administrateurs font ensuite l'étape 4 pour leur propre compte.

> Les résultats (scans, audits) sont gardés **dans le navigateur** de chaque utilisateur. Pour les
> partager : menu **Data › Save to file**, puis **Open a file** chez le destinataire — ou installez le
> module Recommendations pour partager les décisions dans l'org.

## Mettre à jour

```bash
cd org-intelligence
git pull
node scripts/install.mjs --target-org ma-sandbox
```

Les réglages, l'historique et les résultats sont conservés. Si la mise à jour est refusée à cause
d'un **job planifié** (alertes du module API Monitoring) : API Monitoring › Alerts › planification
sur **Off**, mettez à jour, puis réactivez.

## Désinstaller

Tout ce qui appartient à Org Intelligence est supprimé (avec les données de ses modules) ; rien
d'autre n'est touché.

| Org            | Comment                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandbox**    | Dans l'application : **Settings › Uninstall Org Intelligence**, tapez `DELETE`. Ou : `node scripts/uninstall.mjs --target-org ma-sandbox`                           |
| **Production** | `node scripts/uninstall.mjs --target-org ma-prod --allow-production` — Salesforce exécute alors les tests Apex de votre org (comme pour toute suppression de code). |

En production, les objets supprimés restent 15 jours dans Setup › **Deleted Objects** : effacez-les
là si vous voulez réinstaller avant ce délai.

## Dépannage

| Problème                                            | Solution                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sf: command not found` / `node: command not found` | Installez le Salesforce CLI / Node.js (cf. [Avant de commencer](#avant-de-commencer)), puis rouvrez le terminal. |
| « Cannot reach the org »                            | Refaites l'étape 2 avec le même alias.                                                                           |
| Échec du déploiement, mention de Chatter            | Activez Chatter (Setup › Chatter Settings) ou n'installez pas le module Recommendations.                         |
| Production : un test Org Intelligence échoue        | Rien n'a été modifié. Ouvrez une _issue_ sur GitHub avec le message affiché.                                     |
| « You do not have access to Org Intelligence »      | Attribuez `Org Intelligence - Admin` ou `Org Intelligence - User`.                                               |
| Une section n'apparaît pas dans le menu             | Le module n'est pas installé, ou son permission set n'est pas attribué (menu **Modules** pour vérifier).         |
| Le scanner indique « degraded mode »                | Faites l'étape 4 (**Connect**).                                                                                  |
| Le scan échoue avec une erreur de droits            | Il faut « View Setup and Configuration » sur votre profil.                                                       |

Pour aller plus loin : [connexion Tooling API en détail](org-intelligence/tooling-api-setup.md),
[distribution en packages](PACKAGING.md).
