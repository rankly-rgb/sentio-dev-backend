# Templates email Supabase Auth

Ces templates sont à coller dans :
**Supabase Dashboard → Authentication → Email Templates**

Le frontend DOIT passer `locale` dans les métadonnées user au moment du signUp :
```ts
supabase.auth.signUp({
  email,
  password,
  options: {
    data: { locale: 'en' | 'fr' },
    emailRedirectTo: 'https://app.sentioapp.io/auth/callback',
  },
})
```

---

## Confirm signup

**Subject (FR) :** `Confirmez votre email — Sentio AI`
**Subject (EN) :** `Confirm your email — Sentio AI`

Comme Supabase ne supporte pas de subject conditionnel, utiliser un sujet neutre :
**Subject :** `Sentio AI — Activate your account / Activez votre compte`

**Body (HTML) :**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="padding:0 24px 32px;">
              <p style="margin:0;color:#94a3b8;font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;">
                SENTIO AI
              </p>
            </td>
          </tr>

          <!-- Hero -->
          <tr>
            <td style="background:#1e293b;border-radius:12px 12px 0 0;padding:40px 40px 32px;">
              {{ if eq .UserMetaData.locale "en" }}
              <h1 style="margin:0 0 12px;color:#f8fafc;font-size:28px;font-weight:700;line-height:1.2;">
                Your churn radar is ready.<br>Confirm to activate it.
              </h1>
              <p style="margin:0;color:#94a3b8;font-size:15px;line-height:1.6;">
                In under 60 seconds after confirming, you'll see which accounts are silently heading for the exit — before they ghost you.
              </p>
              {{ else }}
              <h1 style="margin:0 0 12px;color:#f8fafc;font-size:28px;font-weight:700;line-height:1.2;">
                Votre radar de churn est prêt.<br>Confirmez pour l'activer.
              </h1>
              <p style="margin:0;color:#94a3b8;font-size:15px;line-height:1.6;">
                En moins de 60 secondes après confirmation, vous verrez quels comptes se dirigent silencieusement vers la sortie — avant qu'ils disparaissent.
              </p>
              {{ end }}
            </td>
          </tr>

          <!-- Stats -->
          <tr>
            <td style="background:#1e293b;padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="33%" style="text-align:center;padding:16px;border:1px solid #334155;border-radius:8px;">
                    <p style="margin:0;color:#f8fafc;font-size:20px;font-weight:700;">&lt; 1 min</p>
                    <p style="margin:4px 0 0;color:#64748b;font-size:12px;">
                      {{ if eq .UserMetaData.locale "en" }}to first insight{{ else }}premier insight{{ end }}
                    </p>
                  </td>
                  <td width="4%"></td>
                  <td width="30%" style="text-align:center;padding:16px;border:1px solid #334155;border-radius:8px;">
                    <p style="margin:0;color:#f8fafc;font-size:20px;font-weight:700;">Zero</p>
                    <p style="margin:4px 0 0;color:#64748b;font-size:12px;">
                      {{ if eq .UserMetaData.locale "en" }}PII stored{{ else }}PII stocké{{ end }}
                    </p>
                  </td>
                  <td width="4%"></td>
                  <td width="29%" style="text-align:center;padding:16px;border:1px solid #334155;border-radius:8px;">
                    <p style="margin:0;color:#f8fafc;font-size:20px;font-weight:700;">Real-time</p>
                    <p style="margin:4px 0 0;color:#64748b;font-size:12px;">
                      {{ if eq .UserMetaData.locale "en" }}risk scoring{{ else }}scoring risque{{ end }}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="background:#1e293b;border-radius:0 0 12px 12px;padding:0 40px 40px;">
              <a href="{{ .ConfirmationURL }}"
                 style="display:block;text-align:center;background:#6366f1;color:#fff;text-decoration:none;padding:16px 24px;border-radius:8px;font-size:16px;font-weight:600;">
                {{ if eq .UserMetaData.locale "en" }}
                Confirm my email &amp; connect Stripe →
                {{ else }}
                Confirmer mon email &amp; connecter Stripe →
                {{ end }}
              </a>
              <p style="margin:12px 0 0;text-align:center;color:#64748b;font-size:12px;">
                {{ if eq .UserMetaData.locale "en" }}
                Link expires in 24 hours · No credit card required
                {{ else }}
                Lien valable 24h · Aucune carte bancaire requise
                {{ end }}
              </p>
            </td>
          </tr>

          <!-- GDPR notice -->
          <tr>
            <td style="padding:24px 0 0;">
              <table width="100%" cellpadding="16" cellspacing="0" style="background:#1e293b;border-radius:8px;border:1px solid #334155;">
                <tr>
                  <td>
                    <p style="margin:0 0 4px;color:#f8fafc;font-size:13px;font-weight:600;">
                      🛡️ {{ if eq .UserMetaData.locale "en" }}Built for GDPR by design{{ else }}Conçu pour le RGPD dès la conception{{ end }}
                    </p>
                    <p style="margin:0;color:#64748b;font-size:12px;line-height:1.5;">
                      {{ if eq .UserMetaData.locale "en" }}
                      Sentio never stores personal data. We only work with Stripe &amp; HubSpot IDs — your customers' privacy is structurally protected.
                      {{ else }}
                      Sentio ne stocke jamais de données personnelles. Nous travaillons uniquement avec les IDs Stripe &amp; HubSpot — la vie privée de vos clients est structurellement protégée.
                      {{ end }}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 0 0;text-align:center;">
              <p style="margin:0;color:#475569;font-size:11px;">
                {{ if eq .UserMetaData.locale "en" }}
                You received this email because you signed up for Sentio AI. If you didn't, ignore this email.
                {{ else }}
                Vous recevez cet email car vous venez de créer un compte Sentio AI. Si ce n'est pas vous, ignorez cet email.
                {{ end }}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## Configuration Supabase requise

Dans **Authentication → URL Configuration** :
- **Site URL** : `https://app.sentioapp.io`
- **Redirect URLs** : `https://app.sentioapp.io/**`

---

## Flow complet après confirmation

```
{{ .ConfirmationURL }}
  ↓
https://app.sentioapp.io/auth/callback?token_hash=...&type=signup
  ↓
Frontend échange le token (supabase.auth.exchangeCodeForSession)
  ↓
Si type=signup → redirect /onboarding/promise
Si type=recovery → redirect /auth/reset-password
Sinon → redirect /dashboard
```
