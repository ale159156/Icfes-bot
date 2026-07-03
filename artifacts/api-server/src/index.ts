import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import http from "http";

// --- PARTE 1: INFRAESTRUCTURA (Mantiene vivo el bot en Render) ---
const server = http.createServer((req, res) => res.end("Bot de estudio activo"));
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Servidor HTTP activo en puerto ${PORT}`));

// --- PARTE 2: INICIALIZACIÓN ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;
let datosTriviaActual: any = null;

// --- PARTE 3: LÓGICA DE NEGOCIO (IA + DRIVE) ---
async function obtenerContenidoYGenerarPregunta() {
  try {
    const res = await drive.files.list({ q: `'${process.env["DRIVE_FOLDER_ID"]}' in parents and trashed = false`, fields: "files(id, name)" });
    const archivos = (res.data.files || []).filter(f => f.name?.endsWith('.txt') || f.name?.endsWith('.pdf'));
    if (archivos.length === 0) return null;

    const arch = archivos[Math.floor(Math.random() * archivos.length)];
    const resCont = await drive.files.get({ fileId: arch.id!, alt: "media" }, { responseType: "text" });
    const texto = resCont.data.trim();

    // Filtro de calidad (Integrado del código que funcionaba + mejoras de filtrado)
    if (texto.length < 500 || texto.toLowerCase().includes("camscanner")) return null;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: `Eres un tutor experto ICFES. Crea UNA pregunta de opción múltiple basada en: ${texto.substring(0, 4000)}. 
      Responde SOLO JSON: {"pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "descartes": {"A": "...", "B": "...", "C": "...", "D": "..."}}`
    });

    return JSON.parse(response.text.replace(/```json|```/g, "").trim());
  } catch (e) { console.error("Error en Tutor IA:", e); return null; }
}

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
    let desc = "";
    ["A", "B", "C", "D"].forEach((l, i) => { if (i !== datosTriviaActual.correcta) desc += `❌ **${l}:** ${datosTriviaActual.descartes[l]}\n`; });
    await canal.send({ embeds: [new EmbedBuilder().setTitle("✅ Justificación").setDescription(`Correcta: **${datosTriviaActual.opciones[datosTriviaActual.correcta]}**\n\n🟢 **Justificación:**\n${datosTriviaActual.justificacion}\n\n🔍 **Descartes:**\n${desc}`).setColor("#10B981")] });
  }
  datosTriviaActual = null;
  if (cicloActivo) setTimeout(iniciarCicloTrivias, 120000); 
}

// --- PARTE 4: EVENTOS (Panel de control con limpieza) ---
client.once("clientReady", async () => {
  const canal = await client.channels.fetch(process.env["CANAL_LOGS_ID"]!);
  if (canal?.isTextBased()) {
    const msgs = await canal.messages.fetch({ limit: 5 });
    for (const msg of msgs.values()) if (msg.author.id === client.user?.id) await msg.delete().catch(() => {});

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
  if (i.customId === "iniciar") { cicloActivo = true; iniciarCicloTrivias(); await i.editReply("⚡ Ciclo iniciado."); }
  else if (i.customId === "pausar") { cicloActivo = false; await i.editReply("⏸️ Ciclo pausado."); }
});

client.login(process.env["DISCORD_TOKEN"]);