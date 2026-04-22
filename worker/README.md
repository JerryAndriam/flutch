# Worker autonome de relance

Comme comportement, Le script actuel contacte les acquéreurs dormants via l’API du Flutch. il tourne entre 9h et 19h (heure de Paris), s’exécute par cycle toutes les 30 minutes (configurable), traite au maximum 20 acquéreurs par cycle avec une limite de 3 biens par acquéreur, et sauvegarde son état dans le fichier `worker/state.json`.

## Configuration

Créer un fichier `worker/.env` avec:

```env
FLUTCH_API_URL=
FLUTCH_EMAIL=
FLUTCH_PASSWORD=
MAX_SENDS_PER_CYCLE=
CYCLE_INTERVAL_MINUTES=
```

## Lancement

```bash
npm run worker
```
