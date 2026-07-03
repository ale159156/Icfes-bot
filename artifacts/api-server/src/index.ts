import app from "./app";
import { logger } from "./lib/logger";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

// --- 1. CONFIGURACIÓN DEL SERVIDOR (Lo que funcionaba) ---
const rawPort = process.env["PORT"] || "10000";
const port = Number(rawPort);

app.listen(port, (err: any) => {
  if (err) { logger.error({ err }, "Error en servidor"); process.exit(1); }
  logger.info({ port }, "Servidor y Bot activos");
});

// --- 2. CONFIGURACIÓN BOT Y IA ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;

// --- 3. LÓGICA DE LECTURA Y PROMPT MAESTRO ---
async function obtenerContenidoYGenerarPregunta() {
  try {
    const res = await drive.files.list({ q: `'${process.env["DRIVE_FOLDER_ID"]}' in parents and trashed = false`, fields: "files(id, name)" });
    const archivos = (res.data.files || []).filter(f => f.name?.endsWith('.txt') || f.name?.endsWith('.pdf'));
    if (archivos.length === 0) return null;

    const arch = archivos[Math.floor(Math.random() * archivos.length)];
    const resCont = await drive.files.get({ fileId: arch.id!, alt: "media" }, { responseType: "text" });
    const texto = resCont.data.trim();

    if (texto.length < 500 || texto.toLowerCase().includes("camscanner")) return null;

    const promptMaestro = `Eres un experto en pedagogía y diseño de pruebas estandarizadas tipo ICFES Saber 11°. 
    Crea UNA pregunta de selección múltiple basada en: "${texto.substring(0, 3500)}".
    Devuelve SOLO JSON estricto:
    {"pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "descartes": {"A": "...", "B": "...", "C": "...", "D": "..."}}`;

    const response = await ai.models.generateContent({ model: "gemini-2.0-flash", contents: promptMaestro });
    return JSON.parse(response.text.replace(/```json|```/g, "").trim());
  } catch (e) { console.error("Error en IA:", e); return null; }
}

async function iniciarCicloTrivias() {
  if (!cicloActivo) return;
  const trivia = await obtenerContenidoYGenerarPregunta();
  if (!trivia) { setTimeout(iniciarCicloTrivias, 60000); return; }

  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
  if (canal?.isTextBased()) {
    await canal.send({ embeds: [new EmbedBuilder().setTitle("📝 Simulacro ICFES").setDescription(`**${trivia.pregunta}**\n\n${trivia.opciones.join("\n")}`).setColor("#3B82F6")] });
    await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], duration: 1 } });
  }
}

// --- 4. EVENTOS ---
client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;
  await i.deferReply({ flags: [MessageFlags.Ephemeral] });
  if (i.customId === "iniciar") { cicloActivo = true; iniciarCicloTrivias(); await i.editReply("⚡ Ciclo iniciado."); }
});

client.login(process.env["DISCORD_TOKEN"]);