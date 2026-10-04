// Plantilla del correo de encuesta (recordatorio semanal de reporte).
// Un solo lugar para el texto: scheduler, envío manual y reintentos lo usan
// todos (a diferencia de las plantillas de citas, que están duplicadas).
const { dateLabelLong } = require('./wallTime');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function firstName(name) {
  const n = String(name || '').trim();
  return n ? n.split(/\s+/)[0] : '';
}

function buildSurveyEmail({ patient, url, date, signature = 'Doctora Flor', expiresAt }) {
  const name = firstName(patient?.name) || '';
  const greeting = name ? `Hola ${name},` : 'Hola,';
  const dateLabel = date ? dateLabelLong(date) : '';
  const expiry = expiresAt ? new Date(expiresAt) : null;
  const expiryLabel = expiry && !isNaN(expiry.getTime())
    ? expiry.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
    : '';

  const subject = `Reporte de seguimiento${name ? ` - ${name}` : ''}`;
  const body = `${greeting}

Soy ${signature}. Espero que te encuentres muy bien.

Te escribo con una cordial recordatorio para que realices tu reporte de seguimiento${dateLabel ? ` del ${dateLabel}` : ''}. Son unas breves preguntas de opción múltiple: no necesitas escribir nada y toma menos de 2 minutos.

Ingresa aquí para responder:
${url}

Tu respuesta me permite verificar cómo te has sentido, si el medicamento te está haciendo efecto y si hay alguna molestia que debamos atender a tiempo.

Si tienes alguna duda o malestar, puedes responder a este correo o indicarlo en la última pregunta del reporte.

Gracias por tu confianza y por cuidarte.

Con aprecio,
${signature}${expiryLabel ? `\n\n(Puedes completar el reporte hasta el ${expiryLabel}.)` : ''}

-- 
Mensaje automático de seguimiento. No respondas a este correo.`;

  const html = `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:0;background:#f4f5fb;font-family:Arial,Helvetica,sans-serif;color:#1f2333;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fb;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6e8f2;">
        <tr>
          <td style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px 28px;">
            <div style="font-size:13px;color:#e0e7ff;letter-spacing:.4px;">CONTROLPESO · SEGUIMIENTO</div>
            <div style="font-size:20px;font-weight:bold;color:#ffffff;margin-top:6px;">Reporte de seguimiento</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 28px 8px 28px;font-size:15px;line-height:1.6;">
            <p style="margin:0 0 14px 0;">${greeting}</p>
            <p style="margin:0 0 14px 0;">Soy <strong>${signature}</strong>. Espero que te encuentres muy bien.</p>
            <p style="margin:0 0 14px 0;">Te escribo con una cordial recordatorio para que realices tu reporte de seguimiento${dateLabel ? ` del <strong>${dateLabel}</strong>` : ''}. Son unas breves preguntas de opción múltiple: no necesitas escribir nada y toma menos de 2 minutos.</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:10px 28px 22px 28px;">
            <a href="${url}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 28px;border-radius:10px;font-size:15px;">Responder mi reporte</a>
            <div style="font-size:12px;color:#8b90a6;margin-top:12px;">O copia este enlace: <span style="word-break:break-all;">${url}</span></div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 24px 28px;font-size:14px;line-height:1.6;color:#4b5169;">
            <p style="margin:0 0 14px 0;">Tu respuesta me permite verificar cómo te has sentido, si el medicamento te está haciendo efecto y si hay alguna molestia que debamos atender a tiempo.</p>
            <p style="margin:0;">Gracias por tu confianza y por cuidarte.<br/><strong>${signature}</strong>${expiryLabel ? `<br/><span style="font-size:12px;color:#8b90a6;">Puedes completar el reporte hasta el ${expiryLabel}.</span>` : ''}</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f7f8fc;padding:14px 28px;font-size:11px;color:#9aa0b4;line-height:1.5;">
            Mensaje automático de seguimiento. No respondas a este correo.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, body, html };
}

module.exports = { buildSurveyEmail, EMAIL_RE, firstName };
