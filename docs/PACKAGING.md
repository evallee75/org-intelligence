# Publier des packages (guide du mainteneur, optionnel)

Org Intelligence est distribué **depuis GitHub, par ses sources** : `scripts/install.mjs` déploie
le socle et les modules choisis (cf. [INSTALL.md](INSTALL.md)). Ce guide décrit une distribution
**complémentaire** en **packages non verrouillés** (2GP « unlocked », sans namespace) : un pour le
socle, un par module, installables par un simple lien publié dans une Release GitHub. Rien de ce qui
suit n'est nécessaire pour utiliser ou installer le projet.

## Pourquoi des packages non verrouillés

- **Installation en un clic** par lien, mise à jour et désinstallation propres, sans outil pour le
  client (c'est le modèle de DLRS).
- **Modules indépendants** : chaque paquet déclare ses dépendances (`sfdx-project.json`) ; le socle ne
  référence aucun module (contrôle : `npm run check:modules`).
- Le code reste lisible dans l'org du client, ce qui convient à un projet open source.
- Pas de namespace : simple à démarrer, aucune démarche auprès de Salesforce. (Le code reste
  compatible avec un namespace — `OrgIntelNamespace`, `@NamespaceAccessible` — si un jour une
  distribution en package géré était envisagée.)

## 1. Mise en place (une seule fois)

### Créer sa Dev Hub

La Dev Hub est l'org qui « possède » les packages. **N'utilisez jamais l'org d'un client.**

1. Créer une org **Developer Edition** gratuite : <https://developer.salesforce.com/signup>.
2. Dans cette org : Setup › **Dev Hub** › activer **Enable Dev Hub**, puis
   **Enable Unlocked Packages and Second-Generation Managed Packages**.
3. Se connecter depuis le poste :

```bash
sf org login web --alias oi-devhub --set-default-dev-hub
```

### Créer les huit packages

```bash
sf package create --name "OrgIntelligence" --package-type Unlocked --no-namespace --path org-intelligence --target-dev-hub oi-devhub
sf package create --name "OrgIntelligence-Recommendations" --package-type Unlocked --no-namespace --path modules/recommendations --target-dev-hub oi-devhub
sf package create --name "OrgIntelligence-ContextHub" --package-type Unlocked --no-namespace --path modules/context-hub --target-dev-hub oi-devhub
sf package create --name "OrgIntelligence-ApiMonitoring" --package-type Unlocked --no-namespace --path modules/api-monitoring --target-dev-hub oi-devhub
sf package create --name "OrgIntelligence-FieldUsage" --package-type Unlocked --no-namespace --path modules/field-usage --target-dev-hub oi-devhub
sf package create --name "OrgIntelligence-Adoption" --package-type Unlocked --no-namespace --path modules/adoption --target-dev-hub oi-devhub
sf package create --name "OrgIntelligence-Security" --package-type Unlocked --no-namespace --path modules/security --target-dev-hub oi-devhub
sf package create --name "OrgIntelligence-Inventory" --package-type Unlocked --no-namespace --path modules/inventory --target-dev-hub oi-devhub
```

Chaque commande ajoute l'identifiant du package (`0Ho…`) dans `packageAliases` de
`sfdx-project.json` : committer ce fichier.

> **Piège** : `sf package create` **réécrit aussi l'entrée du dossier** dans `packageDirectories` :
> il supprime les `dependencies`, remplace `versionNumber` par `0.1.0.NEXT`, `versionName` par
> « ver 0.1 » et vide la description. Après les créations, remettre `sfdx-project.json` tel qu'il
> était (garder seulement les nouveaux `packageAliases`), sinon les modules sont construits sans le
> socle (« Invalid type: OrgIntelModule »).

## 2. Publier une version

Toujours **dans l'ordre des dépendances** : socle, Recommendations, puis les autres modules.

```bash
sf package version create --package "OrgIntelligence" --installation-key-bypass --wait 30 --target-dev-hub oi-devhub
sf package version create --package "OrgIntelligence-Recommendations" --installation-key-bypass --wait 30 --target-dev-hub oi-devhub
sf package version create --package "OrgIntelligence-ContextHub" --installation-key-bypass --wait 30 --target-dev-hub oi-devhub
sf package version create --package "OrgIntelligence-ApiMonitoring" --installation-key-bypass --wait 30 --target-dev-hub oi-devhub
sf package version create --package "OrgIntelligence-FieldUsage" --installation-key-bypass --wait 30 --target-dev-hub oi-devhub
sf package version create --package "OrgIntelligence-Adoption" --installation-key-bypass --wait 30 --target-dev-hub oi-devhub
sf package version create --package "OrgIntelligence-Security" --installation-key-bypass --wait 30 --target-dev-hub oi-devhub
sf package version create --package "OrgIntelligence-Inventory" --installation-key-bypass --wait 30 --target-dev-hub oi-devhub
```

Chaque commande renvoie un identifiant de version `04t…` (aussi ajouté à `packageAliases`). Le lien
d'installation en sandbox est :

```
https://test.salesforce.com/packaging/installPackage.apexp?p0=04t...
```

Publier les liens dans la « Release » GitHub (et ajouter une section « Installer par lien » à
[INSTALL.md](INSTALL.md)).

Reporter aussi les identifiants `04t` des **modules** dans `OPTIONAL_MODULES`
(`packageVersionId`, fichier `org-intelligence/main/default/lwc/orgIntelUtils/orgIntelUtils.js`) :
c'est ce qu'utilise l'écran **Modules** de l'application (bouton « Install » de chaque module).
Ces identifiants n'étant connus qu'après la construction des modules, il faut ensuite **reconstruire
le socle** (nouveau build de la même version : les modules, qui dépendent de `1.0.0.LATEST`,
restent compatibles). Sans identifiant, le bouton renvoie vers le guide d'installation.

### Limite quotidienne

Une Dev Hub Developer Edition autorise **6 constructions de version par jour** (24 h glissantes),
**échecs compris** (`sf limits api display --target-org oi-devhub`, ligne
`Package2VersionCreates`). Une publication complète en consomme 6 (5 packages + socle reconstruit
avec les identifiants des modules) : vérifier `npm run check:modules` et déployer d'abord dans une
scratch org avant de lancer les constructions.

### Version bêta ou version publiée

- Une version créée ainsi est **bêta** : elle s'installe dans les **sandboxes** et les scratch orgs,
  **pas en production**. C'est suffisant pour la diffusion actuelle (installation en sandbox).
- Pour une installation en production, il faut **promouvoir** la version, ce qui exige 75 % de
  couverture de code par package (le projet est à environ 90 %) : ajouter `--code-coverage` à
  `version create`, puis `sf package version promote --package "OrgIntelligence@1.0.0-1"`. Une
  version promue ne se supprime plus.
- Numérotation : `versionNumber` dans `sfdx-project.json` (`1.0.0.NEXT` = build suivant de la 1.0.0).
  Augmenter le mineur pour une évolution, le majeur pour un changement incompatible.

## 3. Tester l'installation « socle seul »

Une scratch org (créée depuis la Dev Hub) est une org vierge, idéale pour vérifier que le socle
s'installe et fonctionne sans aucun module :

```bash
sf org create scratch --definition-file config/project-scratch-def.json --alias oi-core-only --duration-days 1 --target-dev-hub oi-devhub
sf package install --package <04t du socle> --target-org oi-core-only --security-type AdminsOnly --wait 30 --no-prompt
sf org open --target-org oi-core-only --path /lightning/n/Org_Intelligence
```

Au premier lancement, l'application ouvre l'écran **Modules** (« Choose your modules ») : bouton
« Give me admin access » pour le socle, puis « Install » / « Give me access » par module.

Le scan est piloté par le navigateur (une page d'étape par appel Apex synchrone, `OrgScanRunner`) :
aucune chaîne de Queueables, donc aucune limite propre aux scratch orgs et Developer Edition.

## Règles pour garder les modules indépendants

- Le socle ne référence **jamais** statiquement une classe, un objet ou un champ d'un module : il les
  découvre par `OrgIntelModules` (`Type.forName`). Les écrans des modules (LWC, livrés avec le socle)
  appellent leur Apex par `orgIntelModuleApi.moduleAction(module, action)`.
- Un nouveau module = un dossier `modules/<nom>`, une classe d'entrée qui étend `OrgIntelModule`
  (déclarée dans `OrgIntelModules.ENTRY_CLASSES`), ses permission sets, et une entrée dans
  `sfdx-project.json`.
- `npm run check:modules` doit passer avant chaque publication.
- `source-tools/` (outils de l'installation depuis les sources : désinstallation complète depuis
  Settings, `OrgIntelUninstallTool` + `OrgUninstallService` + ressource `OrgIntelligenceUninstall`)
  est une entrée de `packageDirectories` **sans `package`** : jamais empaquetée, déployée par
  `scripts/install.mjs` (option `--no-uninstall-tool` pour s'en passer). Le socle la découvre comme un
  module (`OrgIntelModules`, clé `uninstall`, `OrgIntelModuleController.getTools`) : le bouton
  Settings › Uninstall n'apparaît que si elle est là ; sinon l'écran renvoie vers Setup › Installed
  Packages.
