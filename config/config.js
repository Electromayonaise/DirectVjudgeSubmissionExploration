/**
 * config.js
 *
 * El sistema usa VJudge como intermediario para hacer submit a Codeforces.
 *
 * Flujo de submit:
 *   1. Se intenta con la cuenta VJudge del estudiante (My Account mode).
 *   2. Si la cuenta no tiene rango suficiente (Pupil+), VJudge devuelve
 *      "Challenge Encountered". En ese caso el sistema reintenta automáticamente
 *      con la cuenta del club configurada aquí (Bot mode).
 *
 * Para configurar la cuenta del club:
 *   - Crea o usa una cuenta VJudge con cuenta CF vinculada y rango Pupil o superior.
 *   - Ponla en club.vjHandle y club.vjPassword.
 *   - Si se deja vacío, el sistema informará al estudiante que necesita subir su rango.
 */

const config = {

  server: {
    port: 3000
  },

  // Cuenta VJudge del club — fallback cuando la cuenta del estudiante no tiene rango
  club: {
    vjHandle:   process.env.CLUB_VJ_HANDLE   || "",
    vjPassword: process.env.CLUB_VJ_PASSWORD || "",
  },

}

export default config
