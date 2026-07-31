/* Подписване чрез Azure Trusted Signing (Artifact Signing) по време на изграждане.
 *
 * electron-builder извиква тази кука за всеки файл, който трябва да се подпише
 * (програмата, деинсталатора, инсталатора) — ПРЕДИ да изчисли хешовете за
 * latest.yml. Затова подписването тук не чупи автоматичното обновяване, за
 * разлика от подписване след публикуване.
 *
 * Куката се включва само от workflow-а, и то само когато тайните за Azure са
 * налични (подава се като --config.win.sign=tools/azure-sign.js). Защитата
 * тук е втора линия: без настройка не прави нищо, вместо да провали изграждането.
 *
 * Удостоверяването става през стандартните променливи на Azure
 * (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET), които модулът
 * TrustedSigning чете сам чрез DefaultAzureCredential.
 */
const { execFileSync } = require('child_process');

const psq = (v) => String(v).replace(/'/g, "''");

exports.default = async function (configuration) {
  const { path: file } = configuration;
  const endpoint = process.env.AZURE_SIGN_ENDPOINT;
  const account = process.env.AZURE_SIGN_ACCOUNT;
  const profile = process.env.AZURE_SIGN_PROFILE;
  if (!endpoint || !account || !profile) {
    console.log(`  · azure-sign: пропуснато (няма настройка) — ${file}`);
    return;
  }
  console.log(`  · azure-sign: подписване на ${file}`);
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Invoke-TrustedSigning -Endpoint '${psq(endpoint)}'` +
    ` -CodeSigningAccountName '${psq(account)}'` +
    ` -CertificateProfileName '${psq(profile)}'` +
    ` -Files '${psq(file)}'` +
    ` -FileDigest SHA256` +
    ` -TimestampRfc3161 'http://timestamp.acs.microsoft.com'` +
    ` -TimestampDigest SHA256`
  ], { stdio: 'inherit' });
};
