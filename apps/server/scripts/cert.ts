/**
 * Self-signed certificate for HTTPS in the LAN (certs/cert.pem + certs/key.pem, picked up by the server on start).
 * Covers localhost and every current IPv4 address of this machine. Browsers warn once ("not secure" → proceed),
 * after that Web Bluetooth works on phones and tablets too.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../certs/', import.meta.url));
mkdirSync(dir, { recursive: true });
const ips = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4')
  .map((i) => i!.address);
const host = hostname().replace(/\.local$/, '');
const san = ['DNS:localhost', `DNS:${host}`, `DNS:${host}.local`, ...ips.map((ip) => `IP:${ip}`)].join(',');

execFileSync(
  'openssl',
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
    '-keyout', `${dir}key.pem`, '-out', `${dir}cert.pem`,
    '-subj', '/CN=Velo Sim (lokal)', '-addext', `subjectAltName=${san}`],
  { stdio: 'inherit' },
);
console.log(`Zertifikat in ${dir} für ${san}\nServer neu starten – dann https://<IP>:8443 öffnen.`);
