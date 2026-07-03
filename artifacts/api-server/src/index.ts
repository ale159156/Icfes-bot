import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import http from "http";

const server = http.createServer((req, res) => res.end("Bot de estudio activo"));
server.listen(process.env.PORT || 3000);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;
let datosTriviaActual: any = null;
let temporizadorPregunta: NodeJS.Timeout | null = null;

// --- PROMPT DE TUTOR ICFES (El mismo que utilizo yo) ---
const PROMPT_TUTOR = `Eres un tutor experto del ICFES. Tu objetivo es ayudar al estudiante a preparar el examen con preguntas estrictamente basadas en el texto proporcionado.
REGLAS:
1. No inventes información. Si la respuesta no está en el texto, no generes la pregunta.
2. Analiza el texto y extrae el enunciado completo.
3. Debes proporcionar 4 opciones (A, B, C, D) donde solo una es la correcta según el contexto.
4. Tu justificación debe ser pedagógica, profunda y basada en la evidencia del texto.
5. Los descartes deben explicar claramente por qué las opciones erróneas son incorrectas o no se derivan del texto.
6. Devuelve el JSON con la estructura: {"pregunta": "Enunciado completo...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "descartes": {"A": "...", "B": "...", "C": "...", "D": "..."}}`;

async function obtenerContenidoValido(): Promise<{ texto: string; materia: string }> {
  try {
    const res = await drive.files.list({ q: `'${process.env["DRIVE_FOLDER_ID"]}' in parents and trashed = false`, fields: "files(id, name)" });
    const archivos = (res.data.files || []).filter(f => f.name?.endsWith('.txt') || f.name?.endsWith('.pdf'));
    if (archivos.length === 0) return { texto: "", materia: "" };
    const arch = archivos[Math.floor(Math.random() * archivos.length)];
    const resCont = await drive.files.get({ fileId: arch.id!, alt: "media" }, { responseType: "text" });
    return { texto: resContContenido.data.slice(0, 4500), materia: arch.name! };
  } catch { return { texto: "", materia: "" }; }
}

async function enviarJustificacion() {
  if (!datosTriviaActual) return;
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
  if (canal?.isTextBased()) {
    let desc = "";
    ["A", "B", "C", "D"].forEach((l, i) => { if (i !== datosTriviaActual.correcta) desc += `❌ **${l}:** ${datosTriviaActual.descartes[l]}\n`; });
    await canal.send({ embeds: [new EmbedBuilder().setTitle("✅ Justificación").setDescription(`Correcta: **${datosTriviaActual.opciones[datosTriviaActual.correcta]}**\n\n🟢 **Justificación:**\n${datosTriviaActual.justificacion}\n\n🔍 **Descartes:**\n${desc}`).setColor("#10B981")] });
  }
  if (cicloActivo) temporizadorPregunta = setTimeout(iniciarCicloTrivias, 30 * 60 * 1000);
}

async function iniciarCicloTrivias() {
  const { texto, materia } = await obtenerContenidoValido();
  if (!texto || texto.length < 300) { setTimeout(iniciarCicloTrivias, 60000); return; }

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `${PROMPT_TUTOR}\n\nTEXTO BASE:\n${texto}`
  });

  try {
    datosTriviaActual = JSON.parse(response.text.replace(/```json|```/g, "").trim());
    const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
    if (canal?.isTextBased()) {
      await canal.send(`@everyone ¡Nueva pregunta de simulacro! [${materia}]`);
      await canal.send({ embeds: [new EmbedBuilder().setTitle("📝 Simulacro ICFES").setDescription(`**${datosTriviaActual.pregunta}**\n\n${datosTriviaActual.opciones.join("\n")}`).setColor("#3B82F6")] });
      await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], duration: 1 } });
    }
  } catch { setTimeout(iniciarCicloTrivias, 60000); }
}

client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;
  if (i.customId === "iniciar") {
    cicloActivo = true;
    iniciarCicloTrivias();
    await i.reply({ content: "⚡ Bot activado. Ciclos cada 30min.", ephemeral: true });
  } else if (i.customId === "pausar") {
    cicloActivo = false;
    if (temporizadorPregunta) clearTimeout(temporizadorPregunta);
    await i.reply({ content: "⏸️ Ciclo pausado. Presiona 'Iniciar' para reanudar.", ephemeral: true });
  }
});

client.once("ready", () => {
  // Aquí iría la lógica de inicializarPanelActivacion con los botones ["iniciar", "pausar"]
  console.log("Bot listo");
});

client.login(process.env["DISCORD_TOKEN"]);