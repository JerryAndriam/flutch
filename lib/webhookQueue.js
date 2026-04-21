"use strict";

/**
 * Webhook Queue - Architecture asynchrone Producer/Consumer
 */

const { logger } = require("./logger");
const { pool } = require("../db");
const { schedule, shutdownAll } = require("./scheduler");

const QUEUE_STATUS = {
    PENDING: "pending",
    PROCESSING: "processing",
    COMPLETED: "completed",
    FAILED: "failed",
    DEAD_LETTER: "dead_letter",
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_BATCH_SIZE = 10;
const CIRCUIT_BREAKER_THRESHOLD = 0.5;
const CIRCUIT_BREAKER_WINDOW_MS = 60000;
const CIRCUIT_BREAKER_PAUSE_MS = 30000;

let circuitBreakerEnabled = false;
let circuitBreakerPausedUntil = 0;
let recentResults = [];

async function initQueueSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS webhook_queue (
            id SERIAL PRIMARY KEY,
            payload JSONB NOT NULL,
            type VARCHAR(50) NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            attempt INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 5,
            next_retry_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            processed_at TIMESTAMP,
            error TEXT,
            CONSTRAINT chk_status CHECK (status IN ('pending','processing','completed','failed','dead_letter'))
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_webhook_queue_status
        ON webhook_queue(status) WHERE status = 'pending'
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_webhook_queue_next_retry
        ON webhook_queue(next_retry_at) WHERE status = 'pending'
    `);

    logger.info("✅ WebhookQueue: schema initialisé");
}

/**
 * PRODUCER : Ajoute un webhook à la queue (non-bloquant)
 * @param {Object} payload - Données du webhook Pipedrive
 * @param {string} type - Type d'événement (deal.created, deal.updated, etc.)
 * @param {number} maxAttempts - Nombre max de retry (défaut: 5)
 * @returns {Promise<number>} ID du job en queue
 */
async function enqueue(payload, type, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    try {
        const { rows } = await pool.query(
            `INSERT INTO webhook_queue (payload, type, status, max_attempts, next_retry_at)
             VALUES ($1, $2, 'pending', $3, NOW())
             RETURNING id`,
            [JSON.stringify(payload), type, maxAttempts],
        );

        logger.debug(`📥 Webhook enqueued: ${type} #${rows[0].id}`);
        return rows[0].id;
    } catch (err) {
        logger.error(`❌ Erreur enqueue webhook: ${err.message}`);
        throw err;
    }
}

/**
 * CONSUMER : Récupère les jobs pending avec locking (SELECT FOR UPDATE SKIP LOCKED)
 * @param {number} limit - Nombre max de jobs à récupérer
 * @returns {Promise<Array>} Jobs à traiter
 */
async function fetchPendingJobs(limit = DEFAULT_BATCH_SIZE) {
    if (isCircuitBreakerOpen()) {
        logger.warn("⏸️ Circuit breaker OPEN - consumer en pause");
        return [];
    }

    const { rows } = await pool.query(
        `
        WITH selected AS (
            SELECT id FROM webhook_queue
            WHERE status = 'pending'
              AND (next_retry_at IS NULL OR next_retry_at <= NOW())
            ORDER BY created_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE webhook_queue
        SET status = 'processing', processed_at = NOW()
        WHERE id IN (SELECT id FROM selected)
        RETURNING id, payload, type, attempt, max_attempts
    `,
        [limit],
    );

    return rows;
}

/**
 * CONSUMER : Marque un job comme terminé avec succès
 */
async function markCompleted(jobId) {
    await pool.query(
        `UPDATE webhook_queue SET status = 'completed', processed_at = NOW() WHERE id = $1`,
        [jobId],
    );
    recordResult(true);
    logger.debug(`✅ Webhook job #${jobId} completed`);
}

/**
 * CONSUMER : Marque un job échoué avec retry ou dead-letter
 */
async function markFailed(jobId, error, attempt, maxAttempts) {
    const nextAttempt = attempt + 1;

    if (nextAttempt >= maxAttempts) {
        await pool.query(
            `UPDATE webhook_queue
             SET status = 'dead_letter', error = $2, processed_at = NOW()
             WHERE id = $1`,
            [jobId, error.message || String(error)],
        );
        recordResult(false);
        logger.error(
            `💀 Webhook job #${jobId} moved to DEAD LETTER after ${attempt} attempts: ${error}`,
        );
    } else {
        const delayMs = Math.pow(2, attempt) * 1000;
        const nextRetry = new Date(Date.now() + delayMs);

        await pool.query(
            `UPDATE webhook_queue
             SET status = 'pending', attempt = $2, error = $3, next_retry_at = $4
             WHERE id = $1`,
            [jobId, nextAttempt, error.message || String(error), nextRetry],
        );
        recordResult(false);
        logger.warn(
            `⚠️ Webhook job #${jobId} failed, retry #${nextAttempt}/${maxAttempts} in ${delayMs}ms`,
        );
    }
}

/**
 * Circuit Breaker : Détecte si trop d'échecs récents
 */
function isCircuitBreakerOpen() {
    if (!circuitBreakerEnabled) return false;
    if (Date.now() < circuitBreakerPausedUntil) return true;

    const windowStart = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
    const recent = recentResults.filter((r) => r.time > windowStart);

    if (recent.length < 10) return false;

    const failed = recent.filter((r) => !r.success).length;
    const failureRate = failed / recent.length;

    if (failureRate > CIRCUIT_BREAKER_THRESHOLD) {
        circuitBreakerPausedUntil = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
        logger.error(
            `🔥 Circuit breaker TRIGGERED: ${(failureRate * 100).toFixed(1)}% échecs sur ${recent.length} dernières requêtes`,
        );
        return true;
    }

    return false;
}

function recordResult(success) {
    recentResults.push({ success, time: Date.now() });
    if (recentResults.length > 100) {
        recentResults = recentResults.slice(-50);
    }
}

/**
 * Lance le consumer en arrière-plan via le scheduler existant
 * @param {Function} processor - Fonction async( payload, type ) => void
 * @param {Object} opts - { concurrency, batchSize, intervalMs }
 */
function startConsumer(processor, opts = {}) {
    const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
    const batchSize = opts.batchSize || DEFAULT_BATCH_SIZE;
    const intervalMs = opts.intervalMs || 1000;

    logger.info(
        `🚀 WebhookConsumer: start (concurrency=${concurrency}, batch=${batchSize}, interval=${intervalMs}ms)`,
    );

    schedule(
        "webhook-consumer",
        async () => {
            const jobs = await fetchPendingJobs(batchSize);

            if (jobs.length === 0) return;

            logger.debug(`📦 WebhookConsumer: ${jobs.length} jobs à traiter`);

            const promises = jobs.slice(0, concurrency).map(async (job) => {
                try {
                    await processor(job.payload, job.type);
                    await markCompleted(job.id);
                } catch (err) {
                    await markFailed(
                        job.id,
                        err,
                        job.attempt,
                        job.max_attempts,
                    );
                }
            });

            await Promise.all(promises);
        },
        {
            intervalMs,
            jitterMs: 500,
            runAtStart: true,
            delayMs: 2000,
        },
    );
}

/**
 * Retourne les stats de la queue (pour monitoring)
 */
async function getQueueStats() {
    const { rows } = await pool.query(`
        SELECT status, COUNT(*) as count
        FROM webhook_queue
        GROUP BY status
    `);

    const stats = {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        dead_letter: 0,
    };
    rows.forEach((r) => {
        if (stats.hasOwnProperty(r.status)) {
            stats[r.status] = parseInt(r.count, 10);
        }
    });

    return stats;
}

/**
 * Retry manuel d'un job dead-letter
 */
async function retryDeadLetter(jobId) {
    await pool.query(
        `UPDATE webhook_queue
         SET status = 'pending', attempt = 0, error = NULL, next_retry_at = NOW()
         WHERE id = $1 AND status = 'dead_letter'`,
        [jobId],
    );
    logger.info(`🔄 Webhook job #${jobId} réinjecté dans la queue`);
}

/**
 * Nettoyage des jobs complétés (à appeler périodiquement)
 */
async function cleanupOldJobs(daysOld = 7) {
    const result = await pool.query(
        `DELETE FROM webhook_queue
         WHERE status = 'completed'
           AND processed_at < NOW() - INTERVAL '1 day' * $1`,
        [daysOld],
    );
    logger.info(
        `🧹 WebhookQueue: ${result.rowCount} jobs vieux de >${daysOld}j supprimés`,
    );
}

module.exports = {
    QUEUE_STATUS,
    initQueueSchema,
    enqueue,
    startConsumer,
    getQueueStats,
    retryDeadLetter,
    cleanupOldJobs,
    fetchPendingJobs,
    markCompleted,
    markFailed,
};
