# 🔄 Refactoring asynchrone pour rendre le traitement asynchrone

Au lieu de traiter les webhooks directement au moment où ils arrivent (ce qui bloque le système), je propose de les mettre dans une file d’attente dans la base de données, puis de les traiter plus tard, petit à petit. Ça permet au serveur de répondre vite, même si beaucoup de webhooks arrivent en même temps.

- On enregistre les données dans une table `webhook_queue` pour garder la rapidité d'exécution
- Un processus tourne en arrière-plan, prenant les éléments “en attente”, puis les traite un par un ou par petits groupes et les marque comme “terminés” à la fin
- Si ça échoue, on réessaie plusieurs fois automatiquement. Dans le cas plusieurs échecs, on met dans une zone spéciale “erreur” pour analyse

---

## Fonctionnement

```
Pipedrive
   │
   ▼
Webhook reçu
   │
   ▼
On enregistre dans une "queue" (table en BDD)
   │
   ▼
Un processus en arrière-plan lit la queue
   │
   ▼
Traitement + mise à jour de la base
```

---

## Structure de la table utilisée

On utilise une table `webhook_queue` qui contient :

- les données du webhook
- son statut (en attente, en cours, terminé, erreur)
- le nombre de tentatives
- la date du prochain essai

---
