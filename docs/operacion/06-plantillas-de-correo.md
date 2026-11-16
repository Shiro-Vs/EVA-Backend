# 06 — Plantillas de correo

Plantillas en español de los correos de Supabase Auth. Salen por Resend con remitente `EVA <noreply@eva-app.lat>` (ver [03 §4](03-integraciones.md)).

> Estado: vigente al 17 de noviembre de 2026. Las plantillas se pegan a mano en Supabase; **guardar cada una** para que se apliquen.

Dónde pegarlas: Supabase → Authentication → Emails → Templates. En cada plantilla hay dos campos: **Subject** (asunto) y **Message body** (cuerpo, en HTML). Pega el asunto y el cuerpo tal cual; las variables `{{ .ConfirmationURL }}` y `{{ .Email }}` las rellena Supabase.

## 1. Confirm sign up (confirmar registro)

**Subject:** `Confirma tu correo en EVA`

**Message body:**

```html
<div style="background:#f4f1fa;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" align="center" width="100%" style="max-width:480px;background:#ffffff;border-radius:20px;padding:32px;">
    <tr><td>
      <p style="margin:0 0 4px;font-size:13px;letter-spacing:2px;color:#6b4bb0;font-weight:bold;">EVA</p>
      <h1 style="margin:0 0 16px;font-size:22px;color:#1d1433;">Confirma tu correo</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#3b3452;">
        Gracias por crear tu cuenta en EVA. Toca el botón para confirmar que <strong>{{ .Email }}</strong> es tuyo y terminar el registro.
      </p>
      <p style="margin:0 0 24px;">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#5b21b6;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 28px;border-radius:14px;">Confirmar mi correo</a>
      </p>
      <p style="margin:0;font-size:12px;line-height:1.5;color:#7a7390;">
        Si no creaste esta cuenta, ignora este mensaje: no pasará nada.
      </p>
    </td></tr>
  </table>
</div>
```

## 2. Reset password (recuperar contraseña) — con CÓDIGO

La app no usa un enlace para recuperar la contraseña: pide un **código de 6 dígitos** que la persona escribe en la pantalla «Nueva contraseña». Así funciona también en Expo Go y no lo «gastan» los programas de correo que abren los enlaces por su cuenta. La plantilla tiene que mostrar `{{ .Token }}` (no el enlace).

**Subject:** `Tu código para cambiar la contraseña de EVA`

**Message body:**

```html
<div style="background:#f4f1fa;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" align="center" width="100%" style="max-width:480px;background:#ffffff;border-radius:20px;padding:32px;">
    <tr><td>
      <p style="margin:0 0 4px;font-size:13px;letter-spacing:2px;color:#6b4bb0;font-weight:bold;">EVA</p>
      <h1 style="margin:0 0 16px;font-size:22px;color:#1d1433;">Cambia tu contraseña</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#3b3452;">
        Recibimos una solicitud para cambiar la contraseña de <strong>{{ .Email }}</strong>. Escribe este código en la app:
      </p>
      <p style="margin:0 0 24px;font-size:34px;letter-spacing:8px;font-weight:bold;color:#5b21b6;text-align:center;background:#f4f1fa;border-radius:14px;padding:16px 8px;">
        {{ .Token }}
      </p>
      <p style="margin:0;font-size:12px;line-height:1.5;color:#7a7390;">
        El código vence en 1 hora. Si no fuiste tú, ignora este mensaje: tu contraseña actual sigue siendo la misma.
      </p>
    </td></tr>
  </table>
</div>
```

## Pendiente

- **Colores:** estas plantillas usan el violeta heredado; la identidad de EVA es la Paleta 1 · Pizarra (azul `#0369B2`, ámbar). Cambiar `#5b21b6`, `#6b4bb0` y `#f4f1fa` por los de la marca cuando se decida (ver [PENDIENTES](../PENDIENTES.md), P-12).
- **Site URL:** el enlace de confirmación lleva a `https://www.eva-app.lat/confirmado/` (Authentication → URL Configuration).
- Las plantillas «Magic link», «Change email address», «Invite user» y «Reauthentication» no se usan todavía; se traducen cuando se activen esas funciones.
