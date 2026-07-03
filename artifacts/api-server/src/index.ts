import app from "./app";
import { logger } from "./lib/logger";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required.");
const port = Number(rawPort);

const DISCORD_TOKEN = process.env["DISCORD_TOKEN"];
const GEMINI_API_KEY = process.env["GEMINI_API_KEY"];
const CANAL_ENCUESTAS_ID = process.env["CANAL_ID"];
const CANAL_LOGS_ID = process.env["CANAL_LOGS_ID"]; // Canal para notificaciones técnicas
const DRIVE_API_KEY = process.env["DRIVE_API_KEY"];
const DRIVE_FOLDER_ROOT_ID = process.env["DRIVE_FOLDER_ID"];

app.listen(port, (err) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
  logger.info({ port }, "Server listening");
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const drive = google.drive({ version: "v3", auth: DRIVE_API_KEY });

let cicloActivo = false;
let temporizadorCiclo: NodeJS.Timeout | null = null;
let datosTriviaActual: any = null;

// Función para enviar logs a un canal dedicado
async function enviarLog(mensaje: string) {
  try {
    if (!CANAL_LOGS_ID) return;
    const canal = await client.channels.fetch(CANAL_LOGS_ID);
    if (canal && canal.isTextBased()) await canal.send(mensaje);
  } catch (e) { console.error("Error enviando log:", e); }
}

async function obtenerContextoDesdeDrive(): Promise<{ textoContexto: string; materia: string }> {
  try {
    const resCategorias = await drive.files.list({
      q: `'${DRIVE_FOLDER_ROOT_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
    });

    const carpetas = resCategorias.data.files || [];
    if (carpetas.length === 0) return { textoContexto: "", materia: "General" };

    const carpetaSeleccionada = carpetas[Math.floor(Math.random() * carpetas.length)];
    const materia = carpetaSeleccionada.name || "General";

    const resArchivos = await drive.files.list({
      q: `'${carpetaSeleccionada.id}' in parents and trashed = false and (mimeType = 'text/plain' or mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.document')`,
      fields: "files(id, name, mimeType)",
      limit: 10,
    });

    const archivos = resArchivos.data.files || [];
    if (archivos.length === 0) return { textoContexto: "", materia };

    const archivoElegido = archivos[Math.floor(Math.random() * archivos.length)];
    const resContenido = await drive.files.get({ fileId: archivoElegido.id, alt: "media" }, { responseType: "text" });

    const textoContexto = typeof resContenido.data === "string" ? resContenido.data.substring(0, 4000) : ""; 
    return { textoContexto, materia };
  } catch (error) {
    enviarLog("❌ Error accediendo a Drive.");
    return { textoContexto: "", materia: "General" };
  }
}

async function iniciarCicloTrivias() {
  try {
    const canal = await client.channels.fetch(CANAL_ENCUESTAS_ID || "");
    if (!canal || !canal.isTextBased()) return;

    const { textoContexto, materia } = await obtenerContextoDesdeDrive();

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Eres un extractor experto. Extrae una pregunta de opción múltiple del texto.
      [TEXTO]: ${textoContexto || "Genera una pregunta estándar."}
      Devuelve JSON: {"pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "descartes": {"A": "...", "B": "...", "C": "...", "D": "..."}}`,
    });

    datosTriviaActual = JSON.parse(response.text.replace(/```json|```/g, "").trim());
    
    await canal.send({ embeds: [new EmbedBuilder().setTitle(`📝 Simulacro [${materia}]`).setDescription(`**${datosTriviaActual.pregunta}**\n\n${datosTriviaActual.opciones.join("\n")}`).setColor("#3B82F6")] });
    await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], allowMultiselect: false, duration: 1 } });

    enviarLog(`✅ Pregunta enviada en ${materia}. Justificación programada en 30 min.`);

    temporizadorCiclo = setTimeout(async () => {
      let desc = "";
      for (const [l, e] of Object.entries(datosTriviaActual.descartes)) desc += `❌ **${l}:** ${e}\n`;
      await canal.send({ embeds: [new EmbedBuilder().setTitle("✅ Justificación General").setDescription(`Correcta: **${datosTriviaActual.opciones[datosTriviaActual.correcta]}**\n\n🟢 **Justificación:**\n${datosTriviaActual.justificacion}\n\n🔍 **Descartes:**\n${desc}`).setColor("#10B981")] });
      
      if (cicloActivo) setTimeout(iniciarCicloTrivias, 5000);
    }, 30 * 60 * 1000);

  } catch (e) {
    enviarLog("❌ Error en el ciclo: " + e);
    if (cicloActivo) temporizadorCiclo = setTimeout(iniciarCicloTrivias, 60000);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === "activar_ciclo_bot") {
    cicloActivo = true;
    await interaction.reply({ content: "⚡ Ciclo iniciado.", ephemeral: true });
    enviarLog("🔌 Ciclo de estudio activado por usuario.");
    iniciarCicloTrivias();
  }
});

client.once("ready", () => { 
  enviarLog("🤖 Bot conectado y operativo."); 
});

if (DISCORD_TOKEN) client.login(DISCORD_TOKEN);
