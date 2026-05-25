require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const db = {
  reservations: [],
  conversations: {},
  nextId: 1,
};

const SYSTEM_PROMPT = `
Eres el asistente virtual de "Restaurante La Terraza", un restaurante de cocina mediterránea en Ciudad de México.

TU OBJETIVO: Ayudar a los clientes a hacer reservas por WhatsApp de manera amigable, eficiente y profesional.

HORARIOS DEL RESTAURANTE:
- Lunes a Viernes: 13:00 - 23:00
- Sábados y Domingos: 12:00 - 23:00
- Cerrado: Los martes

CAPACIDAD DE MESAS:
- Mesas 1-5: 2 personas
- Mesas 6-10: 4 personas
- Mesas 11-14: 6 personas
- Mesa 15: 10 personas (sala privada)

FLUJO DE RESERVA:
1. Saluda y pregunta el NOMBRE del cliente
2. Pregunta la FECHA deseada
3. Pregunta la HORA deseada
4. Pregunta el NUMERO DE PERSONAS
5. Asigna la mesa mas apropiada
6. Muestra un RESUMEN y pide confirmacion
7. Al confirmar, responde con este formato exacto:

<RESERVA_CONFIRMADA>
{
  "nombre": "...",
  "telefono": "...",
  "fecha": "...",
  "hora": "...",
  "personas": ...,
  "mesa": ...,
  "notas": "..."
}
</RESERVA_CONFIRMADA>

REGLAS:
- Se siempre amable y usa emojis con moderacion
- Si el dia esta cerrado (martes), ofrece otro dia
- Si la hora esta fuera de rango, sugiere la mas cercana
- Para cancelaciones, pide nombre y fecha
- Responde siempre en español
`;

async function askClaude(phone, userMessage) {
  if (!db.conversations[phone]) {
    db.conversations[phone] = [];
  }

  db.conversations[phone].push({
    role: 'user',
    content: userMessage,
  });

  const history = db.conversations[phone].slice(-20);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const assistantMsg = response.content[0].text;

  db.conversations[phone].push({
    role: 'assistant',
    content: assistantMsg,
  });

  return assistantMsg;
}

function extractAndSaveReservation(phone, aiResponse) {
  const match = aiResponse.match(/<RESERVA_CONFIRMADA>([\s\S]*?)<\/RESERVA_CONFIRMADA>/);
  if (!match) return null;

  try {
    const data = JSON.parse(match[1].trim());
    const reservation = {
      id: db.nextId++,
      ...data,
      telefono: phone,
      estado: 'confirmada',
      creadaEn: new Date().toISOString(),
    };
    db.reservations.push(reservation);
    return reservation;
  } catch (e) {
    return null;
  }
}

async function sendWhatsAppMessage(to, message) {
  const cleanMsg = message
    .replace(/<RESERVA_CONFIRMADA>[\s\S]*?<\/RESERVA_CONFIRMADA>/g, '')
    .trim();

  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) {
    console.log(`[SIMULACION] Para: ${to}\nMensaje: ${cleanMsg}`);
    return;
  }

  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: cleanMsg },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    const msg = messages[0];
    if (msg.type !== 'text') return;

    const phone = msg.from;
    const userText = msg.text.body;

    const aiResponse = await askClaude(phone, userText);
    extractAndSaveReservation(phone, aiResponse);
    await sendWhatsAppMessage(phone, aiResponse);

  } catch (error) {
    console.error('Error:', error.message);
  }
});

app.get('/api/reservations', (req, res) => {
  const { fecha, estado } = req.query;
  let result = [...db.reservations];
  if (fecha) result = result.filter(r => r.fecha === fecha);
  if (estado) result = result.filter(r => r.estado === estado);
  result.sort((a, b) => (a.hora > b.hora ? 1 : -1));
  res.json(result);
});

app.post('/api/reservations', (req, res) => {
  const { nombre, telefono, fecha, hora, personas, notas } = req.body;
  if (!nombre || !fecha || !hora || !personas) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  const mesa = personas <= 2 ? Math.floor(Math.random() * 5) + 1
    : personas <= 4 ? Math.floor(Math.random() * 5) + 6
    : personas <= 6 ? Math.floor(Math.random() * 4) + 11
    : 15;
  const reservation = {
    id: db.nextId++,
    nombre, telefono: telefono || 'N/A',
    fecha, hora, personas: parseInt(personas),
    mesa, notas: notas || '',
    estado: 'confirmada',
    creadaEn: new Date().toISOString(),
  };
  db.reservations.push(reservation);
  res.status(201).json(reservation);
});

app.patch('/api/reservations/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.reservations.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
  db.reservations[idx] = { ...db.reservations[idx], ...req.body };
  res.json(db.reservations[idx]);
});

app.delete('/api/reservations/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.reservations.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
  db.reservations[idx].estado = 'cancelada';
  res.json({ ok: true, id });
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const active = db.reservations.filter(r => r.estado === 'confirmada');
  res.json({
    totalHoy: active.filter(r => r.fecha === today).length,
    totalSemana: active.length,
    personasHoy: active.filter(r => r.fecha === today).reduce((s, r) => s + r.personas, 0),
    mesasOcupadas: new Set(active.filter(r => r.fecha === today).map(r => r.mesa)).size,
  });
});

app.post('/api/simulate', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone y message requeridos' });
  }
  try {
    const aiResponse = await askClaude(phone, message);
    const reservation = extractAndSaveReservation(phone, aiResponse);
    const cleanMsg = aiResponse
      .replace(/<RESERVA_CONFIRMADA>[\s\S]*?<\/RESERVA_CONFIRMADA>/g, '')
      .trim();
    res.json({ response: cleanMsg, reservation: reservation || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RestIA corriendo en puerto ${PORT}`);
});
