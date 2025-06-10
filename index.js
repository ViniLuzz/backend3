import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import Tesseract from 'tesseract.js';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import Stripe from 'stripe';
import admin from 'firebase-admin';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

dotenv.config();
const app = express();
const uploadsDir = path.resolve(process.cwd(), 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  try {
    fs.chmodSync(uploadsDir, '755');
  } catch (error) {
    console.warn('Erro ao definir permissões do diretório uploads:', error);
  }
}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não suportado.'));
    }
  }
});

app.use(cors({
  origin: ['https://app.naosefoda.com.br', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-08-16' });
const paymentTokens = {};

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SDK))
});
const firestore = admin.firestore();

async function extractTextFromPDF(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  return data.text;
}

async function extractTextFromImage(filePath) {
  const { data: { text } } = await Tesseract.recognize(filePath, 'por');
  return text;
}

app.post('/api/analisar-contrato', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const uid = req.body.uid;
    if (!file || !uid) return res.status(400).json({ error: 'Arquivo ou UID ausente.' });

    let textoExtraido = '';
    if (file.mimetype === 'application/pdf') {
      textoExtraido = await extractTextFromPDF(file.path);
    } else if (file.mimetype.startsWith('image/')) {
      textoExtraido = await extractTextFromImage(file.path);
    } else {
      return res.status(400).json({ error: 'Tipo de arquivo não suportado.' });
    }

    const prompt = `Leia o texto abaixo de um contrato e destaque as cláusulas que podem ser de risco para o contratante, explicando cada uma delas de forma simples e leiga. Responda em tópicos.\n\nContrato:\n${textoExtraido}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Você é um assistente jurídico.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 800,
      temperature: 0.3
    });

    fs.unlinkSync(file.path);

    const resposta = completion.choices[0].message.content;
    const token = Math.random().toString(36).substr(2, 12) + Date.now();
    let resumoSeguras = [];
    let resumoRiscos = [];
    let recomendacoes = '';

    try {
      const resumoResp = await fetch('/api/resumir-clausulas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clausulas: resposta })
      });
      if (resumoResp.ok) {
        const resumoData = await resumoResp.json();
        resumoSeguras = resumoData.seguras || [];
        resumoRiscos = resumoData.riscos || [];
      }
      recomendacoes = 'Considere consultar um advogado para revisar o contrato.';
    } catch {}

    await firestore.collection('análises de contratos').doc(token).set({
      token, uid,
      data: new Date().toISOString(),
      clausulas: resposta,
      resumoSeguras,
      resumoRiscos,
      recomendacoes,
      pago: false
    });

    paymentTokens[token] = { liberado: false };
    res.json({ clausulas: resposta, token });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao processar o contrato: ' + err.message });
  }
});

app.post('/api/resumir-clausulas', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { clausulas } = req.body;
    if (!clausulas) return res.status(400).json({ error: 'Cláusulas não enviadas.' });

    const prompt = `Receba a lista de cláusulas abaixo, separe-as em duas listas: \"Cláusulas seguras\" e \"Cláusulas de risco\"...\n\nCláusulas:\n${clausulas}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Você é um assistente jurídico.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 800,
      temperature: 0.3
    });

    const resposta = completion.choices[0].message.content;
    const match = resposta.match(/{[\s\S]*}/);
    const json = match ? JSON.parse(match[0]) : JSON.parse(resposta.replace(/```json|```/g, '').trim());
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao resumir cláusulas.' });
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token não enviado.' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: { name: 'Análise Contratual Completa' },
            unit_amount: 499
          },
          quantity: 1
        }
      ],
      success_url: `https://app.naosefoda.com.br/success?token=${token}`,
      cancel_url: 'https://app.naosefoda.com.br/cancel'
    });

    await firestore.collection('análises de contratos').doc(token).update({
      session_id: session.id,
      pago: false
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar sessão de pagamento.' });
  }
});

app.get('/api/analise-liberada', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(404).json({ error: 'Token inválido.' });

  try {
    const doc = await firestore.collection('análises de contratos').doc(token).get();
    if (!doc.exists) return res.status(404).json({ error: 'Token inválido.' });

    const analise = doc.data();
    if (!analise.session_id) return res.status(400).json({ error: 'Sessão de pagamento não encontrada.' });

    const session = await stripe.checkout.sessions.retrieve(analise.session_id);
    if (session.payment_status === 'paid') {
      await firestore.collection('análises de contratos').doc(token).update({ pago: true });
      return res.json({ liberado: true });
    } else {
      return res.json({ liberado: false });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao consultar pagamento.' });
  }
});

app.get('/api/analise-por-token', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token não enviado.' });

  try {
    const doc = await firestore.collection('análises de contratos').doc(token).get();
    if (!doc.exists) return res.status(404).json({ error: 'Análise não encontrada.' });

    const analise = doc.data();
    if (!analise.pago) return res.status(403).json({ error: 'Pagamento não confirmado.' });

    return res.json({ analise });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar análise.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));