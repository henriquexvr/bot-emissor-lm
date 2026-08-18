import { readFileSync, writeFileSync } from 'fs';
import { google } from 'googleapis';
import http from 'http';
import url from 'url';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_FILE = resolve(__dirname, '..', '..', 'credentials.json');
const TOKEN_FILE = resolve(__dirname, '..', '..', 'token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

const { installed } = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'));

const oauth2Client = new google.auth.OAuth2(
  installed.client_id,
  installed.client_secret,
  'http://localhost:3000'
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('=== AUTORIZAÇÃO GOOGLE SHEETS ===');
console.log('Abra este link no navegador:');
console.log(authUrl);
console.log('\nFaça login, autorize e AGUARDE (o servidor local captura o código automaticamente)\n');

const server = http.createServer(async (req, res) => {
  try {
    const query = url.parse(req.url, true).query;
    if (query.code) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Autorizado! Pode fechar esta aba.</h1>');

      const { tokens } = await oauth2Client.getToken(query.code);
      oauth2Client.setCredentials(tokens);
      writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
      console.log('Token salvo em token.json');
      process.exit(0);
    }
  } catch (err) {
    console.error('Erro:', err);
    res.writeHead(500);
    res.end('Erro');
  }
});

server.listen(3000, () => {
  console.log('Servidor OAuth rodando em http://localhost:3000');
});
