"use strict";

const config = require("./config");
const { loadState, markBienSent, getUnsentBiens } = require("./state");

let authToken = null;
let tokenExpiresAt = 0;

async function apiRequest(endpoint, options = {}) {
    // Effectue une requête HTTP vers l'API avec gestion du token JWT
    const url = `${config.FLUTCH_API_URL}${endpoint}`;
    const headers = {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...options.headers,
    };

    const response = await fetch(url, {
        ...options,
        headers,
    });

    if (response.status === 401) {
        console.log("Token expiré, reconnexion...");
        await login();
        return apiRequest(endpoint, options);
    }

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error ${response.status}: ${error}`);
    }

    return response.json();
}

async function login() {
    // Authentifie le worker et récupère le token JWT
    console.log(`Connexion à ${config.FLUTCH_API_URL}...`);
    const result = await apiRequest("/api/login", {
        method: "POST",
        body: JSON.stringify({
            email: config.FLUTCH_EMAIL,
            password: config.FLUTCH_PASSWORD,
        }),
    });

    if (!result.success || !result.token) {
        throw new Error("Échec de connexion");
    }

    authToken = result.token;
    tokenExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    console.log("Connecté. Token obtenu.");
}

async function getDashboard() {
    // Récupère la liste des acquéreurs et leurs biens depuis l'API
    console.log("Récupération du dashboard...");
    const result = await apiRequest("/api/todos/dashboard");
    return result;
}

async function enqueueBiens(acquereurId, bienIds, channel = "both") {
    // Ajoute des biens à la file d'envoi pour un acquéreur
    console.log(
        `Envoi de ${bienIds.length} bien(s) à l'acquéreur ${acquereurId} (channel: ${channel})...`,
    );
    const result = await apiRequest("/api/email-queue/enqueue", {
        method: "POST",
        body: JSON.stringify({
            acquereur_id: acquereurId,
            bien_ids: bienIds,
            channel,
        }),
    });

    console.log(
        `Envoi réussi: ${result.queued} bien(s) en queue, ${result.skipped_duplicates} duplicate(s) ignoré(s)`,
    );
    return result;
}

function isWorkingHours() {
    // Vérifie si l'heure actuelle est dans les plages horaires autorisées (9h-19h)
    const now = new Date();
    const parisTime = new Date(
        now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
    );
    const hour = parisTime.getHours();
    return hour >= 9 && hour < 19;
}

function getParisTime() {
    // Retourne la date et heure actuelle fuseau horaire de Paris
    return new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" });
}

async function runCycle() {
    // Exécute un cycle de traitement : récupère les acquéreurs et envoie les biens
    const now = new Date();
    console.log(`\n${getParisTime()} — Début du cycle`);

    const state = loadState();

    if (!isWorkingHours()) {
        console.log("Hors horaires de travail (9h-19h Paris). Cycle ignoré.");
        return;
    }

    if (!authToken) {
        await login();
    }

    let dashboard;
    try {
        dashboard = await getDashboard();
    } catch (e) {
        console.error("Échec récupération dashboard:", e.message);
        return;
    }

    const acquereurs = dashboard.acquereurs || [];
    console.log(`${acquereurs.length} acquéreur(s) trouvé(s)`);

    let processed = 0;
    let sent = 0;

    for (const acq of acquereurs) {
        if (processed >= config.MAX_SENDS_PER_CYCLE) {
            console.log(
                `Limite de ${config.MAX_SENDS_PER_CYCLE} acquéreurs atteinte.`,
            );
            break;
        }

        const nonTraites =
            acq.biens?.filter(
                (b) => !b.statut_todo || b.statut_todo === "non_traite",
            ) || [];
        if (nonTraites.length === 0) {
            continue;
        }

        const unsentBiens = getUnsentBiens(acq.id, acq.biens, state);
        if (unsentBiens.length === 0) {
            continue;
        }

        const biensToSend = unsentBiens.slice(
            0,
            config.MAX_BIENS_PER_ACQUEREUR,
        );
        const bienIds = biensToSend.map((b) => b.id);

        try {
            await enqueueBiens(acq.id, bienIds, "both");

            for (const bien of biensToSend) {
                markBienSent(acq.id, bien.id);
            }

            sent += biensToSend.length;
            processed += 1;

            console.log(
                `${acq.titre}: ${biensToSend.length} bien(s) envoyé(s)`,
            );
        } catch (e) {
            console.error(`Échec envoi pour ${acq.titre}:`, e.message);
        }

        await new Promise((resolve) =>
            setTimeout(resolve, config.SEND_DELAY_MS),
        );
    }

    state.lastCycle = now.toISOString();
    require("./state").saveState(state);

    console.log(
        `\n Cycle terminé: ${processed} acquéreur(s) contacté(s), ${sent} bien(s) envoyé(s)`,
    );
}

async function main() {
    // Point d'entrée principal qui démarre le worker et lance la boucle infinie
    console.log("Worker autonome de relance démarré.");
    console.log(`   API: ${config.FLUTCH_API_URL}`);
    console.log(`   Email: ${config.FLUTCH_EMAIL}`);
    console.log(`   Max envois/cycle: ${config.MAX_SENDS_PER_CYCLE}`);
    console.log(`   Intervalle: ${config.CYCLE_INTERVAL_MINUTES} min\n`);

    await login();

    async function loop() {
        await runCycle();
        setTimeout(loop, config.CYCLE_INTERVAL_MINUTES * 60 * 1000);
    }

    await loop();
}

if (require.main === module) {
    main().catch((e) => {
        console.error("Worker crashed:", e);
        process.exit(1);
    });
}

module.exports = { runCycle, login, apiRequest };
