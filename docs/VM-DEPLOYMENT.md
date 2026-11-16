# Environnement partagé SAPSAP

Déploiement du 16 novembre 2026 : `https://sapsap.yingr-ai.com`, VM Debian 13 `57.130.19.72`.

- Code : `/home/debian/sapsap_backend`, configuration privée dans `.env` (mode 0600).
- Runtime Node.js 24.12.0 : `/opt/sapsap/runtime` ; PM2 : `/opt/sapsap/pm2`.
- Processus : `sapsap-api`, une instance, compte `debian`.
- Démarrage automatique : service systemd `pm2-sapsap`, liste sauvegardée dans `/home/debian/.pm2`.
- MongoDB : image `mongo:8.0.17`, conteneur `sapsap-mongo`, replica set `sapsap-rs`, volume persistant `sapsap-mongo-data`, boucle locale port 27017.
- Base de démonstration : `sapsap_test`.
- Redis : service `redis-server`, boucle locale port 6379, base logique 5.
- API Node : `127.0.0.1:4000`, en-têtes de proxy approuvés uniquement depuis la boucle locale.
- Nginx : site `/etc/nginx/sites-available/sapsap` ; HTTPS et renouvellement Certbot.
- Applications Flutter compilées : `/var/www/sapsap/passager` et `/var/www/sapsap/chauffeur`.
- Page de suivi temporaire : `/var/www/sapsap/suivi.html`, source `infrastructure/suivi.html`.

Les services préexistants sur la VM utilisent leurs propres configurations.

## Vérifier

```sh
pm2 status
sudo systemctl is-enabled pm2-sapsap docker redis-server
curl --fail https://sapsap.yingr-ai.com/health
sudo docker inspect sapsap-mongo --format '{{.HostConfig.RestartPolicy.Name}}'
```

L'environnement utilise `NODE_ENV=staging` et le préremplissage OTP de démonstration. Il ne convient pas aux comptes réels : le numéro de téléphone n'est pas vérifié par SMS. Les paiements réels sont désactivés. Le routage public est utilisé pour les essais fonctionnels, pas pour une campagne massive. Une vraie mesure de capacité sur les parcours métier reste à organiser.

Les cinq chauffeurs de démonstration portent les numéros `+22670008101` à `+22670008105`. Le compte d'administration de test `+22670000001` conserve un second facteur TOTP ; son URI privée se trouve dans `.local/admin-mfa.txt` sur le serveur. Aucun secret n'est enregistré dans Git.

Pour redémarrer : `sudo systemctl restart pm2-sapsap`. Pour mettre à jour, suivre les commandes PM2 du README avec `PATH=/opt/sapsap/runtime/bin:$PATH`.
