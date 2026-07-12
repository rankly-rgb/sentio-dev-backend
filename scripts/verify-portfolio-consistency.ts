/**
 * verify-portfolio-consistency.ts
 * Vérifie que le RPC get_portfolio_snapshot (source unique consommée par
 * dashboard-api, accounts-api, get-today-status — chantier 5.1) reste
 * cohérent avec des agrégats recalculés indépendamment.
 *
 * Ne fait PAS un test HTTP des 3 endpoints (nécessiterait un JWT
 * utilisateur — impossible sans PII ou effet de bord sur ce repo, voir
 * plan Action 6). Vérifie la source SQL partagée à la place : les 3
 * endpoints appellent tous littéralement ce même RPC, donc le vérifier
 * couvre la même garantie de cohérence.
 *
 * Usage :
 *   npx tsx scripts/verify-portfolio-consistency.ts [organization_id]
 *   (sans argument : vérifie toutes les orgs actives)
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
function getEnv(key: string): string {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) throw new Error(`${key} manquant dans .env.local`);
  return m[1].trim();
}

const supabase = createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"));

interface PortfolioSnapshot {
  total_accounts: number;
  total_mrr_cents: number;
  avg_health_score: number | null;
  champions_count: number;
  at_risk_count: number;
  scored_accounts_count: number;
}

async function verifyOrg(orgId: string): Promise<boolean> {
  const { data: snapshot, error: rpcError } = await supabase
    .rpc("get_portfolio_snapshot", { p_organization_id: orgId })
    .maybeSingle<PortfolioSnapshot>();

  if (rpcError || !snapshot) {
    console.error(`  ERREUR RPC pour org ${orgId}: ${rpcError?.message}`);
    return false;
  }

  // Pagination manuelle : PostgREST plafonne à 1000 lignes par défaut —
  // sans ça, la comparaison serait biaisée sur toute org > 1000 comptes
  // (exactement le bug rencontré et corrigé plus tôt dans ce chantier).
  const rows: Array<{ mrr_cents: number | null; health_score: number | null; churn_risk_score: number | null }> = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: accErr } = await supabase
      .from("accounts")
      .select("mrr_cents, health_score, churn_risk_score")
      .eq("organization_id", orgId)
      .range(from, from + PAGE_SIZE - 1);

    if (accErr) {
      console.error(`  ERREUR accounts pour org ${orgId}: ${accErr.message}`);
      return false;
    }
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const expectedTotal = rows.length;
  const expectedMrr = rows.reduce((sum, a) => sum + (a.mrr_cents ?? 0), 0);
  const scored = rows.filter((a) => a.churn_risk_score !== null);
  const expectedScored = scored.length;
  const expectedAtRisk = scored.filter((a) => (a.churn_risk_score ?? 0) > 70).length;
  const healthValues = rows.map((a) => a.health_score).filter((h): h is number => h !== null);
  const expectedAvgHealth =
    healthValues.length > 0
      ? Math.round((healthValues.reduce((s, h) => s + h, 0) / healthValues.length) * 10) / 10
      : null;

  // Comptage indépendant de champions_count : même méthode à 2 étapes que
  // l'ancien code pré-RPC de get-today-status (segment id, puis memberships).
  const { data: championsSegment, error: segErr } = await supabase
    .from("account_segments")
    .select("id")
    .eq("organization_id", orgId)
    .eq("segment_type", "champions")
    .maybeSingle();

  if (segErr) {
    console.error(`  ERREUR segment champions pour org ${orgId}: ${segErr.message}`);
    return false;
  }

  let championsCount = 0;
  if (championsSegment) {
    const { count, error: champErr } = await supabase
      .from("segment_memberships")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("segment_id", championsSegment.id)
      .eq("status", "active");

    if (champErr) {
      console.error(`  ERREUR champions pour org ${orgId}: ${champErr.message}`);
      return false;
    }
    championsCount = count ?? 0;
  }

  const diffs: string[] = [];
  if (snapshot.total_accounts !== expectedTotal) {
    diffs.push(`total_accounts: rpc=${snapshot.total_accounts} vs recalculé=${expectedTotal}`);
  }
  if (snapshot.total_mrr_cents !== expectedMrr) {
    diffs.push(`total_mrr_cents: rpc=${snapshot.total_mrr_cents} vs recalculé=${expectedMrr}`);
  }
  if (snapshot.scored_accounts_count !== expectedScored) {
    diffs.push(`scored_accounts_count: rpc=${snapshot.scored_accounts_count} vs recalculé=${expectedScored}`);
  }
  if (snapshot.at_risk_count !== expectedAtRisk) {
    diffs.push(`at_risk_count: rpc=${snapshot.at_risk_count} vs recalculé=${expectedAtRisk}`);
  }
  if (snapshot.champions_count !== championsCount) {
    diffs.push(`champions_count: rpc=${snapshot.champions_count} vs recalculé=${championsCount}`);
  }
  const rpcAvgHealth = snapshot.avg_health_score !== null ? Number(snapshot.avg_health_score) : null;
  if (rpcAvgHealth !== expectedAvgHealth) {
    diffs.push(`avg_health_score: rpc=${rpcAvgHealth} vs recalculé=${expectedAvgHealth}`);
  }

  if (diffs.length > 0) {
    console.error(`  DIVERGENCE org ${orgId}:`);
    for (const d of diffs) console.error(`    - ${d}`);
    return false;
  }

  console.log(`  OK org ${orgId} (${expectedTotal} comptes)`);
  return true;
}

async function main() {
  const argOrgId = process.argv[2];
  let orgIds: string[];

  if (argOrgId) {
    orgIds = [argOrgId];
  } else {
    const { data: orgs, error } = await supabase.from("organizations").select("id").eq("is_active", true);
    if (error) throw error;
    orgIds = (orgs ?? []).map((o) => o.id);
  }

  console.log(`Vérification de ${orgIds.length} org(s)...`);
  let allOk = true;
  for (const orgId of orgIds) {
    const ok = await verifyOrg(orgId);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    console.error("\nDes divergences ont été détectées.");
    process.exit(1);
  }
  console.log("\nToutes les orgs vérifiées sont cohérentes.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
