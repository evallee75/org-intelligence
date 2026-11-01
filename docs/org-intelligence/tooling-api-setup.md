# Org Intelligence — connexion à la Tooling API

Sans cette connexion, le scanner fonctionne en **mode dégradé** : Apex, triggers, flows, objets et champs sont analysés (SOQL et describe), mais **les règles de validation, les dépendances et la couverture de code ne le sont pas** — le journal du scan le signale.

La connexion utilise un **principal par utilisateur** : chaque administrateur s'authentifie une fois, et les appels sont faits avec ses propres droits (aucun compte technique, aucun secret dans le code).

## Depuis l'application, en un clic (recommandé)

Settings › Tooling API connection (ou l'étape « Tooling » de l'écran Modules) :

1. **Set up automatically** (une seule fois par org, par un administrateur) ouvre l'assistant, une
   page Visualforce (`OrgIntelligenceToolingSetup`, contrôleur `OrgToolingSetupController`). Il
   crée en trois déploiements, en une dizaine de secondes, les mêmes composants que le script
   ci-dessous, avec la session de l'administrateur connecté (donc ses droits) : la session d'une
   page Visualforce peut appeler l'API Metadata de l'org, ce que ne permet pas celle d'un composant
   Lightning, et un appel vers le domaine de l'org elle-même n'exige pas de Remote Site Setting.
   La clé et le secret OAuth sont générés pour ce seul déploiement, jamais stockés ni affichés.
2. **Connect** (chaque administrateur, une fois) : le permission set
   `OrgIntelligence_Tooling_Access` est attribué s'il manque, puis l'utilisateur est redirigé vers
   l'autorisation OAuth de son principal (URL fournie par
   `ConnectApi.NamedCredentials.getOAuthCredentialAuthUrl`, équivalent du bouton « Allow Access »
   des paramètres personnels). Après connexion, Salesforce le ramène sur la fiche de l'External
   Credential ; il suffit de revenir dans Org Intelligence.

L'état affiché dans Settings (`OrgToolingGateway.Status`) distingue : non configuré
(`configured = false`, lien `setupUrl`), configuré mais utilisateur non autorisé
(`authorized = false`, lien `authorizationUrl`, aucun appel HTTP fait), connecté. L'autorisation
est lue par `ConnectApi.NamedCredentials.getCredential` (présence du jeton OAuth de
l'utilisateur), sans appel HTTP. Pour recréer une connexion existante, utiliser le script avec
`--reset`.

## En ligne de commande

```bash
node scripts/org-intelligence/setup-tooling.mjs --target-org "<alias>"
```

Le script crée l'External Client App, l'Auth. Provider, l'External Credential (principal par utilisateur), la Named Credential `OrgIntelligenceTooling` et le permission set `OrgIntelligence_Tooling_Access` (accès au principal), puis l'assigne à l'utilisateur courant. La clé et le secret OAuth sont générés à chaque exécution et déployés depuis un dossier temporaire : ils ne sont jamais écrits dans le dépôt. Pour refaire la mise en place (changement d'URL, erreur OAuth), relancer avec `--reset` : Salesforce n'autorise pas la modification du secret d'un Auth. Provider, le script supprime donc l'ensemble avant de le recréer (chacun devra refaire « Allow Access »). PKCE est activé (exigé par les External Client Apps). Il reste ensuite l'étape 6 (autorisation de chaque administrateur : bouton « Connect » de Settings, qui attribue aussi le permission set).

## Mise en place manuelle

Remplacer `<domaine>` par l'URL Mon domaine de l'org (affichée dans Org Intelligence › Settings), par exemple `https://monentreprise--masandbox.sandbox.my.salesforce.com`.

## 1. External Client App

Setup › **External Client App Manager** › New External Client App.

- Nom : `Org Intelligence Tooling`, distribution : Local.
- Activer OAuth. Callback URL : `<domaine>/services/authcallback/OrgIntelligenceTooling`
- Scopes : **Manage user data via APIs (api)** et **Perform requests at any time (refresh_token, offline_access)**.
- Enregistrer, puis copier la **Consumer Key** et le **Consumer Secret** (Settings › OAuth Settings › Consumer Key and Secret).

## 2. Auth. Provider

Setup › **Auth. Providers** › New › type **Salesforce**.

- Name / URL Suffix : `OrgIntelligenceTooling`
- Consumer Key / Secret : ceux de l'étape 1.
- Default Scopes : `api refresh_token`
- Enregistrer. Vérifier que la Callback URL affichée est identique à celle saisie à l'étape 1.

## 3. External Credential

Setup › **Named Credentials** › onglet External Credentials › New.

- Label : `Org Intelligence Tooling`, Name : `OrgIntelligenceTooling`
- Authentication Protocol : **OAuth 2.0**, Flow : **Browser Flow**, Identity Provider : l'Auth. Provider de l'étape 2, Scope : `api refresh_token`.
- Section Principals › New : Parameter Name `PerUser`, Identity Type **Per User Principal**.

## 4. Named Credential

Onglet Named Credentials › New.

- Label : `Org Intelligence Tooling`, **Name : `OrgIntelligenceTooling`** (doit correspondre au paramètre `OrgIntelligenceSetting__mdt.Default.ToolingNamedCredential__c`).
- URL : `<domaine>`
- External Credential : celui de l'étape 3. Cocher **Generate Authorization Header**.

## 5. Droits

Setup › Permission Sets › **Org Intelligence - Admin** › External Credential Principal Access › Edit › ajouter `OrgIntelligenceTooling - PerUser`.

Les utilisateurs qui scannent doivent aussi avoir **View Setup and Configuration** (profil ou permission set).

## 6. Authentification de chaque administrateur

Org Intelligence › Settings › **Connect**, ou : avatar › **Settings** › **External Credentials** (Mes paramètres) › `Org Intelligence Tooling` › **Allow Access**, puis se connecter.

## 7. Vérification

Org Intelligence › **Settings** › « Test the connection » : le statut passe à **Connected**. Lancer ensuite un scan avec les périmètres _Validation rules_ et _Dependencies_. Chaque appel Tooling apparaît dans **API Monitoring** (système « Salesforce Tooling API »).

## Sécurité de l'assistant de connexion

- L'identifiant de session n'est utilisé que **côté serveur**, par l'assistant Visualforce, pour
  appeler l'API Metadata de **l'org elle-même** (déploiement des composants de connexion) ; il n'est
  jamais envoyé à un tiers ni écrit dans la page. Les appels Tooling du scanner passent tous par la
  Named Credential (principal par utilisateur, aucun compte technique).
- Les actions qui modifient l'org sont des boutons de formulaire Visualforce (jeton CSRF), jamais
  l'attribut `action` de la page ; assistant réservé aux administrateurs Org Intelligence ;
  permission set attribué en `USER_MODE` (exige « Assign Permission Sets »).
- Clé et secret OAuth générés aléatoirement (`Crypto.generateAesKey`) pour le seul déploiement,
  jamais stockés par l'application ni affichés ; jetons des utilisateurs chiffrés par Salesforce.
- La redirection « Connect » n'accepte qu'une URL relative ou du domaine de l'org (pas de
  redirection ouverte).
- Mode dégradé documenté : sans connexion, le scanner fonctionne et le signale.

## Dépannage

| Message                                    | Cause                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| _Tooling API not configured_               | La Named Credential `OrgIntelligenceTooling` n'existe pas (étape 4).                        |
| _Tooling API access refused (401)_         | L'utilisateur ne s'est pas authentifié (étape 6) ou n'a pas l'accès au principal (étape 5). |
| _Tooling API access refused (403)_         | Il manque « View Setup and Configuration » ou « API Enabled ».                              |
| _unreachable through the Named Credential_ | URL de la Named Credential erronée, ou External Credential non relié.                       |
| _not authorized for your user_             | Jeton OAuth absent pour cet utilisateur : bouton « Connect » (étape 6).                     |
