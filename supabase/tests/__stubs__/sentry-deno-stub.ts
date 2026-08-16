// Stub pour 'npm:@sentry/deno@^8' quand un module d'Edge Function est importé
// sous vitest/Node (voir vitest.config.ts resolve.alias) — le vrai paquet est
// résolu par Deno au déploiement, pas par Node.
//
// Sous test, `SENTRY_DSN` n'est jamais défini : `_shared/sentry.ts` n'appelle
// donc ni `init` ni aucune des fonctions ci-dessous, et `withSentry` retourne
// le handler inchangé. Ce stub existe uniquement pour que l'import se résolve —
// il n'est pas là pour simuler le comportement de Sentry, et ne doit pas servir
// à écrire un test qui prétendrait le faire.

export function init(_options: unknown): void {}
export function setTag(_key: string, _value: string): void {}
export function withScope(callback: (scope: { setTag(k: string, v: string): void }) => void): void {
  callback({ setTag() {} })
}
export function captureException(_err: unknown): void {}
export function flush(_timeout?: number): Promise<boolean> {
  return Promise.resolve(true)
}
