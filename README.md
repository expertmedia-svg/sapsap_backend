# SAPSAP Backend

API NestJS et TypeScript de SAPSAP : connexion OTP, passagers et chauffeurs, courses, tarification, suivi temps réel, messagerie, portefeuille et administration.

## Prérequis

Node.js 24 ou supérieur et MongoDB en replica set (requis pour les transactions). Redis est requis en production.

## Démarrage local

```sh
npm ci
```

Copier `.env.example` vers `.env`, puis définir `AUTH_SECRET` avec une valeur aléatoire d'au moins 32 caractères. Pour générer une valeur :

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Pour utiliser un MongoDB temporaire de développement :

```sh
npm run mongo:local
```

Garder ce terminal ouvert et copier l'URI affichée dans `MONGODB_URI`. Sinon, utiliser son propre replica set MongoDB. Définir `REDIS_URL` uniquement si Redis est disponible. Adapter `ALLOWED_ORIGINS` aux adresses des applications clientes.

Pour préremplir le code OTP dans les applications pendant le développement, définir `NODE_ENV=development`, `SMS_MODE=disabled` et `ALLOW_LOCAL_OTP=true`. Le code est renvoyé dans `devCode` et n'est plus écrit dans un fichier local. Ce mode est interdit en production.

```sh
npm run dev
```

L'API écoute par défaut sur le port 4000. Définir `PORT=4100` pour les applications locales déjà configurées sur ce port. La documentation Swagger est disponible sur `/docs` hors production.

## Vérifications et compilation

```sh
npm run typecheck
npm test
npm run build
npm start
```

Les tests d'intégration démarrent un replica set MongoDB temporaire ; le premier lancement peut télécharger MongoDB.

## Structure

- `apps/api/src` : API et services métier.
- `packages/shared` : validations et règles partagées.
- `packages/config` : configuration TypeScript.
- `scripts` : migrations, MongoDB local et données de démonstration.
- `tests` : tests backend.
- `infrastructure` : Dockerfile API et services de développement.

Les applications Flutter et le dashboard ne font pas partie de ce dépôt. La modification Flutter qui utilise `devCode` reste dans le projet mobile.

## Production

Configurer `NODE_ENV=production`, `ALLOW_LOCAL_OTP=false`, MongoDB en replica set, Redis, un secret unique et Twilio (`SMS_MODE=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`). Configurer également les origines autorisées, HTTPS et un service de routage dédié. Les services de stockage privé, analyse documentaire, notifications et paiements nécessitent leurs propres configurations avant exploitation.

```sh
docker build -f infrastructure/Dockerfile.api -t sapsap-backend .
docker run --env-file .env -p 4000:4000 sapsap-backend
```

Ne jamais versionner `.env`, les clés API, les sessions, les fichiers `.local` ou les données utilisateurs.
