// Makes the release key that signs the server's releases (decision 0052): an
// Ed25519 key pair. Its private half is the Release workflow's secret
// SERVER_SIGNING_KEY; each server built with it has its public half built in,
// and takes only updates signed with it. Keep a copy somewhere safe (a password
// manager): a new key means servers built with the old one stop updating, and
// must be installed again by hand.
//
//   node scripts/server-signing-key.mjs
import { generateKeyPairSync } from 'node:crypto';
import process from 'node:process';

const { privateKey } = generateKeyPairSync('ed25519');
process.stdout.write(`${privateKey.export({ type: 'pkcs8', format: 'pem' })}`);
process.stderr.write('\nThe private key is above: paste all of it, BEGIN and END lines too, as the secret SERVER_SIGNING_KEY\nof the release environment on GitHub, and keep a copy somewhere safe. It is not saved anywhere.\n');
