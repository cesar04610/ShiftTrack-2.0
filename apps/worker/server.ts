import express from 'express';
import { tick } from './tick.js';
const app = express();
// Deploy this service privately. Cloud Run IAM requires an OIDC identity for /tick.
app.post('/tick', async (_req, res) => {
  try {
    res.json(await tick());
  } catch {
    res.status(500).json({ message: 'No se pudo procesar el tick.' });
  }
});
app.listen(Number(process.env.PORT || 8080), '0.0.0.0');
