"use strict";

const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, ".env");
let env = {};

if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, "utf-8");
    content.split("\n").forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const [key, ...valueParts] = trimmed.split("=");
        if (key) env[key.trim()] = valueParts.join("=").trim();
    });
}

const num = (val, def) => {
    // Convertit une chaîne en nombre avec valeur par défaut
    const n = parseInt(val, 10);
    return Number.isFinite(n) ? n : def;
};

const maxSends = num(
    env.MAX_SENDS_PER_CYCLE,
    num(process.env.MAX_SENDS_PER_CYCLE, 20),
);
const cycleInterval = num(
    env.CYCLE_INTERVAL_MINUTES,
    num(process.env.CYCLE_INTERVAL_MINUTES, 30),
);

const config = {
    // Configuration du worker chargée depuis .env ou variables d'environnement
    FLUTCH_API_URL:
        env.FLUTCH_API_URL ||
        process.env.FLUTCH_API_URL ||
        "http://localhost:3000",
    FLUTCH_EMAIL:
        env.FLUTCH_EMAIL ||
        process.env.FLUTCH_EMAIL ||
        "gregory@leboutiquier.fr",
    FLUTCH_PASSWORD:
        env.FLUTCH_PASSWORD || process.env.FLUTCH_PASSWORD || "flutch2024",
    MAX_SENDS_PER_CYCLE: maxSends,
    CYCLE_INTERVAL_MINUTES: cycleInterval,
    MAX_BIENS_PER_ACQUEREUR: 3,
    SEND_DELAY_MS: 2000,
};

module.exports = config;
