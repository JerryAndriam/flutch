"use strict";

const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "state.json");

const defaultState = {
    sentBiens: {},
    lastCycle: null,
    totalSent: 0,
};

function loadState() {
    // Charge l'état depuis le fichier state.json
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, "utf-8");
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("Failed to load state:", e.message);
    }
    return { ...defaultState };
}

function saveState(state) {
    // Sauvegarde l'état dans le fichier state.json
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        console.error("Failed to save state:", e.message);
    }
}

function isBienSentToAcquereur(acquereurId, bienId, state) {
    // Vérifie si un bien a déjà été envoyé à un acquéreur
    return state.sentBiens[acquereurId]?.includes(bienId);
}

function markBienSent(acquereurId, bienId) {
    // Marque un bien comme envoyé à un acquéreur dans l'état local
    const state = loadState();
    if (!state.sentBiens[acquereurId]) {
        state.sentBiens[acquereurId] = [];
    }
    if (!state.sentBiens[acquereurId].includes(bienId)) {
        state.sentBiens[acquereurId].push(bienId);
        state.totalSent += 1;
    }
    saveState(state);
    return state;
}

function getUnsentBiens(acquereurId, biens, state) {
    // Filtre les biens non encore envoyés à un acquéreur
    return biens.filter((bien) => {
        if (bien.statut_todo === "envoye") return false;
        return !isBienSentToAcquereur(acquereurId, bien.id, state);
    });
}

module.exports = {
    loadState,
    saveState,
    isBienSentToAcquereur,
    markBienSent,
    getUnsentBiens,
};
