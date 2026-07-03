import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import http from "http";

// --- INFRAESTRUCTURA ---
const server = http.createServer((req, res) => res.end("Bot activo"));
server.listen(process.env.PORT || 10000, '0.0.0.0');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;

// --- FUNCIONES ---
async function obtenerContenidoValido() {
  const res = await drive.files.list({ q: `'${process.env["DRIVE_FOLDER_ID"]}' in parents and trashed = false`, fields: "files(id, name)" });
  const archivos = res.data.files;
  if (!archivos || archivos.length === 0) return { texto: "", materia: "" };

  const arch = archivos[Math.floor(Math.random() * archivos.length)];
  const resCont = await drive.files.get({ fileId: arch.id!, alt: "media" }, { responseType: "text" });
  const texto = resCont.data;

  // Filtro de calidad para no procesar basura
  if (texto.length < 500 || texto.toLowerCase().includes("camscanner")) return { texto: "", materia: "" };
  return { texto: texto, materia: arch.name! };
}

async function iniciarCicloTrivias() {
  if (!cicloActivo) return;
  const { texto, materia } = await obtenerContenidoValido();
  if (!texto) { setTimeout(iniciarCicloTrivias, 60000); return; }

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: `Eres un tutor experto ICFES. Crea una pregunta de opción múltiple basada en: ${texto.substring(0, 3000)}. Devuelve SOLO JSON: {"pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "..."}`
  });

  const data = JSON.parse(response.text.replace(/```json|```/g, "").trim());
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
  if (canal?.isTextBased()) {
    await canal.send(`@everyone ¡Nueva pregunta! [${materia}]`);
    await canal.send({ embeds: [new EmbedBuilder().setTitle("Simulacro").setDescription(`${data.pregunta}\n\n${data.opciones.join("\n")}`).setColor("#3B82F6")] });
    await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], duration: 1 } });
  }
}

// --- EVENTOS ---
client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;
  await i.deferReply({ flags: [MessageFlags.Ephemeral] });

  if (i.customId === "iniciar") {
    cicloActivo = true;
    iniciarCicloTrivias();
    await i.editReply("⚡ Ciclo iniciado.");
  } else if (i.customId === "pausar") {
    cicloActivo = false;
    await i.editReply("⏸️ Ciclo pausado.");
  }
});

client.login(process.env["DISCORD_TOKEN"]);