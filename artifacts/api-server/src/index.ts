import app from "./app";
import { logger } from "./lib/logger";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;
let datosTriviaActual: any = null;

async function obtenerContenidoValido(): Promise<{ textoContexto: string; materia: string }> {
  try {
    const resCarpetas = await drive.files.list({
      q: `'${process.env["DRIVE_FOLDER_ID"]}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
    });

    const carpetas = (resCarpetas.data.files || []).sort(() => 0.5 - Math.random());

    for (const carpeta of carpetas) {
      const resArchivos = await drive.files.list({
        q: `'${carpeta.id}' in parents and trashed = false and (mimeType = 'text/plain' or mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.document')`,
        fields: "files(id, name)",
      });

      const archivos = resArchivos.data.files || [];
      if (archivos.length > 0) {
        const archivo = archivos[Math.floor(Math.random() * archivos.length)];
        const resContenido = await drive.files.get({ fileId: archivo.id, alt: "media" }, { responseType: "text" });
        const texto = resContenido.data.trim();
        if (texto.length > 200) return { textoContexto: texto.substring(0, 4000), materia: carpeta.name || "Estudio" };
      }
    }
    return { textoContexto: "", materia: "" };
  } catch (e) { return { textoContexto: "", materia: "" }; }
}

async function inicializarPanelActivacion() {
  const canal = await client.channels.fetch(process.env["CANAL_LOGS_ID"] || "");
  if (!canal || !canal.isTextBased()) return;
  
  const mensajes = await canal.messages.fetch({ limit: 20 });
  const mensajesPanel = mensajes.filter(m => m.embeds[0]?.title?.includes("⚡ Centro de Activación"));
  for (const msg of mensajesPanel.values()) await msg.delete().catch(() => {});

  const fila = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("activar_ciclo_bot").setLabel("🔌 Iniciar").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("saltar_pregunta").setLabel("⏭️ Saltar y Nueva").setStyle(ButtonStyle.Danger)
  );
  
  await canal.send({ 
    embeds: [new EmbedBuilder().setTitle("⚡ Centro de Activación").setDescription("Controles remotos para simulacros ICFES.").setColor("#EAB308")], 
    components: [fila] 
  });
}

async function enviarJustificacion() {
  if (!datosTriviaActual) return;
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
  if (canal?.isTextBased()) {
    let desc = "";
    ["A", "B", "C", "D"].forEach((letra, index) => {
      if (index !== datosTriviaActual.correcta) desc += `❌ **${letra}:** ${datosTriviaActual.descartes[letra]}\n`;
    });
    await canal.send({ embeds: [new EmbedBuilder().setTitle("✅ Justificación").setDescription(`Correcta: **${datosTriviaActual.opciones[datosTriviaActual.correcta]}**\n\n🟢 **Justificación:**\n${datosTriviaActual.justificacion}\n\n🔍 **Descartes:**\n${desc}`).setColor("#10B981")] });
  }
  datosTriviaActual = null;
  if (cicloActivo) setTimeout(iniciarCicloTrivias, 120000);
}

async function iniciarCicloTrivias() {
  const { textoContexto, materia } = await obtenerContenidoValido();
  if (!textoContexto) { setTimeout(iniciarCicloTrivias, 10000); return; }

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Eres tutor experto ICFES. Crea una pregunta de opción múltiple del texto: [TEXTO]: ${textoContexto}. 
    Devuelve SOLO JSON: {"pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "descartes": {"A": "...", "B": "...", "C": "...", "D": "..."}}`,
  });

  datosTriviaActual = JSON.parse(response.text.replace(/```json|```/g, "").trim());
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
  if (canal?.isTextBased()) {
    await canal.send({ embeds: [new EmbedBuilder().setTitle(`📝 Simulacro [${materia}]`).setDescription(`**${datosTriviaActual.pregunta}**\n\n${datosTriviaActual.opciones.join("\n")}`).setColor("#3B82F6")] });
    await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], allowMultiselect: false, duration: 1 } });
    setTimeout(enviarJustificacion, 1800000); // 30 min
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === "activar_ciclo_bot") {
    if (cicloActivo) return interaction.reply({ content: "ℹ️ Ya activo.", ephemeral: true });
    cicloActivo = true;
    iniciarCicloTrivias();
    await interaction.reply({ content: "⚡ Ciclo iniciado.", ephemeral: true });
  } else if (interaction.customId === "saltar_pregunta") {
    if (!datosTriviaActual) return interaction.reply({ content: "⚠️ No hay pregunta.", ephemeral: true });
    enviarJustificacion();
    await interaction.reply({ content: "⏭️ Saltando...", ephemeral: true });
  }
});

client.once("ready", () => { inicializarPanelActivacion(); });
if (process.env["DISCORD_TOKEN"]) client.login(process.env["DISCORD_TOKEN"]);
