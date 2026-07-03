import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import http from "http";

const server = http.createServer((req, res) => res.end("Bot activo"));
server.listen(process.env.PORT || 3000);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;
let datosTriviaActual: any = null;

// --- FUNCIÓN DE LIMPIEZA Y REINICIO DE PANEL ---
async function inicializarPanel() {
  const canal = await client.channels.fetch(process.env["CANAL_LOGS_ID"]!);
  if (!canal || !canal.isTextBased()) return;

  // 1. Borrar mensajes previos del panel para evitar botones muertos
  const mensajes = await canal.messages.fetch({ limit: 10 });
  const mensajesPanel = mensajes.filter(m => m.embeds[0]?.title === "⚡ Centro de Activación");
  for (const msg of mensajesPanel.values()) await msg.delete().catch(() => {});

  // 2. Crear panel nuevo
  const fila = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("iniciar").setLabel("🔌 Iniciar").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("pausar").setLabel("⏸️ Pausar").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("saltar").setLabel("⏭️ Saltar").setStyle(ButtonStyle.Danger)
  );

  await canal.send({
    embeds: [new EmbedBuilder().setTitle("⚡ Centro de Activación").setDescription("Controles remotos para simulacros ICFES.").setColor("#EAB308")],
    components: [fila]
  });
}

// ... (Resto de tus funciones: obtenerContenidoValido, enviarJustificacion, iniciarCicloTrivias) ...

// --- EVENTO READY ---
client.once("ready", () => {
  console.log("Bot listo. Limpiando panel antiguo...");
  inicializarPanel();
});

// --- EVENTO INTERACCIÓN (Botones) ---
client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;

  if (i.customId === "iniciar") {
    if (cicloActivo) return i.reply({ content: "ℹ️ Ya está activo.", ephemeral: true });
    cicloActivo = true;
    iniciarCicloTrivias();
    await i.reply({ content: "⚡ Ciclo iniciado.", ephemeral: true });
  } else if (i.customId === "pausar") {
    cicloActivo = false;
    await i.reply({ content: "⏸️ Ciclo pausado.", ephemeral: true });
  } else if (i.customId === "saltar") {
    if (!datosTriviaActual) return i.reply({ content: "⚠️ No hay pregunta activa.", ephemeral: true });
    enviarJustificacion();
    await i.reply({ content: "⏭️ Saltando...", ephemeral: true });
  }
});

client.login(process.env["DISCORD_TOKEN"]);