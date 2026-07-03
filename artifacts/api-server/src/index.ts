import app from "./app";
import { logger } from "./lib/logger";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

// --- 1. CONFIGURACIÓN ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;
let datosTriviaActual: any = null;

// --- 2. FUNCIONES LÓGICAS ---
async function obtenerContenidoYGenerarPregunta() {
  try {
    const res = await drive.files.list({ q: `'${process.env["DRIVE_FOLDER_ID"]}' in parents and trashed = false`, fields: "files(id, name)" });
    const archivos = (res.data.files || []).filter(f => f.name?.endsWith('.txt') || f.name?.endsWith('.pdf'));
    if (archivos.length === 0) {
      console.error("DEBUG ERROR: No se encontraron archivos en la carpeta de Drive.");
      return null;
    }

    const arch = archivos[Math.floor(Math.random() * archivos.length)];
    const resCont = await drive.files.get({ fileId: arch.id!, alt: "media" }, { responseType: "text" });
    const texto = resCont.data.trim();
    if (texto.length < 50) {
      console.error("DEBUG ERROR: El archivo está vacío o tiene muy poco texto.");
      return null;
    }

    const prompt = `Eres experto ICFES. Crea UNA pregunta basada en: "${texto.substring(0, 3000)}". Devuelve SOLO JSON: {"pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "descartes": {"A": "...", "B": "...", "C": "...", "D": "..."}}`;

    // Cambiamos a 'gemini-2.5-flash' que es el modelo activo y recomendado en 2026
    const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt });

    const textoRespuesta = response.text.replace(/```json|```/g, "").trim();
    return JSON.parse(textoRespuesta);
  } catch (e) { 
    // Aquí es donde capturamos y mostramos el error real en los logs de Render
    console.error("DEBUG: Error detallado de IA:", e);
    return null; 
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

async function iniciarCicloTrivias() {
  console.log("DEBUG: Iniciando ciclo de trivia..."); // <--- ESTO SALDRÁ EN RENDER

  if (!cicloActivo) {
    console.log("DEBUG: Ciclo detenido, cancelando...");
    return;
  }

  const trivia = await obtenerContenidoYGenerarPregunta();
  if (!trivia) {
    console.log("DEBUG: Error al generar trivia con IA.");
    setTimeout(iniciarCicloTrivias, 60000); 
    return;
  }

  console.log("DEBUG: Trivia generada. Buscando canal ID:", process.env["CANAL_ID"]);

  datosTriviaActual = trivia;
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);

  if (canal?.isTextBased()) {
    console.log("DEBUG: Canal encontrado, enviando mensaje...");
    await canal.send({ embeds: [new EmbedBuilder().setTitle("📝 Simulacro ICFES").setDescription(`**${trivia.pregunta}**\n\n${trivia.opciones.join("\n")}`).setColor("#3B82F6")] });
    await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], duration: 1 } });
    setTimeout(enviarJustificacion, 1800000);
    console.log("DEBUG: Mensaje enviado con éxito.");
  } else {
    console.log("DEBUG: ERROR CRÍTICO: No se pudo enviar mensaje. ¿Tiene el bot permiso para escribir en ese canal?");
  }
}

// --- 3. EVENTOS ---
client.once("clientReady", async () => {
  logger.info("Bot conectado.");
  logger.info("--- VERSIÓN DEL BOT: 2026-07-03 ---");
  const canal = await client.channels.fetch(process.env["CANAL_LOGS_ID"]!);
  if (canal?.isTextBased()) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("iniciar").setLabel("Iniciar").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("pausar").setLabel("Pausar").setStyle(ButtonStyle.Secondary)
    );
    await canal.send({ embeds: [new EmbedBuilder().setTitle("⚡ Centro de Activación")], components: [row] });
  }
});

client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;
  await i.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    if (i.customId === "iniciar") {
      cicloActivo = true;
      await i.editReply("⚡ Ciclo iniciado.");
      iniciarCicloTrivias();
    } else if (i.customId === "pausar") {
      cicloActivo = false;
      await i.editReply("⏸️ Ciclo pausado.");
    }
  } catch (e) { await i.editReply("❌ Error."); }
});

client.login(process.env["DISCORD_TOKEN"]);

// --- 4. EXPRESS ---
const port = Number(process.env["PORT"] || 10000);
app.listen(port, () => logger.info({ port }, "Servidor y Bot activos"));