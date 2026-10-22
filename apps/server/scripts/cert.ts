/**
 * Local certificate authority + server certificate for HTTPS in the LAN (certs/, picked up by the server on start).
 * The server certificate covers localhost and every current IPv4 address of this machine; rerun after the IP changes
 * (the CA stays). Install certs/ca.crt once on a phone (the server offers it at /velo-ca.crt) and Chrome trusts the
 * page fully, so Web Bluetooth works there too.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../certs/', import.meta.url));
mkdirSync(dir, { recursive: true });
const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });

if (!existsSync(`${dir}ca-key.pem`)) {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
    '-keyout', `${dir}ca-key.pem`, '-out', `${dir}ca.pem`, '-subj', `/CN=Velo Sim lokal (${hostname()})`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  openssl('x509', '-in', `${dir}ca.pem`, '-outform', 'der', '-out', `${dir}ca.crt`);
  console.log('Neue lokale Zertifizierungsstelle erstellt – auf den Handys einmal ca.crt installieren.');
}

const ips = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4')
  .map((i) => i!.address);
const host = hostname().replace(/\.local$/, '');
const san = ['DNS:localhost', `DNS:${host}`, `DNS:${host}.local`, ...ips.map((ip) => `IP:${ip}`)].join(',');
const ext = `${dir}server.ext`;
writeFileSync(ext, `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}key.pem`, '-out', `${dir}server.csr`, '-subj', '/CN=Velo Sim');
openssl('x509', '-req', '-in', `${dir}server.csr`, '-CA', `${dir}ca.pem`, '-CAkey', `${dir}ca-key.pem`, '-CAcreateserial',
  '-days', '397', '-sha256', '-extfile', ext, '-out', `${dir}cert.pem`);
rmSync(`${dir}server.csr`);
rmSync(ext);
console.log(`Zertifikat für ${san}\nServer neu starten – dann https://<IP>:8443 öffnen (CA: https://<IP>:8443/velo-ca.crt).`);
