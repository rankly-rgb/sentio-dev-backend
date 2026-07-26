# Sentio AI SaaS FR Constitution

## Core Principles

### I. Zero-PII
Aucun stockage d'email, nom, téléphone ou adresse IP, à aucun moment — sauf mémoire transitoire de moins de 500ms nécessaire à la résolution lors d'un export.

### II. RLS obligatoire
RLS activé sur toutes les tables. Le scoping repose sur les helpers `user_organization_id()` et `user_role()`.

### III. Multi-tenant strict
`organization_id` obligatoire sur chaque table ET sur chaque clause `WHERE` de chaque requête.

### IV. Identifiants et schéma
UUID pour toutes les primary keys et foreign keys. Colonnes `created_at` et `updated_at` obligatoires sur chaque table.

### V. Migrations sûres
Migrations idempotentes. Jamais de `DROP`.

### VI. Gestion des secrets
Aucune clé secrète (`service_role`, clés API) en dur dans le code ou les migrations — toujours via Vault ou variables d'environnement.

### VII. Conventions de nommage et typage
`snake_case` pour toute convention de nommage SQL/TypeScript. TypeScript strict. Runtime Deno pour les Edge Functions.

### VIII. Modifications ciblées
Modifications de code par `str_replace` ciblé uniquement — jamais de réécriture large de fichier.

## Gouvernance des changements sensibles

Toute modification touchant RLS, les helpers (`user_organization_id()`, `user_role()`) ou l'architecture Zero-PII nécessite une validation explicite de l'utilisateur avant implémentation, même lorsqu'elle intervient via `/speckit.implement`.

## Governance

Cette constitution prime sur toute pratique de développement par défaut. Toute modification de ces règles nécessite une décision produit documentée.

**Version**: 1.0.0 | **Ratifiée**: 2026-07-26 | **Dernier amendement**: 2026-07-26
