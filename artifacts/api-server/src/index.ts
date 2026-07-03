import app from "./app";
import { logger } from "./lib/logger";
import { Client, GatewayIntentBits, EmbedBuilder, ButtonStyle, ActionRowBuilder, ButtonBuilder, MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

// --- 1. INICIALIZACIÓN DEL BOT ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;
let datosTriviaActual: any = null;

// --- 2. LÓGICA DE IA (Prompt Maestro) ---
async function obtenerContenidoYGenerarPregunta() {
  try {
    const res = await drive.files.list({ q: `'${process.env["DRIVE_FOLDER_ID"]}' in parents and trashed = false`, fields: "files(id, name)" });
    const archivos = (res.data.files || []).filter(f => f.name?.endsWith('.txt') || f.name?.endsWith('.pdf'));
    if (archivos.length === 0) return null;

    const arch = archivos[Math.floor(Math.random() * archivos.length)];
    const resCont = await drive.files.get({ fileId: arch.id!, alt: "media" }, { responseType: "text" });
    const texto = resCont.data.trim();

    if (texto.length < 500) return null;

    const prompt = `Eres experto ICFES. Crea UNA pregunta de selección múltiple basada en: "${texto.substring(0, 3000)}".
    Devuelve SOLO JSON: {"pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "descartes": {"A": "...", "B": "...", "C": "...", "D": "..."}}`;

    const response = await ai.models.generateContent({ model: "gemini-2.0-flash", contents: prompt });
    return JSON.parse(response.text.replace(/```json|```/g, "").trim());
  } catch (e) { return null; }
}

// --- 3. CICLO DE PREGUNTAS Y AUTO-JUSTIFICACIÓN ---
async function iniciarCicloTrivias() {
  if (!cicloActivo) return;
  const trivia = await obtenerContenidoYGenerarPregunta();
  if (!trivia) { setTimeout(iniciarCicloTrivias, 60000); return; }

  datosTriviaActual = trivia;
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
  if (canal?.isTextBased()) {
    await canal.send({ embeds: [new EmbedBuilder().setTitle("📝 Simulacro ICFES").setDescription(`**${trivia.pregunta}**\n\n${trivia.opciones.join("\n")}`).setColor("#3B82F6")] });
    await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], duration: 1 } });
    setTimeout(enviarJustificacion, 1800000); // 30 min
  }
}

async function enviarJustificacion() {
  if (!datosTriviaActual) return;
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
  if (canal?.isTextBased()) {
    let desc = Object.entries(datosTriviaActual.descartes).map(([k, v]) => `❌ **${k}:** ${v}`).join("\n");
    await canal.send({ embeds: [new EmbedBuilder().setTitle("✅ Justificación").setDescription(`Correcta: **${datosTriviaActual.opciones[datosTriviaActual.correcta]}**\n\n🟢 **Justificación:**\n${datosTriviaActual.justificacion}\n\n🔍 **Descartes:**\n${desc}`).setColor("#10B981")] });
  }
  datosTriviaActual = null;
  if (cicloActivo) setTimeout(iniciarCicloTrivias, 120000);
}

// --- 4. EVENTOS (VERIFICACIÓN) ---
client.once("clientReady", async () => {
  logger.info("Bot conectado. Intentando enviar panel de botones...");
  try {
    const canal = await client.channels.fetch(process.env["CANAL_LOGS_ID"]!);
    if (!canal) {
      logger.error("No se pudo encontrar el canal con ID: " + process.env["CANAL_LOGS_ID"]);
      return;
    }

    if (canal.isTextBased()) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("iniciar").setLabel("Iniciar").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("pausar").setLabel("Pausar").setStyle(ButtonStyle.Secondary)
      );

      await canal.send({ 
        embeds: [new EmbedBuilder().setTitle("⚡ Centro de Activación").setDescription("Bot listo. Presiona un botón para comenzar.")], 
        components: [row] 
      });
      logger.info("Panel de botones enviado exitosamente.");
    }
  } catch (err) {
    logger.error({ err }, "Error al enviar botones al canal de logs");
  }
});
client.login(process.env["DISCORD_TOKEN"]);

// --- 5. ARRANQUE DEL SERVIDOR EXPRESS ---
const port = Number(process.env["PORT"] || 10000);
app.listen(port, () => logger.info({ port }, "Servidor Express y Bot de Discord activos"));