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

## VM et PM2

Installer Node.js 24 et PM2, puis cloner le dépôt sous le compte qui exécutera l'API :

```sh
git clone https://github.com/expertmedia-svg/sapsap_backend.git
cd sapsap_backend
MONGOMS_DISABLE_POSTINSTALL=1 npm ci
cp .env.example .env
chmod 600 .env
```

Configurer `.env` avec les services de la VM avant de démarrer. MongoDB doit être persistant et configuré en replica set ; le serveur temporaire `mongo:local` est réservé au développement. Ne pas exposer MongoDB ou Redis sur Internet.

Pour Nginx sur la même VM, utiliser `HOST=127.0.0.1`, `PORT=4000` et `TRUST_PROXY=loopback`. Adapter le domaine dans `infrastructure/nginx-api.conf.example`, installer ce virtual host sans remplacer les sites existants, puis activer HTTPS. L'API prend ainsi en compte les IP clientes pour ses limites de requêtes. Ajouter les origines exactes des applications web à `ALLOWED_ORIGINS`.

```sh
npm run build
npm run migrate
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Exécuter ensuite la commande `sudo` affichée par `pm2 startup`. `pm2 save` sauvegarde la liste des processus et le service systemd la restaure après redémarrage de la VM. Le démon PM2 maintient l'API après fermeture du terminal.

```sh
pm2 status
pm2 logs sapsap-api --lines 50 --nostream
curl --fail http://127.0.0.1:4000/health
curl --fail https://api.example.com/health
```

Conserver une seule instance PM2 : la diffusion Socket.IO et le traitement des événements ne sont pas encore configurés pour plusieurs instances. La capacité doit être mesurée sur la VM avant une campagne de charge.

Pour mettre à jour un déploiement existant :

```sh
git pull --ff-only
MONGOMS_DISABLE_POSTINSTALL=1 npm ci
npm run build
npm run migrate
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

Les applications mobiles doivent être recompilées avec `--dart-define=API_URL=https://api.example.com`. Sur Windows, le projet mobile accepte désormais `-ApiUrl` dans `scripts/run-flutter.ps1`. Le dashboard utilise `NEXT_PUBLIC_API_URL` lors de sa compilation. Remplacer les domaines d'exemple par les adresses vérifiées du déploiement.
