-- Migration : Ajout du champ DPE (Diagnostic de Performance Énergétique)
-- Valeurs possibles: A, B, C, D, E, F, G

-- Ajout dans la table biens
ALTER TABLE biens ADD COLUMN IF NOT EXISTS dpe VARCHAR(1);

-- Ajout dans la table acquereur_criteria
ALTER TABLE acquereur_criteria ADD COLUMN IF NOT EXISTS dpe_min VARCHAR(1);
ALTER TABLE acquereur_criteria ADD COLUMN IF NOT EXISTS dpe_max VARCHAR(1);

-- Index pour optimiser les requêtes de matching
CREATE INDEX IF NOT EXISTS idx_biens_dpe ON biens(dpe);
CREATE INDEX IF NOT EXISTS idx_acquereur_criteria_dpe ON acquereur_criteria(dpe_min, dpe_max);