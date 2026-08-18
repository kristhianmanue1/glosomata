const form = document.querySelector("#message-form");
const messageInput = document.querySelector("#message");
const recordButton = document.querySelector("#speak");
const stopButton = document.querySelector("#stop");
const listenButton = document.querySelector("#listen");
const statusNode = document.querySelector("#status");
const responseCard = document.querySelector("#response-card");
const responseText = document.querySelector("#response-text");
const agentLabel = document.querySelector("#agent-label");

let stream;
let audioContext;
let inputNode;
let processor;
let recordedChannels = [];
let recording = false;
let currentAudio;
let requestId = 0;

function setStatus(text, kind = "info") {
  statusNode.textContent = text;
  statusNode.dataset.kind = kind;
}

function stopEverything() {
  ++requestId;
  recording = false;
  processor?.disconnect();
  inputNode?.disconnect();
  audioContext?.close();
  processor = undefined;
  inputNode = undefined;
  audioContext = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  currentAudio?.pause();
  currentAudio = undefined;
  stopButton.disabled = true;
}

function wavFromChannels(channels, sampleRate) {
  const frames = channels.reduce((sum, channel) => sum + channel.length, 0);
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const write = (offset, value) => view.setUint32(offset, value, true);
  view.setUint32(0, 0x46464952, false); write(4, 36 + frames * 2);
  view.setUint32(8, 0x45564157, false); view.setUint32(12, 0x20746d66, false);
  write(16, 16); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  write(24, sampleRate); write(28, sampleRate * 2); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); view.setUint32(36, 0x61746164, false);
  write(40, frames * 2);
  let offset = 44;
  for (const channel of channels) {
    for (const sample of channel) {
      view.setInt16(offset, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Servicio local no disponible.");
  return data;
}

async function synthesizeAndPlay(reply, ownRequest) {
  setStatus("Kokoro está generando la respuesta.");
  const response = await fetch("/api/synthesize", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: reply })
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.message || "La voz local no está disponible.");
  }
  if (ownRequest !== requestId) return;
  currentAudio = new Audio(URL.createObjectURL(await response.blob()));
  stopButton.disabled = false;
  currentAudio.onended = () => {
    stopButton.disabled = true;
    setStatus("Respuesta terminada.");
  };
  await currentAudio.play();
  setStatus("El agente está hablando.");
}

async function sendMessage(message, ownRequest = ++requestId) {
  recordButton.disabled = true;
  try {
    setStatus("Ollama está preparando una respuesta.");
    const payload = await postJson("/api/respond", { message });
    if (ownRequest !== requestId) return;
    responseText.textContent = payload.reply;
    agentLabel.textContent = `Agente: ${payload.agent}`;
    responseCard.hidden = false;
    listenButton.onclick = () => synthesizeAndPlay(payload.reply, ++requestId).catch(showError);
    await synthesizeAndPlay(payload.reply, ownRequest);
  } catch (error) {
    if (ownRequest === requestId) showError(error);
  } finally {
    if (ownRequest === requestId) recordButton.disabled = false;
  }
}

function showError(error) {
  setStatus(error.message || "No se completó el turno local.", "error");
}

async function transcribe(blob, ownRequest) {
  setStatus("Whisper está transcribiendo localmente.");
  const response = await fetch("/api/transcribe", {
    method: "POST", headers: { "content-type": "audio/wav" }, body: blob
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "La transcripción local no está disponible.");
  if (ownRequest !== requestId) return;
  messageInput.value = payload.text;
  await sendMessage(payload.text, ownRequest);
}

async function startRecording() {
  stopEverything();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();
    inputNode = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    recordedChannels = [];
    processor.onaudioprocess = (event) => {
      if (recording) recordedChannels.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    inputNode.connect(processor);
    processor.connect(audioContext.destination);
    recording = true;
    recordButton.disabled = true;
    stopButton.disabled = false;
    setStatus("Grabando. Pulse Cancelar audio cuando termine de hablar.");
  } catch {
    setStatus("No se pudo abrir el micrófono. Puede escribir su mensaje.", "error");
  }
}

recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", () => {
  if (recording) {
    setStatus("Cerrando la grabación.");
    recording = false;
    const blob = wavFromChannels(recordedChannels, audioContext.sampleRate);
    processor?.disconnect();
    inputNode?.disconnect();
    audioContext?.close();
    processor = undefined;
    inputNode = undefined;
    audioContext = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    stopButton.disabled = true;
    recordButton.disabled = false;
    if (blob.size > 44) transcribe(blob, ++requestId).catch(showError);
  } else if (currentAudio) {
    stopEverything();
    setStatus("Reproducción cancelada.");
  }
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  stopEverything();
  const message = messageInput.value.trim();
  if (!message) return showError(new Error("Escriba un mensaje antes de enviarlo."));
  sendMessage(message);
});
window.addEventListener("beforeunload", stopEverything);
agentLabel.textContent = "Agente: Ollama local";
