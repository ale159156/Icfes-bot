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
const CANAL_LOGS_ID = process.env["CANAL_LOGS_ID"];
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

async function enviarLog(mensaje: string) {
  try {
    if (!CANAL_LOGS_ID) return;
    const canal = await client.channels.fetch(CANAL_LOGS_ID);
    if (canal && canal.isTextBased()) await canal.send(mensaje);
  } catch (e) { console.error("Error enviando log:", e); }
}

async function obtenerContextoDesdeDrive(): Promise<{ textoContexto: string; materia: string }> {
  try {
    const resCarpetas = await drive.files.list({
      q: `'${DRIVE_FOLDER_ROOT_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
    });
    const carpetas = resCarpetas.data.files || [];
    if (carpetas.length === 0) return { textoContexto: "Material pendiente.", materia: "General" };
    
    const carpeta = carpetas[Math.floor(Math.random() * carpetas.length)];
    const resArchivos = await drive.files.list({
      q: `'${carpeta.id}' in parents and trashed = false and (mimeType = 'text/plain' or mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.document')`,
      fields: "files(id, name)",
    });
    const archivos = resArchivos.data.files || [];
    if (archivos.length === 0) return { textoContexto: "No hay archivos.", materia: carpeta.name || "General" };
    
    const archivo = archivos[Math.floor(Math.random() * archivos.length)];
    const resContenido = await drive.files.get({ fileId: archivo.id, alt: "media" }, { responseType: "text" });
    return { textoContexto: resContenido.data.substring(0, 4000), materia: carpeta.name || "General" };
  } catch (error) {
    return { textoContexto: "Error al leer Drive.", materia: "General" };
  }
}

async function inicializarPanelActivacion() {
  try {
    const canal = await client.channels.fetch(CANAL_LOGS_ID || "");
    if (!canal || !canal.isTextBased()) return;
    
    // Limpieza: borra mensajes antiguos para evitar botones muertos
    const mensajes = await canal.messages.fetch({ limit: 20 });
    const mensajesPanel = mensajes.filter(m => m.embeds[0]?.title?.includes("⚡ Centro de Activación"));
    for (const msg of mensajesPanel.values()) {
        await msg.delete().catch(() => {});
    }

    const fila = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("activar_ciclo_bot").setLabel("🔌 Iniciar").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("saltar_pregunta").setLabel("⏭️ Saltar y Nueva").setStyle(ButtonStyle.Danger)
    );
    
    await canal.send({ 
      embeds: [new EmbedBuilder()
        .setTitle("⚡ Centro de Activación")
        .setDescription("Controles remotos para tus simulacros ICFES.")
        .setColor("#EAB308")], 
      components: [fila] 
    });
  } catch (e) { console.error("Error al inicializar panel:", e); }
}

async function enviarJustificacion() {
  if (!datosTriviaActual) return;
  const canal = await client.channels.fetch(CANAL_ENCUESTAS_ID || "");
  if (!canal || !canal.isTextBased()) return;
  
  let desc = "";
  for (const [l, e] of Object.entries(datosTriviaActual.descartes)) desc += `❌ **${l}:** ${e}\n`;
  await canal.send({ embeds: [new EmbedBuilder().setTitle("✅ Justificación").setDescription(`Correcta: **${datosTriviaActual.opciones[datosTriviaActual.correcta]}**\n\n🟢 **Justificación:**\n${datosTriviaActual.justificacion}\n\n🔍 **Descartes:**\n${desc}`).setColor("#10B981")] });
  
  datosTriviaActual = null;
  if (cicloActivo) {
      enviarLog("⏳ Pausa de 2 min...");
      setTimeout(iniciarCicloTrivias, 2 * 60 * 1000); 
  }
}

async function iniciarCicloTrivias() {
  try {
    if (temporizadorCiclo) clearTimeout(temporizadorCiclo);
    const canal = await client.channels.fetch(CANAL_ENCUESTAS_ID || "");
    if (!canal || !canal.isTextBased()) return;

    const { textoContexto, materia } = await obtenerContextoDesdeDrive();
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Eres tutor ICFES. Extrae UNA pregunta de opción múltiple del texto:
      [TEXTO]: ${textoContexto}
      Devuelve SOLO JSON: {"pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "descartes": {"A": "...", "B": "...", "C": "...", "D": "..."}}`,
    });

    datosTriviaActual = JSON.parse(response.text.replace(/```json|```/g, "").trim());
    await canal.send({ embeds: [new EmbedBuilder().setTitle(`📝 Simulacro [${materia}]`).setDescription(`**${datosTriviaActual.pregunta}**\n\n${datosTriviaActual.opciones.join("\n")}`).setColor("#3B82F6")] });
    await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], allowMultiselect: false, duration: 1 } });

    temporizadorCiclo = setTimeout(enviarJustificacion, 30 * 60 * 1000);
  } catch (e) {
    enviarLog("❌ Error: " + e);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === "activar_ciclo_bot") {
    if (cicloActivo) return interaction.reply({ content: "ℹ️ Ya activo.", ephemeral: true });
    cicloActivo = true;
    await interaction.reply({ content: "⚡ Ciclo iniciado.", ephemeral: true });
    iniciarCicloTrivias();
  } else if (interaction.customId === "saltar_pregunta") {
    if (!datosTriviaActual) return interaction.reply({ content: "⚠️ No hay pregunta activa.", ephemeral: true });
    await enviarJustificacion();
    await interaction.reply({ content: "⏭️ Pregunta saltada.", ephemeral: true });
  }
});

client.once("ready", () => { inicializarPanelActivacion(); });
if (DISCORD_TOKEN) client.login(DISCORD_TOKEN);
